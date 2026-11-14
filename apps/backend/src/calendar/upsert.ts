import type { PoolClient } from "pg";
import type { ImportResult } from "@meeting-bot/contracts";
import { meetingSelect, type MeetingRow } from "../db";
import type { Occurrence } from "./ics";
import { decideUpsert, EDITABLE_STATUSES, suggestProject, type ProjectMatcher } from "./rules";

// Persistência de uma ocorrência de calendário (compartilhada pela importação de .ics e pela
// rota da agenda enviada por assistente externo): cria, atualiza ou cancela sem tocar nas
// escolhas do usuário na reunião (não gravar, itens, projeto).

export interface ApplyContext {
  userId: string;
  projects: ProjectMatcher[];
  now: number;
  result: ImportResult;
  /** ids de reuniões alteradas, para avisar a interface ao vivo */
  touched: Set<string>;
}

function sameData(row: MeetingRow, o: Occurrence): boolean {
  return (
    row.title === o.title &&
    row.scheduled_start?.getTime() === o.start.getTime() &&
    row.scheduled_end?.getTime() === o.end.getTime() &&
    (row.url ?? null) === o.url &&
    (row.organizer ?? null) === o.organizer &&
    (row.location ?? null) === o.location &&
    (row.description ?? null) === o.description &&
    JSON.stringify(row.attendees ?? []) === JSON.stringify(o.attendees)
  );
}

async function cancelSeries(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<void> {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'cancelled', ical_sequence = GREATEST(ical_sequence, $2)
     WHERE ical_uid = $1 AND created_by = $4 AND status = ANY($3) AND status <> 'cancelled' RETURNING id`,
    [o.uid, o.sequence, EDITABLE_STATUSES, ctx.userId],
  );
  ctx.result.cancelled += rows.length;
  rows.forEach((r) => ctx.touched.add(r.id));
}

async function createMeeting(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<void> {
  const project = suggestProject(o.title, ctx.projects);
  const ended = o.end.getTime() <= ctx.now;
  const { rows } = await client.query(
    `INSERT INTO meetings (title, platform, url, status, created_by, source, scheduled_start, scheduled_end,
       organizer, attendees, description, location, ical_uid, recurrence_key, ical_sequence,
       project_id, project_suggested)
     VALUES ($1, $2, $3, $4, $5, 'ics', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      o.title, o.platform, o.url, ended ? "missed" : "scheduled", ctx.userId, o.start, o.end,
      o.organizer, JSON.stringify(o.attendees), o.description, o.location, o.uid, o.recurrenceKey,
      o.sequence, project?.id ?? null, Boolean(project),
    ],
  );
  ctx.touched.add(rows[0].id);
  ctx.result.created++;
}

async function updateMeeting(client: PoolClient, existing: MeetingRow, o: Occurrence, ctx: ApplyContext): Promise<void> {
  const ended = o.end.getTime() <= ctx.now;
  const status = existing.status === "skipped" ? "skipped" : ended ? "missed" : "scheduled";
  await client.query(
    `UPDATE meetings SET title = $2, platform = $3, url = $4, status = $5, scheduled_start = $6,
       scheduled_end = $7, organizer = $8, attendees = $9, description = $10, location = $11,
       ical_sequence = $12
     WHERE id = $1`,
    [
      existing.id, o.title, o.platform, o.url, status, o.start, o.end, o.organizer,
      JSON.stringify(o.attendees), o.description, o.location, o.sequence,
    ],
  );
  ctx.touched.add(existing.id);
  ctx.result.updated++;
}

async function cancelMeeting(client: PoolClient, existing: MeetingRow, o: Occurrence, ctx: ApplyContext): Promise<void> {
  await client.query(`UPDATE meetings SET status = 'cancelled', ical_sequence = $2 WHERE id = $1`, [
    existing.id,
    o.sequence,
  ]);
  ctx.touched.add(existing.id);
  ctx.result.cancelled++;
}

export async function applyOccurrence(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<void> {
  if (o.cancelsSeries) return cancelSeries(client, o, ctx);

  const { rows } = await client.query(
    `${meetingSelect} WHERE m.ical_uid = $1 AND m.recurrence_key = $2 AND m.created_by = $3 FOR UPDATE OF m`,
    [o.uid, o.recurrenceKey, ctx.userId],
  );
  const existing = (rows[0] as MeetingRow | undefined) ?? null;
  const decision = decideUpsert(
    existing && { status: existing.status, ical_sequence: existing.ical_sequence, changed: !sameData(existing, o) },
    { sequence: o.sequence, cancelled: o.cancelled },
  );

  if (decision === "create") await createMeeting(client, o, ctx);
  else if (decision === "update" && existing) await updateMeeting(client, existing, o, ctx);
  else if (decision === "cancel" && existing) await cancelMeeting(client, existing, o, ctx);
  else if (decision === "ignore") ctx.result.ignored++;
  else ctx.result.unchanged++;
}
