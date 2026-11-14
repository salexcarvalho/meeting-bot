import type { PoolClient } from "pg";
import type { ImportResult } from "@meeting-bot/contracts";
import { meetingSelect, type MeetingRow } from "../db";
import type { Occurrence } from "./ics";
import { decideUpsert, EDITABLE_STATUSES, suggestProject, type ProjectMatcher, type UpsertDecision } from "./rules";

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
  /**
   * Origem de uma importação automática (ex.: aurora-outlook). Quando definida: as reuniões criadas levam essa
   * marca, o que o envio não informa (descrição, participantes, campos vazios) é preservado, e uma reunião
   * cancelada por sumir da lista volta se reaparecer.
   */
  importSource?: string;
  /** ids de todas as reuniões presentes no envio (existentes ou criadas), para detectar as que sumiram */
  seen?: Set<string>;
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

async function createMeeting(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<string> {
  const project = suggestProject(o.title, ctx.projects);
  const ended = o.end.getTime() <= ctx.now;
  const { rows } = await client.query(
    `INSERT INTO meetings (title, platform, url, status, created_by, source, scheduled_start, scheduled_end,
       organizer, attendees, description, location, ical_uid, recurrence_key, ical_sequence,
       project_id, project_suggested, import_source)
     VALUES ($1, $2, $3, $4, $5, 'ics', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
    [
      o.title, o.platform, o.url, ended ? "missed" : "scheduled", ctx.userId, o.start, o.end,
      o.organizer, JSON.stringify(o.attendees), o.description, o.location, o.uid, o.recurrenceKey,
      o.sequence, project?.id ?? null, Boolean(project), ctx.importSource ?? null,
    ],
  );
  ctx.touched.add(rows[0].id);
  ctx.result.created++;
  return rows[0].id;
}

async function updateMeeting(
  client: PoolClient,
  existing: MeetingRow,
  o: Occurrence,
  ctx: ApplyContext,
  revive: boolean,
): Promise<void> {
  // "Não gravar" é escolha do usuário: sobrevive à reimportação e a um cancelamento por sumiço.
  const keepSkipped = existing.status === "skipped" || (revive && existing.skip_recording);
  let status = o.end.getTime() <= ctx.now ? "missed" : "scheduled";
  if (keepSkipped) status = "skipped";
  await client.query(
    `UPDATE meetings SET title = $2, platform = $3, url = $4, status = $5, scheduled_start = $6,
       scheduled_end = $7, organizer = $8, attendees = $9, description = $10, location = $11,
       ical_sequence = $12, import_removed_at = NULL
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

async function findExisting(client: PoolClient, o: Occurrence, ctx: ApplyContext): Promise<MeetingRow | null> {
  // Importação automática também reconhece o evento único vindo de um .ics (chave de recorrência vazia).
  const { rows } = ctx.importSource
    ? await client.query(
        `${meetingSelect}
         WHERE m.ical_uid = $1 AND m.created_by = $3
           AND (m.recurrence_key = $2 OR (m.recurrence_key = '' AND m.scheduled_start = $4))
         ORDER BY (m.recurrence_key = $2) DESC LIMIT 1 FOR UPDATE OF m`,
        [o.uid, o.recurrenceKey, ctx.userId, o.start],
      )
    : await client.query(
        `${meetingSelect} WHERE m.ical_uid = $1 AND m.recurrence_key = $2 AND m.created_by = $3 FOR UPDATE OF m`,
        [o.uid, o.recurrenceKey, ctx.userId],
      );
  return (rows[0] as MeetingRow | undefined) ?? null;
}

// O envio automático não traz descrição nem participantes e pode vir sem organizador/local/link:
// o que ele não informa fica como está na reunião.
function keepUnsentDetails(o: Occurrence, existing: MeetingRow): Occurrence {
  return {
    ...o,
    description: existing.description,
    attendees: existing.attendees ?? [],
    organizer: o.organizer ?? existing.organizer,
    location: o.location ?? existing.location,
    url: o.url ?? existing.url,
    platform: o.url ? o.platform : existing.platform,
  };
}

function decide(existing: MeetingRow | null, o: Occurrence, ctx: ApplyContext): { decision: UpsertDecision; revive: boolean } {
  // Voltou à lista depois de ter sumido: reativa (cancelamento do usuário continua cancelado).
  const revive = Boolean(ctx.importSource && existing?.status === "cancelled" && existing.import_removed_at && !o.cancelled);
  if (revive) return { decision: "update", revive };
  const decision = decideUpsert(
    existing && { status: existing.status, ical_sequence: existing.ical_sequence, changed: !sameData(existing, o) },
    { sequence: o.sequence, cancelled: o.cancelled },
  );
  return { decision, revive };
}

async function execute(
  client: PoolClient,
  step: { decision: UpsertDecision; revive: boolean },
  existing: MeetingRow | null,
  o: Occurrence,
  ctx: ApplyContext,
): Promise<void> {
  if (step.decision === "create") {
    const id = await createMeeting(client, o, ctx);
    ctx.seen?.add(id);
  } else if (step.decision === "update" && existing) {
    await updateMeeting(client, existing, o, ctx, step.revive);
  } else if (step.decision === "cancel" && existing) {
    await cancelMeeting(client, existing, o, ctx);
  } else if (step.decision === "ignore") {
    ctx.result.ignored++;
  } else {
    ctx.result.unchanged++;
  }
}

export async function applyOccurrence(client: PoolClient, incoming: Occurrence, ctx: ApplyContext): Promise<void> {
  if (incoming.cancelsSeries) return cancelSeries(client, incoming, ctx);

  const existing = await findExisting(client, incoming, ctx);
  const o = ctx.importSource && existing ? keepUnsentDetails(incoming, existing) : incoming;
  if (existing) ctx.seen?.add(existing.id);
  await execute(client, decide(existing, o, ctx), existing, o, ctx);
}
