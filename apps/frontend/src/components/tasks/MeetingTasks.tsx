import { Link } from "react-router";
import { ListChecks, Plus } from "lucide-react";
import { TASK_STATUS_LABELS, type Task } from "@meeting-bot/contracts";
import { CardHead } from "../ui";
import { DueCell, PriorityBadge } from "./TaskBadges";

/** "Tarefas desta reunião": só as do próprio usuário, com atalho para criar uma já ligada à reunião. */
export function MeetingTasks({
  tasks,
  canManage,
  onNew,
}: Readonly<{ tasks: Task[]; canManage: boolean; onNew: () => void }>) {
  return (
    <section className="card" aria-label="Tarefas desta reunião">
      <CardHead
        title="Tarefas desta reunião"
        icon={ListChecks}
        actions={
          canManage ? (
            <button type="button" className="small" onClick={onNew}>
              <Plus aria-hidden="true" /> Nova tarefa
            </button>
          ) : undefined
        }
      />
      {tasks.length === 0 ? (
        <p className="muted small">Você ainda não tem tarefas ligadas a esta reunião.</p>
      ) : (
        <ul className="meeting-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link to={`/pendencias?tarefa=${t.id}`}>{t.title}</Link>
              <span className="badge">{TASK_STATUS_LABELS[t.status]}</span>
              <PriorityBadge priority={t.priority} />
              <DueCell task={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
