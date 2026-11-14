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
import { dayRange, EDITABLE_STATUSES } from "./rules";
import { CalendarError, listProjectMatchers } from "./service";
import { applyOccurrence, type ApplyContext } from "./upsert";

// Agenda do dia enviada por um assistente externo (Aurora, a partir do Outlook), em nome do dono do agente.
// Idempotente: reenviar o mesmo dia não duplica nem desfaz escolhas do usuário na reunião.

const DEFAULT_DURATION_MS = 30 * 60_000;
const NO_LINK = { url: null, platform: "none" as Platform };

// Só estas reuniões podem ser canceladas por sumir da lista: nada em andamento, gravado ou já cancelado.
const REMOVABLE_STATUSES = EDITABLE_STATUSES.filter((s) => s !== "cancelled");

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
    // Cada ocorrência (inclusive de série) chega como evento próprio: uid + início é a identidade.
    recurrenceKey: start.toISOString(),
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

function insideDay(o: Occurrence, range: { start: Date; end: Date }): boolean {
  return o.start >= range.start && o.start < range.end;
}

function occurrencesFromEvents(events: AgentCalendarEvent[], range: { start: Date; end: Date }): Occurrence[] {
  return events.map((event, index) => {
    const o = eventToOccurrence(event);
    if (!insideDay(o, range)) throw new CalendarError(`events.${index}: início fora da data informada.`);
    return o;
  });
}

function occurrencesFromIcs(
  text: string,
  range: { start: Date; end: Date },
  result: AgentCalendarImportResult,
): Occurrence[] {
  let parsed;
  try {
    parsed = parseIcs(text, { from: range.start, to: range.end });
  } catch (err) {
    throw new CalendarError((err as Error).message);
  }
  // Cancelar a série inteira ou mexer em outro dia está fora do escopo de um envio diário.
  const inDay = parsed.occurrences.filter((o) => !o.cancelsSeries && insideDay(o, range));
  result.ignored += parsed.ignored + parsed.occurrences.length - inDay.length;
  result.partialSeries = parsed.partialSeries.slice(0, 10);
  return inDay;
}

async function cancelMissing(
  client: PoolClient,
  userId: string,
  source: string,
  range: { start: Date; end: Date },
  seen: Set<string>,
): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'cancelled', import_removed_at = now()
     WHERE created_by = $1 AND import_source = $2
       AND scheduled_start >= $3 AND scheduled_start < $4
       AND status = ANY($5) AND id <> ALL($6::uuid[])
     RETURNING id`,
    [userId, source, range.start, range.end, REMOVABLE_STATUSES, [...seen]],
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
  };
  const occurrences = input.events
    ? occurrencesFromEvents(input.events, range)
    : occurrencesFromIcs(input.ics ?? "", range, result);

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
  };
  await withTransaction(async (client) => {
    for (const o of occurrences) await applyOccurrence(client, o, ctx);
    const removed = await cancelMissing(client, ownerId, input.source, range, seen);
    result.removed = removed.length;
    removed.forEach((id) => touched.add(id));
  });

  touched.forEach(emitMeetingChanged);
  return result;
}
