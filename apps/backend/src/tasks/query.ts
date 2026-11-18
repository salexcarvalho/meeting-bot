import { OPEN_STATUSES, TASK_STATUSES, type TaskQuery } from "@meeting-bot/contracts";
import { escapeLike, foldText, FROM_ACCENTS, TO_ACCENTS } from "../users/lookupPattern";

// Filtros de GET /tasks → SQL parametrizado. Puro (sem banco), para teste unitário. Todo SQL sobre tasks
// carrega `t.owner_id = $1`: a tarefa é pessoal e nenhuma consulta existe fora do escopo do dono.

export class TaskFilterError extends Error {}

/** $1 = dono, $2 = fuso do usuário. Os demais valores entram a partir de $3. */
export const OWNER_PARAM = "$1";
export const ZONE_PARAM = "$2";

export const TODAY_SQL = `(now() AT TIME ZONE ${ZONE_PARAM})::date`;
const OPEN_LIST = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
export const OPEN_SQL = `t.status IN (${OPEN_LIST})`;
export const OVERDUE_SQL = `(t.due_date IS NOT NULL AND ${OPEN_SQL} AND t.due_date < ${TODAY_SQL})`;

const ACCENTS_FROM = FROM_ACCENTS + FROM_ACCENTS.toUpperCase();
const ACCENTS_TO = TO_ACCENTS + TO_ACCENTS.toUpperCase();
const SEARCH_TEXT_SQL = `lower(translate(t.title || ' ' || t.description, '${ACCENTS_FROM}', '${ACCENTS_TO}'))`;

const PRIORITY_RANK = `CASE t.priority WHEN 'urgente' THEN 4 WHEN 'alta' THEN 3 WHEN 'media' THEN 2 ELSE 1 END`;

const ORDER_BY: Record<TaskQuery["sort"], string> = {
  due: `t.due_date ASC NULLS LAST, ${PRIORITY_RANK} DESC, t.created_at DESC, t.id`,
  priority: `${PRIORITY_RANK} DESC, t.due_date ASC NULLS LAST, t.created_at DESC, t.id`,
  updated: `t.updated_at DESC, t.id`,
  created: `t.created_at DESC, t.id`,
};

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

class Params {
  readonly values: unknown[];
  constructor(ownerId: string, timezone: string) {
    this.values = [ownerId, timezone];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Valor de LIKE "contém": sem acento, sem maiúsculas e com os curingas do usuário escapados. */
const likeContains = (text: string): string => `%${escapeLike(foldText(text))}%`;

function statusClause(status: TaskQuery["status"], params: Params): string | null {
  if (status === "all") return null;
  if (status === "open") return OPEN_SQL;
  const list = (status as string[]).filter((s) => TASK_STATUSES.includes(s as never));
  if (!list.length) throw new TaskFilterError("status");
  return `t.status = ANY(${params.add(list)}::text[])`;
}

function dueClause(query: TaskQuery, params: Params): string | null {
  switch (query.due) {
    case undefined:
      return null;
    case "overdue":
      return OVERDUE_SQL;
    case "today":
      return `t.due_date = ${TODAY_SQL}`;
    case "week":
      // de hoje até o domingo da semana (ISO: segunda a domingo)
      return `t.due_date BETWEEN ${TODAY_SQL} AND ${TODAY_SQL} + (7 - extract(isodow FROM ${TODAY_SQL}))::int`;
    case "month":
      return `t.due_date BETWEEN ${TODAY_SQL} AND (date_trunc('month', ${TODAY_SQL}) + interval '1 month - 1 day')::date`;
    case "none":
      return "t.due_date IS NULL";
    case "range": {
      if (!query.dueFrom || !query.dueTo) throw new TaskFilterError("due");
      return `t.due_date BETWEEN ${params.add(query.dueFrom)}::date AND ${params.add(query.dueTo)}::date`;
    }
  }
}

function assigneeClause(query: TaskQuery, params: Params): string | null {
  if (!query.assignee) return null;
  if (query.assignee === "me") return "t.assignee_kind = 'self'";
  if (query.assignee === "none") return "t.assignee_kind = 'none'";
  if (!query.assigneeName) return "t.assignee_kind = 'other'";
  const pattern = params.add(likeContains(query.assigneeName));
  return `(t.assignee_kind = 'other' AND lower(translate(t.assignee_name, '${ACCENTS_FROM}', '${ACCENTS_TO}')) LIKE ${pattern} ESCAPE '\\')`;
}

/** Condições de filtro (sem o dono, que cada consulta escreve às claras) e valores, sem ordenação nem paginação. */
export function buildTaskFilter(query: TaskQuery, ownerId: string, timezone: string): { where: string; values: unknown[] } {
  const params = new Params(ownerId, timezone);
  // $2 (fuso) entra sempre no texto: o Postgres exige que todo parâmetro enviado seja usado.
  const clauses = [`${ZONE_PARAM}::text IS NOT NULL`];
  const add = (clause: string | null) => {
    if (clause) clauses.push(clause);
  };
  add(statusClause(query.status, params));
  if (query.projectId) add(query.projectId === "none" ? "t.project_id IS NULL" : `t.project_id = ${params.add(query.projectId)}`);
  add(dueClause(query, params));
  add(assigneeClause(query, params));
  if (query.priority?.length) add(`t.priority = ANY(${params.add(query.priority)}::text[])`);
  if (query.meetingId) add(`t.meeting_id = ${params.add(query.meetingId)}`);
  if (query.q) add(`${SEARCH_TEXT_SQL} LIKE ${params.add(likeContains(query.q))} ESCAPE '\\'`);
  return { where: clauses.join(" AND "), values: params.values };
}

export const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.due_hint,
         ${OVERDUE_SQL} AS overdue, t.assignee_kind, t.assignee_name, t.project_id, p.name AS project_name,
         t.meeting_id, t.source_item_id, t.source_snapshot, t.origin, t.external_ref, t.completed_at,
         t.created_at, t.updated_at
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`;

/** Lista paginada e contagem total do mesmo filtro. */
export function buildTaskQuery(query: TaskQuery, ownerId: string, timezone: string): { list: BuiltQuery; count: BuiltQuery } {
  const { where, values } = buildTaskFilter(query, ownerId, timezone);
  const limit = `$${values.length + 1}`;
  const offset = `$${values.length + 2}`;
  return {
    list: {
      text: `${TASK_SELECT} WHERE t.owner_id = ${OWNER_PARAM} AND ${where} ORDER BY ${ORDER_BY[query.sort]} LIMIT ${limit} OFFSET ${offset}`,
      values: [...values, query.limit, query.offset],
    },
    count: { text: `SELECT count(*)::int AS total FROM tasks t WHERE t.owner_id = ${OWNER_PARAM} AND ${where}`, values },
  };
}

/** Contadores de todas as tarefas do usuário (ignoram os filtros). */
export const COUNTS_SQL = `
  SELECT t.status, count(*)::int AS total,
         count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
         count(*) FILTER (WHERE ${OPEN_SQL} AND t.due_date = ${TODAY_SQL})::int AS due_today,
         count(*) FILTER (WHERE ${OPEN_SQL} AND t.assignee_kind = 'none')::int AS unconfirmed
    FROM tasks t WHERE t.owner_id = ${OWNER_PARAM} GROUP BY t.status`;
