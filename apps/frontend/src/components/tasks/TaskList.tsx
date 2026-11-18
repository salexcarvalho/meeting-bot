import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ListChecks } from "lucide-react";
import type { Task } from "@meeting-bot/contracts";
import { assigneeText } from "../../tasks";
import { EmptyState, SkeletonLines } from "../ui";
import { DueCell, OriginBadge, PriorityBadge, UnconfirmedBadge } from "./TaskBadges";
import { TaskStatusSelect } from "./TaskStatusSelect";

const NARROW_QUERY = "(max-width: 639px)";

/** Abaixo de 640 px a lista vira cartões; só um dos dois layouts existe no DOM. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function Assignee({ task }: Readonly<{ task: Task }>) {
  if (task.assignee.kind === "none") return <UnconfirmedBadge />;
  return <span>{assigneeText(task.assignee)}</span>;
}

function Context({ task }: Readonly<{ task: Task }>) {
  const parts = [task.project?.name].filter(Boolean);
  return (
    <span className="task-context small muted">
      {parts.join(" · ")}
      {task.meeting && (
        <>
          {parts.length > 0 && " · "}
          <Link to={`/reunioes/${task.meeting.id}`}>{task.meeting.title}</Link>
        </>
      )}
      {!task.meeting && task.source?.meetingTitle && (
        <>
          {parts.length > 0 && " · "}
          {task.source.meetingTitle}
        </>
      )}
    </span>
  );
}

function TitleButton({ task, onOpen }: Readonly<{ task: Task; onOpen: (task: Task) => void }>) {
  return (
    <button type="button" className="link task-title" onClick={() => onOpen(task)}>
      {task.title}
    </button>
  );
}

function Table({ tasks, onOpen, onChanged }: Readonly<{ tasks: Task[]; onOpen: (t: Task) => void; onChanged: (t: Task) => void }>) {
  return (
    <div className="table-wrap">
      <table className="simple task-table">
        <thead>
          <tr>
            <th scope="col">Tarefa</th>
            <th scope="col">Status</th>
            <th scope="col">Prioridade</th>
            <th scope="col">Prazo</th>
            <th scope="col">Responsável</th>
            <th scope="col">Origem</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className={`task-row ${t.status}`}>
              <td>
                <TitleButton task={t} onOpen={onOpen} />
                <Context task={t} />
              </td>
              <td>
                <TaskStatusSelect task={t} onChanged={onChanged} />
              </td>
              <td>
                <PriorityBadge priority={t.priority} />
              </td>
              <td>
                <DueCell task={t} />
              </td>
              <td>
                <Assignee task={t} />
              </td>
              <td>
                <OriginBadge origin={t.origin} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ tasks, onOpen, onChanged }: Readonly<{ tasks: Task[]; onOpen: (t: Task) => void; onChanged: (t: Task) => void }>) {
  return (
    <ul className="task-cards">
      {tasks.map((t) => (
        <li key={t.id} className={`task-card ${t.status}`}>
          <TitleButton task={t} onOpen={onOpen} />
          <Context task={t} />
          <div className="task-card-meta">
            <PriorityBadge priority={t.priority} />
            <DueCell task={t} />
            <Assignee task={t} />
            <OriginBadge origin={t.origin} />
          </div>
          <TaskStatusSelect task={t} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

export function TaskList({
  tasks,
  loading,
  error,
  filtersActive,
  hasMore,
  loadingMore,
  onRetry,
  onClearFilters,
  onMore,
  onOpen,
  onChanged,
  onCreate,
}: Readonly<{
  tasks: Task[] | null;
  loading: boolean;
  error: string;
  filtersActive: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onMore: () => void;
  onOpen: (task: Task) => void;
  onChanged: (task: Task) => void;
  onCreate: () => void;
}>) {
  const narrow = useNarrow();

  if (error && !tasks?.length) {
    return (
      <div className="banner error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          Tentar de novo
        </button>
      </div>
    );
  }
  if (!tasks || (loading && !tasks.length)) return <SkeletonLines lines={5} />;
  if (!tasks.length) {
    return filtersActive ? (
      <EmptyState icon={ListChecks} title="Nenhuma tarefa com estes filtros" action={<button type="button" onClick={onClearFilters}>Remover filtros</button>} />
    ) : (
      <EmptyState icon={ListChecks} title="Você ainda não tem tarefas" action={<button type="button" className="primary" onClick={onCreate}>Nova tarefa</button>}>
        Aprove uma pendência numa reunião ou use Virar tarefa em qualquer item aprovado. Você também pode criar uma tarefa
        manualmente.
      </EmptyState>
    );
  }
  const View = narrow ? Cards : Table;
  return (
    <>
      {error && (
        <div className="banner error" role="alert">
          {error}{" "}
          <button type="button" className="small" onClick={onRetry}>
            Tentar de novo
          </button>
        </div>
      )}
      <View tasks={tasks} onOpen={onOpen} onChanged={onChanged} />
      {hasMore && (
        <div className="task-more">
          <button type="button" onClick={onMore} disabled={loadingMore}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </>
  );
}
