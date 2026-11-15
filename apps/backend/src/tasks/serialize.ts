import { TaskSourceSnapshot, type ItemType, type ReviewStatus, type Task } from "@meeting-bot/contracts";
import { can, visibleMeetingsSql } from "../authz";
import { pool } from "../db";
import type { User } from "../types";

// Linha do banco → Task. A tarefa é pessoal; o que vem da reunião (título atual, item) só sai se o dono
// da tarefa ainda enxerga a reunião (specs/002 R11, Q4 = A): sem acesso, `meeting` e `sourceItem` ficam nulos
// e só o instantâneo `source` (gravado enquanto havia acesso) permanece.

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: Task["status"];
  priority: Task["priority"];
  due_date: string | null;
  due_hint: string | null;
  overdue: boolean;
  assignee_kind: Task["assignee"]["kind"];
  assignee_name: string | null;
  project_id: string | null;
  project_name: string | null;
  meeting_id: string | null;
  source_item_id: string | null;
  source_snapshot: unknown;
  origin: Task["origin"];
  external_ref: Task["externalRef"];
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface VisibleMeeting {
  id: string;
  title: string;
  scheduledStart: string | null;
}

async function visibleMeetings(user: User, ids: string[]): Promise<Map<string, VisibleMeeting>> {
  const out = new Map<string, VisibleMeeting>();
  if (!ids.length || !can(user, "meetings.read")) return out;
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.scheduled_start FROM meetings m
      WHERE m.id = ANY($1::uuid[]) AND $2::uuid IS NOT NULL AND ${visibleMeetingsSql(user, "m", 2)}`,
    [ids, user.id],
  );
  for (const r of rows) out.set(r.id, { id: r.id, title: r.title, scheduledStart: r.scheduled_start?.toISOString() ?? null });
  return out;
}

async function visibleItems(
  user: User,
  ids: string[],
): Promise<Map<string, { id: string; type: ItemType; reviewStatus: ReviewStatus }>> {
  const out = new Map<string, { id: string; type: ItemType; reviewStatus: ReviewStatus }>();
  if (!ids.length || !can(user, "meetings.read")) return out;
  const { rows } = await pool.query(
    `SELECT i.id, i.type, i.review_status FROM meeting_items i JOIN meetings m ON m.id = i.meeting_id
      WHERE i.id = ANY($1::uuid[]) AND $2::uuid IS NOT NULL AND ${visibleMeetingsSql(user, "m", 2)}`,
    [ids, user.id],
  );
  for (const r of rows) out.set(r.id, { id: r.id, type: r.type, reviewStatus: r.review_status });
  return out;
}

function parseSnapshot(raw: unknown): Task["source"] {
  if (!raw) return null;
  const parsed = TaskSourceSnapshot.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Uma consulta em lote por tipo (reuniões e itens), nunca uma por tarefa. */
export async function serializeTasks(rows: TaskRow[], user: User): Promise<Task[]> {
  const meetingIds = [...new Set(rows.map((r) => r.meeting_id).filter((id): id is string => Boolean(id)))];
  const itemIds = [...new Set(rows.map((r) => r.source_item_id).filter((id): id is string => Boolean(id)))];
  const [meetings, items] = await Promise.all([visibleMeetings(user, meetingIds), visibleItems(user, itemIds)]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date,
    dueHint: r.due_hint,
    overdue: r.overdue,
    assignee: { kind: r.assignee_kind, name: r.assignee_name },
    project: r.project_id ? { id: r.project_id, name: r.project_name ?? "" } : null,
    meeting: (r.meeting_id && meetings.get(r.meeting_id)) || null,
    sourceItem: (r.source_item_id && items.get(r.source_item_id)) || null,
    source: parseSnapshot(r.source_snapshot),
    origin: r.origin,
    externalRef: r.external_ref ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}
