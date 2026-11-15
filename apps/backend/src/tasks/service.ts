import type { PoolClient } from "pg";
import {
  OPEN_STATUSES,
  TASK_STATUSES,
  type Task,
  type TaskAssigneeInput,
  type TaskCounts,
  type TaskHistoryEntry,
  type TaskInput,
  type TaskListResponse,
  type TaskPatch,
  type TaskQuery,
  type TaskStatus,
  type TaskSummaryResponse,
} from "@meeting-bot/contracts";
import { can, meetingAccess, visibleMeetingsSql } from "../authz";
import { config } from "../config";
import { pool, withTransaction } from "../db";
import type { User } from "../types";
import { buildTaskQuery, COUNTS_SQL, TASK_SELECT } from "./query";
import { serializeTasks, type TaskRow } from "./serialize";

// Tarefas pessoais (specs/002-pendencias-tarefas). REGRA CENTRAL: toda consulta de `tasks` recebe o dono da
// sessão (`owner_id`) e filtra por ele; não existe leitura de tarefa de outro usuário, nem por administrador.

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const TASK_NOT_FOUND = "Tarefa não encontrada.";

export interface TaskCtx {
  user: User;
  /** fuso do usuário: "hoje" e "atrasada" são datas civis nele */
  timezone: string;
}

function validZone(zone: string | null | undefined): string {
  if (!zone) return config.appTimezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return config.appTimezone;
  }
}

export async function taskContext(user: User): Promise<TaskCtx> {
  const { rows } = await pool.query(`SELECT timezone FROM users WHERE id = $1`, [user.id]);
  return { user, timezone: validZone(rows[0]?.timezone) };
}

type Db = Pick<PoolClient, "query">;

// ---------- leitura ----------

async function loadRows(db: Db, ctx: TaskCtx, where: string, extra: unknown[]): Promise<TaskRow[]> {
  const { rows } = await db.query(`${TASK_SELECT} WHERE t.owner_id = $1 AND ${where}`, [ctx.user.id, ctx.timezone, ...extra]);
  return rows as TaskRow[];
}

export async function getTask(ctx: TaskCtx, id: string, db: Db = pool): Promise<Task | null> {
  const rows = await loadRows(db, ctx, "t.id = $3", [id]);
  return rows.length ? (await serializeTasks(rows, ctx.user))[0] : null;
}

export async function listMeetingTasks(ctx: TaskCtx, meetingId: string): Promise<Task[]> {
  const rows = await loadRows(pool, ctx, "t.meeting_id = $3 ORDER BY t.created_at, t.id", [meetingId]);
  return serializeTasks(rows, ctx.user);
}

function emptyByStatus(): Record<TaskStatus, number> {
  return Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
}

export async function taskCounts(ctx: TaskCtx): Promise<TaskCounts> {
  const { rows } = await pool.query(COUNTS_SQL, [ctx.user.id, ctx.timezone]);
  const counts: TaskCounts = { byStatus: emptyByStatus(), open: 0, overdue: 0, dueToday: 0, unconfirmedAssignee: 0 };
  for (const r of rows) {
    counts.byStatus[r.status as TaskStatus] = r.total;
    counts.overdue += r.overdue;
    counts.dueToday += r.due_today;
    counts.unconfirmedAssignee += r.unconfirmed;
    if (OPEN_STATUSES.includes(r.status)) counts.open += r.total;
  }
  return counts;
}

export async function listTasks(ctx: TaskCtx, query: TaskQuery): Promise<TaskListResponse> {
  const { list, count } = buildTaskQuery(query, ctx.user.id, ctx.timezone);
  const [rows, total, counts] = await Promise.all([
    pool.query(list.text, list.values),
    pool.query(count.text, count.values),
    taskCounts(ctx),
  ]);
  return { tasks: await serializeTasks(rows.rows as TaskRow[], ctx.user), total: total.rows[0].total, counts };
}

/** Cartão da tela Hoje: contadores e quantas pendências propostas aguardam revisão nas reuniões visíveis. */
export async function taskSummary(ctx: TaskCtx): Promise<TaskSummaryResponse> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM meeting_items i JOIN meetings m ON m.id = i.meeting_id
      WHERE i.type = 'pendencia' AND i.review_status = 'proposto' AND m.extract_items
        AND ${visibleMeetingsSql(ctx.user, "m", 1)}`,
    [ctx.user.id],
  );
  const counts = await taskCounts(ctx);
  return { counts, proposalsToReview: can(ctx.user, "meetings.read") ? rows[0].n : 0 };
}

export async function getHistory(ctx: TaskCtx, id: string): Promise<TaskHistoryEntry[] | null> {
  const own = await pool.query(`SELECT 1 FROM tasks t WHERE t.owner_id = $1 AND t.id = $2`, [ctx.user.id, id]);
  if (!own.rowCount) return null;
  const { rows } = await pool.query(
    `SELECT h.id, h.action, h.before, h.after, h.created_at, u.id AS actor_id,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.real_name, ''), u.username) AS actor_name
       FROM task_history h
       JOIN tasks t ON t.id = h.task_id
       LEFT JOIN users u ON u.id = h.actor_id
      WHERE t.owner_id = $1 AND h.task_id = $2
      ORDER BY h.id`,
    [ctx.user.id, id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    before: r.before,
    after: r.after,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
    createdAt: r.created_at.toISOString(),
  }));
}

// ---------- escrita ----------

export function assigneeColumns(a: TaskAssigneeInput | undefined): { kind: string; name: string | null } {
  if (!a || a.kind === "self") return { kind: "self", name: null };
  if (a.kind === "other") return { kind: "other", name: a.name };
  return { kind: "none", name: null };
}

export async function addTaskHistory(
  db: Db,
  taskId: string,
  action: "created" | "edited" | "status_changed",
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  actorId: string,
): Promise<void> {
  await db.query(`INSERT INTO task_history (task_id, action, before, after, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    taskId,
    action,
    before,
    after,
    actorId,
  ]);
}

async function assertProject(db: Db, projectId: string): Promise<void> {
  const { rowCount } = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if (!rowCount) throw new TaskError("Projeto não encontrado.", 404);
}

/** Reunião que o usuário ainda enxerga (acesso de leitura + `meetings.read`), com título, data e projeto. */
export async function readableMeeting(
  user: User,
  meetingId: string,
): Promise<{ id: string; title: string; scheduledStart: Date | null; startedAt: Date | null; createdAt: Date; projectId: string | null } | null> {
  if (!can(user, "meetings.read") || !(await meetingAccess(user, meetingId))) return null;
  const { rows } = await pool.query(
    `SELECT id, title, scheduled_start, started_at, created_at, project_id FROM meetings WHERE id = $1`,
    [meetingId],
  );
  const m = rows[0];
  if (!m) return null;
  return { id: m.id, title: m.title, scheduledStart: m.scheduled_start, startedAt: m.started_at, createdAt: m.created_at, projectId: m.project_id };
}

export async function createManualTask(ctx: TaskCtx, input: TaskInput): Promise<Task> {
  const meeting = input.meetingId ? await readableMeeting(ctx.user, input.meetingId) : null;
  if (input.meetingId && !meeting) throw new TaskError("Reunião não encontrada.", 404);
  const projectId = input.projectId ?? meeting?.projectId ?? null;
  const assignee = assigneeColumns(input.assignee);
  const status = input.status ?? "a_fazer";
  const snapshot = meeting
    ? { meetingTitle: meeting.title, meetingDate: (meeting.scheduledStart ?? meeting.startedAt ?? meeting.createdAt).toISOString() }
    : null;
  const id = await withTransaction(async (client) => {
    if (projectId) await assertProject(client, projectId);
    const ins = await client.query(
      `INSERT INTO tasks (owner_id, title, description, status, priority, due_date, assignee_kind, assignee_name,
                          project_id, meeting_id, source_snapshot, origin, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'manual', CASE WHEN $4::text = 'concluida' THEN now() END)
       RETURNING id`,
      [
        ctx.user.id,
        input.title,
        input.description ?? "",
        status,
        input.priority ?? "media",
        input.dueDate ?? null,
        assignee.kind,
        assignee.name,
        projectId,
        meeting?.id ?? null,
        snapshot,
      ],
    );
    await addTaskHistory(client, ins.rows[0].id, "created", null, { title: input.title, status, origin: "manual" }, ctx.user.id);
    return ins.rows[0].id as string;
  });
  return (await getTask(ctx, id))!;
}

interface Change {
  column: string;
  value: unknown;
  key: string;
  before: unknown;
  after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Current = Record<string, any>;

function fieldChanges(current: Current, patch: TaskPatch): Change[] {
  const out: Change[] = [];
  const push = (key: string, column: string, before: unknown, after: unknown) => {
    if (!same(before, after)) out.push({ key, column, value: after, before, after });
  };
  if (patch.title !== undefined) push("title", "title", current.title, patch.title);
  if (patch.description !== undefined) push("description", "description", current.description, patch.description);
  if (patch.priority !== undefined) push("priority", "priority", current.priority, patch.priority);
  if (patch.dueDate !== undefined) push("dueDate", "due_date", current.due_date_text, patch.dueDate);
  if (patch.dueHint === null) push("dueHint", "due_hint", current.due_hint, null);
  if (patch.projectId !== undefined) push("projectId", "project_id", current.project_id, patch.projectId);
  return out;
}

async function lockOwned(client: PoolClient, ctx: TaskCtx, id: string): Promise<Current> {
  const { rows } = await client.query(
    `SELECT t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due_date_text FROM tasks t WHERE t.owner_id = $1 AND t.id = $2 FOR UPDATE`,
    [ctx.user.id, id],
  );
  if (!rows[0]) throw new TaskError(TASK_NOT_FOUND, 404);
  return rows[0];
}

export async function patchTask(ctx: TaskCtx, id: string, patch: TaskPatch): Promise<Task> {
  await withTransaction(async (client) => {
    const current = await lockOwned(client, ctx, id);
    const changes = fieldChanges(current, patch);
    const projectChange = changes.find((c) => c.key === "projectId");
    if (projectChange?.after) await assertProject(client, projectChange.after as string);
    if (patch.assignee !== undefined) {
      const next = assigneeColumns(patch.assignee);
      const before = { kind: current.assignee_kind, name: current.assignee_name };
      const after = { kind: next.kind, name: next.name };
      if (!same(before, after)) changes.push({ key: "assignee", column: "assignee_kind", value: next, before, after });
    }
    const statusChanged = patch.status !== undefined && patch.status !== current.status;
    if (!changes.length && !statusChanged) return;

    const sets: string[] = [];
    const values: unknown[] = [ctx.user.id, id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    for (const c of changes) {
      if (c.key === "assignee") {
        const next = c.value as { kind: string; name: string | null };
        set("assignee_kind", next.kind);
        set("assignee_name", next.name);
      } else {
        set(c.column, c.value);
      }
    }
    if (statusChanged) {
      set("status", patch.status);
      sets.push(patch.status === "concluida" ? "completed_at = now()" : "completed_at = NULL");
    }
    await client.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE owner_id = $1 AND id = $2`, values);

    if (changes.length) {
      const before = Object.fromEntries(changes.map((c) => [c.key, c.before]));
      const after = Object.fromEntries(changes.map((c) => [c.key, c.after]));
      await addTaskHistory(client, id, "edited", before, after, ctx.user.id);
    }
    if (statusChanged) {
      await addTaskHistory(client, id, "status_changed", { status: current.status }, { status: patch.status }, ctx.user.id);
    }
  });
  return (await getTask(ctx, id))!;
}

export function setStatus(ctx: TaskCtx, id: string, status: TaskStatus): Promise<Task> {
  return patchTask(ctx, id, { status });
}

export async function deleteTask(ctx: TaskCtx, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM tasks WHERE owner_id = $1 AND id = $2`, [ctx.user.id, id]);
  return Boolean(rowCount);
}
