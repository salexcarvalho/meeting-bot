import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { Plus } from "lucide-react";
import type { Task, TaskCounts } from "@meeting-bot/contracts";
import { ApiError, errorMessage } from "../api";
import { TaskCounters } from "../components/tasks/TaskCounters";
import { TaskDialog } from "../components/tasks/TaskDialog";
import { TaskFilters, useMeetingOptions } from "../components/tasks/TaskFilters";
import { TaskList } from "../components/tasks/TaskList";
import { useToast } from "../components/Toast";
import { PageHeader } from "../components/ui";
import { useProjects } from "../hooks";
import { useCan } from "../session";
import { fetchTask, fetchTasks, hasActiveFilters, useTaskFilters } from "../tasks";

/** Minhas pendências: a lista única de tarefas pessoais (da reunião ou manuais), com filtros na URL. */
export function Pendencias() {
  const can = useCan();
  if (!can("tasks.read")) return <Navigate to="/" replace />;
  return <PendenciasPage canManage={can("tasks.manage")} />;
}

function PendenciasPage({ canManage }: Readonly<{ canManage: boolean }>) {
  const toast = useToast();
  const { filters, setFilters, clear, taskId, openTask } = useTaskFilters();
  const { projects } = useProjects();
  const meetings = useMeetingOptions();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<TaskCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [dialogTask, setDialogTask] = useState<Task | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const filterKey = JSON.stringify(filters);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // Carrega a primeira página ao abrir, ao mudar um filtro e depois de cada ação (reloadTick).
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchTasks(filters, 0, controller.signal)
      .then((r) => {
        setTasks(r.tasks);
        setTotal(r.total);
        setCounts(r.counts);
        setError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, reloadTick]);

  // Voltar o foco à janela atualiza (aprovar um item em outra aba).
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  // ?tarefa=<id> abre o diálogo da tarefa.
  useEffect(() => {
    if (!taskId) {
      setDialogTask(null);
      return;
    }
    const known = tasksRef.current?.find((t) => t.id === taskId);
    if (known) {
      setDialogTask(known);
      return;
    }
    let alive = true;
    fetchTask(taskId)
      .then((t) => alive && setDialogTask(t))
      .catch((err) => {
        if (!alive) return;
        toast(err instanceof ApiError && err.status === 404 ? "Tarefa não encontrada." : errorMessage(err), "error");
        openTask(null);
      });
    return () => {
      alive = false;
    };
  }, [taskId, openTask, toast]);

  async function loadMore() {
    if (!tasks) return;
    setLoadingMore(true);
    try {
      const r = await fetchTasks(filters, tasks.length);
      setTasks((current) => {
        const seen = new Set((current ?? []).map((t) => t.id));
        return [...(current ?? []), ...r.tasks.filter((t) => !seen.has(t.id))];
      });
      setTotal(r.total);
      setCounts(r.counts);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function changed(task: Task) {
    setTasks((list) => (list ? list.map((t) => (t.id === task.id ? task : t)) : list));
    reload();
  }

  function closeDialog() {
    setCreating(false);
    setDialogTask(null);
    openTask(null);
  }

  const active = hasActiveFilters(filters);
  return (
    <main className="container">
      <PageHeader
        title="Minhas pendências"
        description="Tarefas suas, vindas das reuniões que você aprovou ou criadas à mão. Só você as vê."
        actions={
          canManage && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" /> Nova tarefa
            </button>
          )
        }
      />
      <TaskCounters counts={counts} filters={filters} onFilter={setFilters} />
      <TaskFilters filters={filters} projects={projects} meetings={meetings} active={active} onChange={setFilters} onClear={clear} />
      <section className="card flush task-list-card" aria-label="Lista de tarefas" aria-busy={loading}>
        <TaskList
          tasks={tasks}
          loading={loading}
          error={error}
          filtersActive={active}
          hasMore={Boolean(tasks && tasks.length < total)}
          loadingMore={loadingMore}
          onRetry={reload}
          onClearFilters={clear}
          onMore={() => void loadMore()}
          onOpen={(t) => openTask(t.id)}
          onChanged={changed}
          onCreate={() => setCreating(true)}
        />
      </section>
      <TaskDialog
        open={creating || dialogTask !== null}
        task={dialogTask}
        projects={projects}
        meetings={meetings}
        onClose={closeDialog}
        onSaved={reload}
        onDeleted={reload}
      />
    </main>
  );
}
