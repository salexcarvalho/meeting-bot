import { TASK_STATUSES, TASK_STATUS_LABELS, type TaskCounts } from "@meeting-bot/contracts";
import { ALL_VALUE, OPEN_VALUE, type TaskFilterState } from "../../tasks";

/** Contadores clicáveis: cada um aplica o filtro correspondente (e `aria-pressed` diz qual está ativo). */
export function TaskCounters({
  counts,
  filters,
  onFilter,
}: Readonly<{ counts: TaskCounts | null; filters: TaskFilterState; onFilter: (patch: Partial<TaskFilterState>) => void }>) {
  const n = (value: number | undefined) => (counts ? String(value ?? 0) : "…");
  const reset: Partial<TaskFilterState> = { due: "", assignee: "", assigneeName: "" };
  const cards: { label: string; value: string; pressed: boolean; patch: Partial<TaskFilterState> }[] = [
    {
      label: "Abertas",
      value: n(counts?.open),
      pressed: filters.status === OPEN_VALUE && !filters.due && !filters.assignee,
      patch: { ...reset, status: OPEN_VALUE },
    },
    {
      label: "Atrasadas",
      value: n(counts?.overdue),
      pressed: filters.due === "overdue",
      patch: { ...reset, status: OPEN_VALUE, due: "overdue" },
    },
    {
      label: "Vencem hoje",
      value: n(counts?.dueToday),
      pressed: filters.due === "today",
      patch: { ...reset, status: OPEN_VALUE, due: "today" },
    },
    {
      label: "Sem responsável confirmado",
      value: n(counts?.unconfirmedAssignee),
      pressed: filters.assignee === "none",
      patch: { ...reset, status: OPEN_VALUE, assignee: "none" },
    },
  ];

  return (
    <div className="task-counters">
      <div className="task-counter-cards">
        {cards.map((c) => (
          <button key={c.label} type="button" className="task-counter" aria-pressed={c.pressed} onClick={() => onFilter(c.patch)}>
            <span className="task-counter-value">{c.value}</span>
            <span className="task-counter-label">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="task-status-tabs" role="group" aria-label="Filtrar por status">
        <button type="button" className="small" aria-pressed={filters.status === ALL_VALUE} onClick={() => onFilter({ status: ALL_VALUE })}>
          Todas
        </button>
        {TASK_STATUSES.map((s) => (
          <button key={s} type="button" className="small" aria-pressed={filters.status === s} onClick={() => onFilter({ status: s })}>
            {TASK_STATUS_LABELS[s]} ({n(counts?.byStatus[s])})
          </button>
        ))}
      </div>
    </div>
  );
}
