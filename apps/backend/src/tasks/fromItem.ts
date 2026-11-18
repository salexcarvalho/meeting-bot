import type { PoolClient } from "pg";
import type { Task, TaskFromItemInput, TaskNotice, TaskRef, TaskSourceSnapshot } from "@meeting-bot/contracts";
import { DUPLICATE_THRESHOLD, jaccard, normalizeTokens } from "../agent/dedup";
import { can, meetingAccess } from "../authz";
import { pool, withTransaction } from "../db";
import { audit } from "../security/audit";
import type { User } from "../types";
import { getProfile } from "../users/repo";
import { deriveTitle, parseDueText } from "./derive";
import { isSelfOwner } from "./identity";
import { addTaskHistory, getTask, TaskError, type TaskCtx } from "./service";

// Criação de tarefa a partir de item da reunião (specs/002 US1). Só item APROVADO por humano vira tarefa
// (Constituição III). Uma tarefa por item e por pessoa: índice único + ON CONFLICT DO NOTHING.

interface Source {
  id: string;
  meetingId: string;
  type: string;
  description: string;
  owner: string | null;
  due: string | null;
  reviewStatus: string;
  meetingTitle: string;
  meetingAt: Date;
  projectId: string | null;
}

type Assignee = { kind: "self" | "other" | "none"; name: string | null };
type TaskOrigin = "item_auto" | "item_manual";

const NAME_MAX = 120;

/** Item que o usuário pode ler (acesso à reunião + meetings.read + tasks.manage); senão null (vira 404). */
async function loadSource(user: User, itemId: string): Promise<Source | null> {
  if (!can(user, "tasks.manage") || !can(user, "meetings.read")) return null;
  const { rows } = await pool.query(
    `SELECT i.id, i.meeting_id, i.type, i.description, i.owner, i.due, i.review_status,
            m.title, m.project_id, COALESCE(m.scheduled_start, m.started_at, m.created_at) AS meeting_at
       FROM meeting_items i JOIN meetings m ON m.id = i.meeting_id
      WHERE i.id = $1`,
    [itemId],
  );
  const r = rows[0];
  if (!r || !(await meetingAccess(user, r.meeting_id))) return null;
  return {
    id: r.id,
    meetingId: r.meeting_id,
    type: r.type,
    description: r.description,
    owner: r.owner,
    due: r.due,
    reviewStatus: r.review_status,
    meetingTitle: r.title,
    meetingAt: r.meeting_at,
    projectId: r.project_id,
  };
}

async function existingTask(db: Pick<PoolClient, "query">, ownerId: string, itemId: string): Promise<{ id: string; status: Task["status"] } | null> {
  const { rows } = await db.query(`SELECT t.id, t.status FROM tasks t WHERE t.owner_id = $1 AND t.source_item_id = $2`, [ownerId, itemId]);
  return rows[0] ?? null;
}

/** Tarefa do mesmo dono na mesma reunião com texto parecido (Jaccard como em `agent/dedup.ts`). */
async function similarTask(ownerId: string, src: Source): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.description FROM tasks t
      WHERE t.owner_id = $1 AND t.meeting_id = $2 AND t.source_item_id IS DISTINCT FROM $3`,
    [ownerId, src.meetingId, src.id],
  );
  const tokens = normalizeTokens(src.description);
  const hit = rows.find((t) => jaccard(tokens, normalizeTokens(t.description || t.title)) >= DUPLICATE_THRESHOLD);
  return hit?.id ?? null;
}

async function buildSnapshot(src: Source): Promise<TaskSourceSnapshot> {
  const { rows } = await pool.query(
    `SELECT quote, start_seconds, channel FROM item_evidence WHERE item_id = $1 ORDER BY (quote IS NULL), start_seconds, id LIMIT 1`,
    [src.id],
  );
  const ev = rows[0];
  return {
    meetingTitle: src.meetingTitle,
    meetingDate: src.meetingAt.toISOString(),
    itemType: src.type as TaskSourceSnapshot["itemType"],
    itemDescription: src.description,
    itemOwner: src.owner,
    itemDue: src.due,
    ...(ev?.quote ? { quote: ev.quote, quoteStart: Number(ev.start_seconds), channel: ev.channel } : {}),
  };
}

async function derivedAssignee(user: User, owner: string | null): Promise<Assignee> {
  const name = (owner ?? "").trim();
  if (!name) return { kind: "none", name: null };
  const profile = await getProfile(user.id);
  const self = profile ? isSelfOwner(name, profile) : false;
  return self ? { kind: "self", name: null } : { kind: "other", name: name.slice(0, NAME_MAX) };
}

function overrideAssignee(input: TaskFromItemInput["assignee"]): Assignee | null {
  if (!input) return null;
  return { kind: input.kind, name: input.kind === "other" ? input.name : null };
}

/** `INSERT ... ON CONFLICT DO NOTHING`: devolve a tarefa nova ou, se a corrida perdeu, a que já existia. */
async function insertFromItem(
  ctx: TaskCtx,
  src: Source,
  origin: TaskOrigin,
  assignee: Assignee,
  input: Partial<TaskFromItemInput>,
): Promise<{ id: string; created: boolean }> {
  const snapshot = await buildSnapshot(src);
  const parsed = parseDueText(src.due, src.meetingAt, ctx.timezone);
  const dueDate = input.dueDate === undefined ? parsed.date : input.dueDate;
  const rawHint = src.due?.trim().slice(0, NAME_MAX) || null;
  const title = input.title ?? deriveTitle(src.description);
  const description = src.description.trim() === title ? "" : src.description.trim();
  return withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO tasks (owner_id, title, description, priority, due_date, due_hint, assignee_kind, assignee_name,
                          project_id, meeting_id, source_item_id, source_snapshot, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (source_item_id, owner_id) WHERE source_item_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        ctx.user.id,
        title,
        description,
        input.priority ?? "media",
        dueDate,
        dueDate ? null : rawHint,
        assignee.kind,
        assignee.name,
        src.projectId,
        src.meetingId,
        src.id,
        snapshot,
        origin,
      ],
    );
    if (!ins.rows[0]) {
      const current = await existingTask(client, ctx.user.id, src.id);
      if (!current) throw new TaskError("Não foi possível criar a tarefa.", 409);
      return { id: current.id, created: false };
    }
    const id = ins.rows[0].id as string;
    await addTaskHistory(client, id, "created", null, { title, status: "a_fazer", origin }, ctx.user.id);
    return { id, created: true };
  }).then((result) => {
    if (result.created) {
      audit("task_created_from_item", { taskId: result.id, itemId: src.id, meetingId: src.meetingId, origin }, ctx.user.id);
    }
    return result;
  });
}

/** `POST /tasks/from-item` e o botão "Virar tarefa": qualquer item aprovado, por ação explícita. */
export async function createFromItem(ctx: TaskCtx, input: TaskFromItemInput): Promise<{ task: Task; created: boolean }> {
  const src = await loadSource(ctx.user, input.itemId);
  if (!src) throw new TaskError("Item não encontrado.", 404);
  if (src.reviewStatus !== "aprovado") throw new TaskError("Só um item aprovado vira tarefa.", 409, "item_not_approved");
  const current = await existingTask(pool, ctx.user.id, src.id);
  if (current) return { task: (await getTask(ctx, current.id))!, created: false };
  if (!input.force) {
    const similar = await similarTask(ctx.user.id, src);
    if (similar) throw new TaskError("Já existe uma tarefa parecida nesta reunião.", 409, "possible_duplicate", { taskId: similar });
  }
  const assignee = overrideAssignee(input.assignee) ?? (await derivedAssignee(ctx.user, src.owner));
  const result = await insertFromItem(ctx, src, "item_manual", assignee, input);
  return { task: (await getTask(ctx, result.id))!, created: result.created };
}

export interface ApprovalResult {
  task: TaskRef | null;
  notice?: TaskNotice;
}

/**
 * Aprovar uma pendência cria a tarefa de quem aprovou (Q1 = A), se o responsável é o aprovador ou está vazio
 * (Q2 = B). Pendência de outra pessoa, item de outro tipo e tarefa parecida não criam nada sozinhos.
 */
export async function createFromApproval(ctx: TaskCtx, itemId: string): Promise<ApprovalResult> {
  const src = await loadSource(ctx.user, itemId);
  if (src?.type !== "pendencia" || src.reviewStatus !== "aprovado") return { task: null };
  const current = await existingTask(pool, ctx.user.id, src.id);
  if (current) return { task: current };
  const assignee = await derivedAssignee(ctx.user, src.owner);
  if (assignee.kind === "other") return { task: null, notice: { kind: "assignee_other", name: assignee.name ?? "" } };
  const similar = await similarTask(ctx.user.id, src);
  if (similar) return { task: null, notice: { kind: "possible_duplicate", taskId: similar } };
  const created = await insertFromItem(ctx, src, "item_auto", assignee, {});
  const row = await existingTask(pool, ctx.user.id, src.id);
  return { task: row ?? { id: created.id, status: "a_fazer" } };
}
