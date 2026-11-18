import type { PoolClient } from "pg";
import { meetingSelect, type MeetingRow } from "../db";
import type { Occurrence } from "./ics";
import { normalizeText } from "./rules";
import type { ApplyContext } from "./upsert";

// Casamento de um evento importado automaticamente (ex.: aurora-outlook) com uma reunião que o usuário já tinha
// (cadastro manual ou .ics com o UID real do Outlook). O envio automático usa um uid próprio (hash de título e
// início), que nunca bate com o dessas linhas: sem este passo a reunião existente seria duplicada.

export const MATCH_TOLERANCE_MS = 5 * 60_000;
// Só o cancelamento descarta a reunião para o reconhecimento: foi descartada pelo usuário. Qualquer outro status
// (inclusive gravada, em andamento ou com erro) conta como "já existe" e impede a criação de uma duplicata.
const DISCARDED_STATUS = "cancelled";
// Status em que o cadastro manual ainda pode receber o vínculo (uid/origem do envio); nos demais a linha é intocável.
const LINKABLE_STATUSES = ["scheduled", "skipped", "missed"];
const MANUAL = "manual";
const MATCHABLE_SOURCES = [MANUAL, "ics"];

export function sameTitle(a: string, b: string): boolean {
  const left = normalizeText(a);
  return left !== "" && left === normalizeText(b);
}

export function withinTolerance(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= MATCH_TOLERANCE_MS;
}

/** Entre as candidatas (já do mesmo dono), a de mesmo título e início dentro da tolerância mais próxima do evento. */
export function pickCandidate(rows: MeetingRow[], o: Occurrence): MeetingRow | null {
  const distance = (r: MeetingRow) => Math.abs((r.scheduled_start?.getTime() ?? 0) - o.start.getTime());
  const fits = rows.filter(
    (r) => r.scheduled_start && withinTolerance(r.scheduled_start, o.start) && sameTitle(r.title, o.title),
  );
  return fits.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** Cadastro manual que já foi vinculado a um evento da origem: o que o usuário escolheu nele não é sobrescrito. */
export function isLinkedManual(row: MeetingRow, importSource: string | undefined): boolean {
  return Boolean(importSource) && row.source === MANUAL && row.import_source === importSource;
}

async function findCandidate(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<MeetingRow | null> {
  const { rows } = await client.query(
    `${meetingSelect}
     WHERE m.created_by = $1 AND m.source = ANY($2) AND m.status <> $3
       AND m.import_source IS DISTINCT FROM $4
       AND m.scheduled_start >= $5 AND m.scheduled_start <= $6
     ORDER BY m.scheduled_start, m.id FOR UPDATE OF m`,
    [
      ctx.userId, MATCHABLE_SOURCES, DISCARDED_STATUS, ctx.importSource,
      new Date(o.start.getTime() - MATCH_TOLERANCE_MS), new Date(o.start.getTime() + MATCH_TOLERANCE_MS),
    ],
  );
  return pickCandidate(rows as MeetingRow[], o);
}

/** Cadastro manual ainda sem vínculo e em status editável: único caso em que o envio grava uid/origem na linha. */
export function canLink(row: MeetingRow): boolean {
  return (
    row.source === MANUAL && !row.ical_uid && !row.import_source && LINKABLE_STATUSES.includes(row.status)
  );
}

/** Colunas que a importação pode mexer numa reunião vinculada: só o que está vazio e o horário, se foi remarcada. */
export function linkedChanges(existing: MeetingRow, o: Occurrence): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (!existing.url && o.url) Object.assign(changes, { url: o.url, platform: o.platform });
  if (!existing.organizer && o.organizer) changes.organizer = o.organizer;
  if (!existing.location && o.location) changes.location = o.location;
  if (!existing.scheduled_end) changes.scheduled_end = o.end;
  if (existing.scheduled_start && !withinTolerance(existing.scheduled_start, o.start)) {
    Object.assign(changes, { scheduled_start: o.start, scheduled_end: o.end });
  }
  return changes;
}

async function applyChanges(client: PoolClient, id: string, changes: Record<string, unknown>): Promise<boolean> {
  const columns = Object.keys(changes);
  if (columns.length === 0) return false;
  // Os nomes de coluna vêm de linkedChanges (fixos), nunca da entrada.
  const sets = columns.map((column, i) => `${column} = $${i + 2}`).join(", ");
  await client.query(`UPDATE meetings SET ${sets} WHERE id = $1`, [id, ...columns.map((c) => changes[c])]);
  return true;
}

/** Reimportação de uma reunião já vinculada: preserva título, status, "Não gravar", série e link; só preenche vazios. */
export async function applyLinked(
  client: PoolClient,
  existing: MeetingRow,
  o: Occurrence,
  ctx: ApplyContext,
): Promise<void> {
  ctx.seen?.add(existing.id);
  const changed = !o.cancelled && (await applyChanges(client, existing.id, linkedChanges(existing, o)));
  if (changed) {
    ctx.touched.add(existing.id);
    ctx.result.updated++;
  } else {
    ctx.result.unchanged++;
  }
}

/**
 * Procura reunião do mesmo dono, de outra origem, com mesmo título e início (±5 min), em qualquer status menos
 * cancelada. Achando, não cria nada: cadastro manual sem UID e ainda editável recebe o uid/origem do envio; o resto
 * (UID próprio do .ics, reunião já gravada ou em andamento) é só reconhecido, sem alterar a linha.
 * Devolve true quando o evento foi absorvido por uma reunião existente.
 */
export async function adoptExisting(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<boolean> {
  const candidate = await findCandidate(client, o, ctx);
  if (!candidate) return false;
  ctx.seen?.add(candidate.id);
  if (!canLink(candidate)) {
    ctx.result.unchanged++;
    return true;
  }
  await client.query(
    `UPDATE meetings SET ical_uid = $2, recurrence_key = $3, import_source = $4,
       ical_sequence = GREATEST(ical_sequence, $5)
     WHERE id = $1 AND ical_uid IS NULL`,
    [candidate.id, o.uid, o.recurrenceKey, ctx.importSource, o.sequence],
  );
  await applyChanges(client, candidate.id, linkedChanges(candidate, o));
  ctx.touched.add(candidate.id);
  ctx.result.updated++;
  return true;
}

/** Reunião que uma importação automática (ex.: Aurora) criou, do mesmo dono, com mesmo título e início (±5 min). */
async function findImported(client: PoolClient, o: Occurrence, userId: string): Promise<MeetingRow | null> {
  const { rows } = await client.query(
    `${meetingSelect}
     WHERE m.created_by = $1 AND m.import_source IS NOT NULL AND m.status <> $2
       AND m.scheduled_start >= $3 AND m.scheduled_start <= $4
     ORDER BY m.scheduled_start, m.id FOR UPDATE OF m`,
    [
      userId, DISCARDED_STATUS,
      new Date(o.start.getTime() - MATCH_TOLERANCE_MS), new Date(o.start.getTime() + MATCH_TOLERANCE_MS),
    ],
  );
  return pickCandidate(rows as MeetingRow[], o);
}

/**
 * Importação de .ics sobre reunião que a importação automática já criou (a Aurora não traz o link do Teams): em vez
 * de duplicar, completa a existente com o que o convite traz (link, plataforma, organizador, local, descrição,
 * participantes) só onde estava vazio. O uid e a origem da Aurora ficam como estão, para o próximo envio dela
 * reconhecer a mesma linha. Devolve true quando o evento foi absorvido.
 */
export async function adoptImported(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<boolean> {
  const candidate = await findImported(client, o, ctx.userId);
  if (!candidate) return false;
  if (!LINKABLE_STATUSES.includes(candidate.status)) {
    ctx.result.unchanged++;
    return true;
  }
  const changes = linkedChanges(candidate, o);
  if (!candidate.description && o.description) changes.description = o.description;
  if (!candidate.attendees?.length && o.attendees.length) changes.attendees = JSON.stringify(o.attendees);
  if (await applyChanges(client, candidate.id, changes)) {
    ctx.touched.add(candidate.id);
    ctx.result.updated++;
  } else {
    ctx.result.unchanged++;
  }
  return true;
}
