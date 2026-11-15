import { z } from "zod";
import { ITEM_TYPES, type ItemType, type ReviewStatus } from "./domain";

// Minhas pendências e tarefas (specs/002-pendencias-tarefas). A tarefa é pessoal: só o dono a vê e altera.

export const TASK_STATUSES = ["a_fazer", "em_andamento", "bloqueada", "concluida", "cancelada"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** "Aberta" = ainda precisa de ação. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["a_fazer", "em_andamento", "bloqueada"];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  a_fazer: "A fazer",
  em_andamento: "Em andamento",
  bloqueada: "Bloqueada",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

export const TASK_PRIORITIES = ["baixa", "media", "alta", "urgente"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  urgente: "Urgente",
};

export const ASSIGNEE_KINDS = ["self", "other", "none"] as const;
export type AssigneeKind = (typeof ASSIGNEE_KINDS)[number];

export const ASSIGNEE_LABELS: Record<AssigneeKind, string> = {
  self: "Eu",
  other: "Outra pessoa",
  none: "Responsável não confirmado",
};

export const TASK_ORIGINS = ["item_auto", "item_manual", "manual"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const TASK_ORIGIN_LABELS: Record<TaskOrigin, string> = {
  item_auto: "da reunião",
  item_manual: "da reunião",
  manual: "manual",
};

export const TASK_HISTORY_ACTIONS = ["created", "edited", "status_changed"] as const;
export type TaskHistoryAction = (typeof TASK_HISTORY_ACTIONS)[number];

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");

// Data civil válida (rejeita 2026-02-31), sem depender de regex sobre a entrada livre.
const civilDay = isoDay.refine((v) => {
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}, "data inválida");

export const TaskAssigneeInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("self") }),
  z.strictObject({ kind: z.literal("other"), name: z.string().trim().min(1, "Informe o nome.").max(120) }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type TaskAssigneeInput = z.infer<typeof TaskAssigneeInput>;

const titleField = z.string().trim().min(3, "O título precisa de ao menos 3 caracteres.").max(200);
const descriptionField = z.string().trim().max(4000);

export const TaskInput = z.strictObject({
  title: titleField,
  description: descriptionField.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: civilDay.nullish(),
  projectId: z.uuid().nullish(),
  meetingId: z.uuid().nullish(),
  assignee: TaskAssigneeInput.optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;

/** `meetingId` não muda depois de criada; `dueHint` só pode ser limpo (o texto dito vem do item). */
export const TaskPatch = z
  .strictObject({
    title: titleField,
    description: descriptionField,
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    dueDate: civilDay.nullable(),
    dueHint: z.null(),
    projectId: z.uuid().nullable(),
    assignee: TaskAssigneeInput,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Informe ao menos um campo.");
export type TaskPatch = z.infer<typeof TaskPatch>;

export const TASK_DUE_FILTERS = ["overdue", "today", "week", "month", "none", "range"] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

export const TASK_ASSIGNEE_FILTERS = ["me", "none", "other"] as const;
export type TaskAssigneeFilter = (typeof TASK_ASSIGNEE_FILTERS)[number];

export const TASK_SORTS = ["due", "priority", "updated", "created"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

/** Filtros de `GET /tasks`. Chegam como texto na query string. */
export const TaskQuery = z
  .strictObject({
    status: z
      .union([z.literal("open"), z.literal("all"), csv(TASK_STATUSES)])
      .default("open"),
    projectId: z.union([z.uuid(), z.literal("none")]).optional(),
    due: z.enum(TASK_DUE_FILTERS).optional(),
    dueFrom: civilDay.optional(),
    dueTo: civilDay.optional(),
    assignee: z.enum(TASK_ASSIGNEE_FILTERS).optional(),
    assigneeName: z.string().trim().min(1).max(120).optional(),
    priority: csv(TASK_PRIORITIES).optional(),
    meetingId: z.uuid().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(TASK_SORTS).default("due"),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => v.due !== "range" || (v.dueFrom !== undefined && v.dueTo !== undefined), {
    message: "informe dueFrom e dueTo",
    path: ["due"],
  });
export type TaskQuery = z.infer<typeof TaskQuery>;

export const TaskSourceSnapshot = z.object({
  meetingTitle: z.string().optional(),
  meetingDate: z.string().optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  itemDescription: z.string().optional(),
  itemOwner: z.string().nullable().optional(),
  itemDue: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  quoteStart: z.number().optional(),
  channel: z.enum(["mic", "remote", "mixed"]).optional(),
});
export type TaskSourceSnapshot = z.infer<typeof TaskSourceSnapshot>;

export const TaskFromItemInput = z.strictObject({
  itemId: z.uuid(),
  title: titleField.optional(),
  dueDate: civilDay.nullish(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: TaskAssigneeInput.optional(),
  force: z.boolean().optional(),
});
export type TaskFromItemInput = z.infer<typeof TaskFromItemInput>;

export interface TaskExternalRef {
  system: string;
  id: string;
  url: string | null;
  syncedAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** AAAA-MM-DD */
  dueDate: string | null;
  dueHint: string | null;
  overdue: boolean;
  assignee: { kind: AssigneeKind; name: string | null };
  project: { id: string; name: string } | null;
  /** nulo sem acesso atual à reunião ou reunião excluída */
  meeting: { id: string; title: string; scheduledStart: string | null } | null;
  /** nulo sem acesso atual, item excluído ou tarefa sem item */
  sourceItem: { id: string; type: ItemType; reviewStatus: ReviewStatus } | null;
  source: TaskSourceSnapshot | null;
  origin: TaskOrigin;
  externalRef: TaskExternalRef | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCounts {
  byStatus: Record<TaskStatus, number>;
  open: number;
  overdue: number;
  dueToday: number;
  unconfirmedAssignee: number;
}

export interface TaskHistoryEntry {
  id: number;
  action: TaskHistoryAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

export interface TaskRef {
  id: string;
  status: TaskStatus;
}

export type TaskNotice =
  | { kind: "possible_duplicate"; taskId: string }
  | { kind: "assignee_other"; name: string };

export interface TaskListResponse {
  tasks: Task[];
  total: number;
  counts: TaskCounts;
}

export interface TaskSummaryResponse {
  counts: TaskCounts;
  proposalsToReview: number;
}

/** Resposta de `POST /items/:itemId/approve` para quem tem `tasks.manage`: o item mais a tarefa criada. */
export interface ItemReviewTask {
  task: TaskRef | null;
  taskNotice?: TaskNotice;
}
