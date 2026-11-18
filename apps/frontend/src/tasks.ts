import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import {
  ASSIGNEE_LABELS,
  TASK_ASSIGNEE_FILTERS,
  TASK_DUE_FILTERS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  type AssigneeKind,
  type Task,
  type TaskFromItemInput,
  type TaskListResponse,
  type TaskStatus,
  type TaskSummaryResponse,
} from "@meeting-bot/contracts";
import { api, ApiError } from "./api";
import { todayIso } from "./format";

// Cliente da API de tarefas e o estado dos filtros na URL (specs/002 contracts/ui.md). Tudo pessoal: o backend
// só devolve as tarefas do próprio usuário.

export const TASK_PAGE_SIZE = 100;
export const OPEN_VALUE = "open";
export const ALL_VALUE = "all";
const NONE_VALUE = "none";
const DEFAULT_SORT = "due";
const PRIORITY_KEYS = new Set<string>(TASK_PRIORITIES);
const STATUS_KEYS = new Set<string>(TASK_STATUSES);
const DUE_KEYS = new Set<string>(TASK_DUE_FILTERS.filter((d) => d !== "range"));
const ASSIGNEE_KEYS = new Set<string>(TASK_ASSIGNEE_FILTERS);
const SORT_KEYS = new Set<string>(TASK_SORTS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtros da lista, no vocabulário da API (`GET /tasks`). Vazio = sem filtro. */
export interface TaskFilterState {
  /** `open`, `all` ou lista de status separada por vírgula */
  status: string;
  /** uuid ou `none` */
  projectId: string;
  due: string;
  assignee: string;
  assigneeName: string;
  /** lista de prioridades separada por vírgula */
  priority: string;
  meetingId: string;
  q: string;
  sort: string;
}

export const DEFAULT_FILTERS: TaskFilterState = {
  status: OPEN_VALUE,
  projectId: "",
  due: "",
  assignee: "",
  assigneeName: "",
  priority: "",
  meetingId: "",
  q: "",
  sort: DEFAULT_SORT,
};

// Parâmetro da URL (em português) → campo do filtro.
const URL_KEYS: Record<keyof TaskFilterState, string> = {
  status: "status",
  projectId: "projeto",
  due: "prazo",
  assignee: "resp",
  assigneeName: "nome",
  priority: "prioridade",
  meetingId: "reuniao",
  q: "q",
  sort: "ordem",
};

function validList(raw: string, allowed: Set<string>): string {
  const list = raw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s));
  return [...new Set(list)].join(",");
}

function validStatus(raw: string): string {
  if (raw === OPEN_VALUE || raw === ALL_VALUE) return raw;
  return validList(raw, STATUS_KEYS) || OPEN_VALUE;
}

function oneOf(raw: string, allowed: Set<string>): string {
  return allowed.has(raw) ? raw : "";
}

/** Lê os filtros da URL; valor fora do conjunto é ignorado (nunca quebra a tela). */
export function parseFilters(params: URLSearchParams): TaskFilterState {
  const get = (field: keyof TaskFilterState) => (params.get(URL_KEYS[field]) ?? "").trim();
  const project = get("projectId");
  const meeting = get("meetingId");
  const assignee = oneOf(get("assignee"), ASSIGNEE_KEYS);
  return {
    status: validStatus(get("status") || OPEN_VALUE),
    projectId: project === NONE_VALUE || UUID.test(project) ? project : "",
    due: oneOf(get("due"), DUE_KEYS),
    assignee,
    assigneeName: assignee === "other" ? get("assigneeName").slice(0, 120) : "",
    priority: validList(get("priority"), PRIORITY_KEYS),
    meetingId: UUID.test(meeting) ? meeting : "",
    q: get("q").slice(0, 100),
    sort: oneOf(get("sort"), SORT_KEYS) || DEFAULT_SORT,
  };
}

/** Só o que difere do padrão vai para a URL. */
export function filtersToParams(filters: TaskFilterState, keep?: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const task = keep?.get("tarefa");
  if (task) out.set("tarefa", task);
  for (const field of Object.keys(URL_KEYS) as (keyof TaskFilterState)[]) {
    if (filters[field] && filters[field] !== DEFAULT_FILTERS[field]) out.set(URL_KEYS[field], filters[field]);
  }
  return out;
}

/** Filtros → query string da API. */
export function filtersToApiQuery(filters: TaskFilterState, offset = 0): string {
  const q = new URLSearchParams();
  for (const field of Object.keys(URL_KEYS) as (keyof TaskFilterState)[]) {
    if (filters[field]) q.set(field, filters[field]);
  }
  q.set("limit", String(TASK_PAGE_SIZE));
  q.set("offset", String(offset));
  return q.toString();
}

export function hasActiveFilters(filters: TaskFilterState): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof TaskFilterState)[]).some(
    (k) => k !== "sort" && filters[k] !== DEFAULT_FILTERS[k],
  );
}

export function useTaskFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const setFilters = useCallback(
    (patch: Partial<TaskFilterState>) => {
      setParams((prev) => filtersToParams({ ...parseFilters(prev), ...patch }, prev), { replace: true });
    },
    [setParams],
  );
  const clear = useCallback(() => setParams((prev) => filtersToParams(DEFAULT_FILTERS, prev), { replace: true }), [setParams]);
  const openTask = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set("tarefa", id);
          else next.delete("tarefa");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { filters, setFilters, clear, taskId: params.get("tarefa"), openTask };
}

// ---------- chamadas ----------

export const fetchTasks = (filters: TaskFilterState, offset = 0, signal?: AbortSignal) =>
  api<TaskListResponse>(`/tasks?${filtersToApiQuery(filters, offset)}`, { signal });

export const fetchTask = (id: string) => api<Task>(`/tasks/${id}`);

export const fetchTaskSummary = () => api<TaskSummaryResponse>("/tasks/summary");

export async function fetchMeetingTasks(meetingId: string): Promise<Task[]> {
  return (await api<{ tasks: Task[] }>(`/meetings/${meetingId}/tasks`)).tasks;
}

export const setTaskStatus = (id: string, status: TaskStatus) =>
  api<Task>(`/tasks/${id}/status`, { method: "POST", json: { status } });

export const createTaskFromItem = (input: TaskFromItemInput) =>
  api<{ task: Task; created: boolean }>("/tasks/from-item", { method: "POST", json: input });

/** 409 `possible_duplicate`: já existe tarefa parecida; o corpo traz `taskId`. */
export function duplicateTaskId(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.body.code !== "possible_duplicate") return null;
  return typeof err.body.taskId === "string" ? err.body.taskId : null;
}

// ---------- apresentação ----------

export const assigneeText = (a: Task["assignee"]): string => (a.kind === "other" && a.name ? a.name : ASSIGNEE_LABELS[a.kind]);

export const isOpenStatus = (s: TaskStatus) => s === "a_fazer" || s === "em_andamento" || s === "bloqueada";

/** Dias entre duas datas AAAA-MM-DD (positivo se `to` é depois de `from`). */
export function daysBetween(from: string, to: string): number {
  const ms = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export function formatDueDate(date: string | null): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

export function overdueText(task: Pick<Task, "dueDate" | "overdue">): string | null {
  if (!task.overdue || !task.dueDate) return null;
  const days = daysBetween(task.dueDate, todayIso());
  if (days <= 0) return "atrasada";
  return `atrasada há ${days} ${days === 1 ? "dia" : "dias"}`;
}

const TITLE_MAX = 120;

/** Sugestão de título para o diálogo "Virar tarefa" (o backend aplica a mesma regra se vier em branco). */
export function suggestTitle(description: string): string {
  const flat = description.split(/\s+/u).filter(Boolean).join(" ");
  const end = flat.search(/[.!?](?:\s|$)/u);
  let title = end >= 0 ? flat.slice(0, end) : flat;
  if (title.length < 3) title = flat;
  if (title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type AssigneeChoice = "auto" | AssigneeKind;

/** `dd/mm` ou `dd/mm/aaaa` do prazo dito → AAAA-MM-DD (o ano da referência, ou o seguinte se já passou). */
export function hintToDate(hint: string, reference: string): string | null {
  const m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/u.exec(hint);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3] ? Number(m[3]) : Number(reference.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const probe = new Date(`${date}T12:00:00Z`);
  const valid = month >= 1 && month <= 12 && probe.getUTCDate() === day;
  if (!valid) return null;
  return !m[3] && date < reference ? `${year + 1}-${pad(month)}-${pad(day)}` : date;
}
