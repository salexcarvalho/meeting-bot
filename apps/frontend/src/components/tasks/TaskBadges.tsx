import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Flame, HelpCircle, Minus, type LucideIcon } from "lucide-react";
import { TASK_ORIGIN_LABELS, TASK_PRIORITY_LABELS, type Task, type TaskPriority } from "@meeting-bot/contracts";
import { formatDueDate, overdueText } from "../../tasks";

// Estados comunicados por texto e ícone, nunca só por cor (contracts/ui.md, acessibilidade).

const PRIORITY: Record<TaskPriority, { icon: LucideIcon; tone: string }> = {
  baixa: { icon: ArrowDown, tone: "neutral" },
  media: { icon: Minus, tone: "info" },
  alta: { icon: ArrowUp, tone: "warn" },
  urgente: { icon: Flame, tone: "error" },
};

export function PriorityBadge({ priority }: Readonly<{ priority: TaskPriority }>) {
  const { icon: Icon, tone } = PRIORITY[priority];
  return (
    <span className={`badge ${tone}`}>
      <Icon aria-hidden="true" size={12} /> {TASK_PRIORITY_LABELS[priority]}
    </span>
  );
}

export function OriginBadge({ origin }: Readonly<{ origin: Task["origin"] }>) {
  return <span className={`badge ${origin === "manual" ? "" : "primary"}`}>{TASK_ORIGIN_LABELS[origin]}</span>;
}

export function UnconfirmedBadge() {
  return (
    <span className="badge warn" title="O responsável não foi dito na reunião">
      <HelpCircle aria-hidden="true" size={12} /> Responsável não confirmado
    </span>
  );
}

/** Prazo: data, "atrasada há N dias" com ícone e, sem data, o prazo dito na reunião. */
export function DueCell({ task }: Readonly<{ task: Pick<Task, "dueDate" | "dueHint" | "overdue"> }>) {
  const late = overdueText(task);
  return (
    <span className="task-due">
      {task.dueDate && <span>{formatDueDate(task.dueDate)}</span>}
      {late && (
        <span className="badge error">
          <AlertTriangle aria-hidden="true" size={12} /> {late}
        </span>
      )}
      {!task.dueDate && task.dueHint && (
        <span className="muted small">
          <CalendarClock aria-hidden="true" size={12} /> dito: {task.dueHint}
        </span>
      )}
      {!task.dueDate && !task.dueHint && <span className="muted">—</span>}
    </span>
  );
}
