import type { PoolClient } from "pg";
import type {
  AgentCalendarEvent,
  AgentCalendarImportInput,
  AgentCalendarImportResult,
  Platform,
} from "@meeting-bot/contracts";
import { config } from "../config";
import { emitMeetingChanged, withTransaction } from "../db";
import { detectMeetingUrl, parseIcs, type Occurrence } from "./ics";
import { pairReschedules } from "./reschedule";
import { dayRange } from "./rules";
import { CalendarError, listProjectMatchers } from "./service";
import { applyOccurrence, type ApplyContext } from "./upsert";

// Agenda do dia enviada por um assistente externo (Aurora, a partir do Outlook), em nome do dono do agente.
// Idempotente: reenviar o mesmo dia não duplica nem desfaz escolhas do usuário na reunião.

const DEFAULT_DURATION_MS = 30 * 60_000;
const NO_LINK = { url: null, platform: "none" as Platform };

const MAX_IGNORED_LISTED = 20;
export const INVALID_ICS_MESSAGE = "Arquivo .ics inválido.";

// Só estas reuniões podem ser canceladas por sumir da lista, e só se ainda não começaram: nada passado,
// em andamento, gravado, já cancelado ou perdido (missed) é tocado.
const REMOVABLE_STATUSES = ["scheduled", "skipped"];

type DayRange = { start: Date; end: Date };
interface Parsed {
  occurrences: Occurrence[];
  /** uids de eventos enviados e não aplicados: nunca causam remoção de linhas com o mesmo uid */
  ignoredUids: Set<string>;
}

function meetingLink(event: AgentCalendarEvent): { url: string | null; platform: Platform } {
  const found = detectMeetingUrl(event.teams, event.location);
  if (found) return found;
  const raw = event.teams?.trim();
  if (!raw) return NO_LINK;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? { url: parsed.toString(), platform: "other" } : NO_LINK;
  } catch {
    return NO_LINK;
  }
}

export function eventToOccurrence(event: AgentCalendarEvent): Occurrence {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const link = meetingLink(event);
  return {
    uid: event.uid,
    // Evento único usa chave vazia (igual ao .ics); ocorrência de série chega como evento próprio e usa o início.
    recurrenceKey: event.recurring ? start.toISOString() : "",
    sequence: 0,
    title: event.title || "Reunião sem título",
    start,
    end: end > start ? end : new Date(start.getTime() + DEFAULT_DURATION_MS),
    organizer: event.organizer?.trim() || null,
    attendees: [],
    description: null,
    location: event.location?.trim() || null,
    url: link.url,
    platform: link.platform,
    cancelled: /^cancell?ed$/i.test(event.status ?? ""),
    cancelsSeries: false,
  };
}

function insideDay(o: Occurrence, range: DayRange): boolean {
  return o.start >= range.start && o.start < range.end;
}

function listIgnored(result: AgentCalendarImportResult, uid: string): void {
  if (result.ignoredEvents.length < MAX_IGNORED_LISTED) result.ignoredEvents.push({ uid, reason: "outside_date" });
}

function occurrencesFromEvents(events: AgentCalendarEvent[], range: DayRange, result: AgentCalendarImportResult): Parsed {
  const occurrences: Occurrence[] = [];
  const ignoredUids = new Set<string>();
  for (const event of events) {
    const o = eventToOccurrence(event);
    if (insideDay(o, range)) {
      occurrences.push(o);
    } else {
      // Fuso errado ou dia trocado: segue com os demais e não cancela o que já existe com esse uid.
      result.ignored++;
      listIgnored(result, o.uid);
      ignoredUids.add(o.uid);
    }
  }
  return { occurrences, ignoredUids };
}

function occurrencesFromIcs(text: string, range: DayRange, result: AgentCalendarImportResult): Parsed {
  let parsed;
  try {
    parsed = parseIcs(text, { from: range.start, to: range.end });
  } catch {
    // Mensagem fixa: o texto do erro do parser pode ecoar trechos do arquivo.
    throw new CalendarError(INVALID_ICS_MESSAGE);
  }
  // Cancelar a série inteira ou mexer em outro dia está fora do escopo de um envio diário.
  const occurrences = parsed.occurrences.filter((o) => !o.cancelsSeries && insideDay(o, range));
  const ignoredUids = new Set(parsed.occurrences.filter((o) => !occurrences.includes(o)).map((o) => o.uid));
  result.ignored += parsed.ignored + parsed.occurrences.length - occurrences.length;
  ignoredUids.forEach((uid) => listIgnored(result, uid));
  result.partialSeries = parsed.partialSeries.slice(0, 10);
  return { occurrences, ignoredUids };
}

async function cancelMissing(
  client: PoolClient,
  userId: string,
  source: string,
  range: DayRange,
  seen: Set<string>,
  keepUids: Set<string>,
): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'cancelled', import_removed_at = now()
     WHERE created_by = $1 AND import_source = $2
       AND scheduled_start >= $3 AND scheduled_start < $4 AND scheduled_start > now()
       AND status = ANY($5) AND id <> ALL($6::uuid[]) AND ical_uid <> ALL($7::text[])
     RETURNING id`,
    [userId, source, range.start, range.end, REMOVABLE_STATUSES, [...seen], [...keepUids]],
  );
  return rows.map((r) => r.id);
}

export async function importAgentCalendar(
  input: AgentCalendarImportInput,
  ownerId: string,
): Promise<AgentCalendarImportResult> {
  const range = dayRange(input.date, config.appTimezone);
  const result: AgentCalendarImportResult = {
    source: input.source, date: input.date,
    created: 0, updated: 0, cancelled: 0, removed: 0, unchanged: 0, ignored: 0, partialSeries: [], errors: [],
    ignoredEvents: [],
  };
  const { occurrences, ignoredUids } = input.events
    ? occurrencesFromEvents(input.events, range, result)
    : occurrencesFromIcs(input.ics ?? "", range, result);

  // Lista vazia pode ser falha da origem: só apaga o dia com confirmação explícita.
  const emptyList = occurrences.length === 0 && ignoredUids.size === 0;
  const skipRemoval = emptyList && input.confirmEmpty !== true;
  if (skipRemoval) result.removalSkipped = "empty_without_confirm";

  const touched = new Set<string>();
  const seen = new Set<string>();
  const ctx: ApplyContext = {
    userId: ownerId,
    projects: await listProjectMatchers(),
    now: Date.now(),
    result,
    touched,
    importSource: input.source,
    seen,
    window: range,
  };
  await withTransaction(async (client) => {
    // Dois envios simultâneos do mesmo dono, origem e dia esperam um ao outro: sem isso ambos tentam criar a mesma
    // linha e um deles quebra no índice único (created_by, ical_uid, recurrence_key).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `agent-calendar:${ownerId}:${input.source}:${input.date}`,
    ]);
    await pairReschedules(client, ownerId, input.source, range, REMOVABLE_STATUSES, occurrences);
    for (const o of occurrences) await applyOccurrence(client, o, ctx);
    if (skipRemoval) return;
    const removed = await cancelMissing(client, ownerId, input.source, range, seen, ignoredUids);
    result.removed = removed.length;
    removed.forEach((id) => touched.add(id));
  });

  touched.forEach(emitMeetingChanged);
  return result;
}
