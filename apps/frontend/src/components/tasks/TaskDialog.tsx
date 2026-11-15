import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  ASSIGNEE_KINDS,
  ASSIGNEE_LABELS,
  ITEM_TYPE_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type AssigneeKind,
  type Project,
  type Task,
  type TaskInput,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { formatClock, formatDateTime, todayIso } from "../../format";
import { hintToDate } from "../../tasks";
import { ConfirmDialog, Dialog } from "../Dialog";
import { TaskHistory } from "./TaskHistory";

const CHANNEL_TEXT = { mic: "microfone", remote: "canal remoto", mixed: "canal misto" } as const;

interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  projectId: string;
  meetingId: string;
  assignee: AssigneeKind;
  assigneeName: string;
}

function initialState(task: Task | null, meetingId: string | undefined): FormState {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? "a_fazer",
    priority: task?.priority ?? "media",
    dueDate: task?.dueDate ?? "",
    projectId: task?.project?.id ?? "",
    meetingId: task?.meeting?.id ?? meetingId ?? "",
    assignee: task?.assignee.kind ?? "self",
    assigneeName: task?.assignee.name ?? "",
  };
}

function assigneeInput(f: FormState): NonNullable<TaskInput["assignee"]> {
  if (f.assignee === "other") return { kind: "other", name: f.assigneeName.trim() };
  return f.assignee === "none" ? { kind: "none" } : { kind: "self" };
}

function toInput(f: FormState): TaskInput {
  return {
    title: f.title.trim(),
    description: f.description.trim(),
    status: f.status,
    priority: f.priority,
    dueDate: f.dueDate || null,
    projectId: f.projectId || null,
    meetingId: f.meetingId || null,
    assignee: assigneeInput(f),
  };
}

function toPatch(f: FormState, task: Task): TaskPatch {
  const patch: TaskPatch = {
    title: f.title.trim(),
    description: f.description.trim(),
    status: f.status,
    priority: f.priority,
    dueDate: f.dueDate || null,
    projectId: f.projectId || null,
    assignee: assigneeInput(f),
  };
  if (f.dueDate && task.dueHint) patch.dueHint = null;
  return patch;
}

function Origin({ task }: Readonly<{ task: Task }>) {
  const src = task.source;
  if (task.origin === "manual" && !src) return null;
  const quote = src?.quote;
  const itemState = task.sourceItem?.reviewStatus;
  return (
    <section className="task-origin" aria-label="Origem da tarefa">
      <h3>Origem</h3>
      {task.meeting ? (
        <p>
          Reunião: <Link to={`/reunioes/${task.meeting.id}`}>{task.meeting.title}</Link>
          {task.meeting.scheduledStart && <span className="muted"> · {formatDateTime(task.meeting.scheduledStart)}</span>}
        </p>
      ) : (
        <>
          {src?.meetingTitle && <p>Reunião: {src.meetingTitle}</p>}
          <p className="muted small">Você não tem mais acesso à reunião. Só o que foi copiado enquanto havia acesso permanece.</p>
        </>
      )}
      {src?.itemType && <p>Tipo do item: {ITEM_TYPE_LABELS[src.itemType]}</p>}
      {src && quote && (
        <p className="item-quote">
          “{quote}”
          {src.quoteStart !== undefined && (
            <span className="muted"> ({formatClock(src.quoteStart)}{src.channel ? `, ${CHANNEL_TEXT[src.channel]}` : ""})</span>
          )}
        </p>
      )}
      {itemState && itemState !== "aprovado" && (
        <p className="banner warn small">O item de origem está {itemState === "proposto" ? "reaberto" : "rejeitado"}.</p>
      )}
    </section>
  );
}

function Fields({
  form,
  set,
  task,
  projects,
  meetings,
  onUseHint,
}: Readonly<{
  form: FormState;
  set: (patch: Partial<FormState>) => void;
  task: Task | null;
  projects: Project[];
  meetings: { id: string; title: string }[];
  onUseHint: () => void;
}>) {
  return (
    <>
      <label>
        Título
        <input value={form.title} onChange={(e) => set({ title: e.target.value })} required minLength={3} maxLength={200} />
      </label>
      <label>
        Descrição
        <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} rows={3} />
      </label>
      <div className="task-form-grid">
        <label>
          Status
          <select value={form.status} onChange={(e) => set({ status: e.target.value as TaskStatus })}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label>
          Prioridade
          <select value={form.priority} onChange={(e) => set({ priority: e.target.value as TaskPriority })}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>
          Prazo
          <input type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
          {task?.dueHint && (
            <span className="field-hint">
              Prazo dito: {task.dueHint}{" "}
              {!form.dueDate && (
                <button type="button" className="link" onClick={onUseHint}>
                  Usar como prazo
                </button>
              )}
            </span>
          )}
        </label>
        <label>
          Projeto
          <select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">Sem projeto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {!task && (
          <label>
            Reunião
            <select value={form.meetingId} onChange={(e) => set({ meetingId: e.target.value })}>
              <option value="">Sem reunião</option>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>{m.title}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Responsável
          <select value={form.assignee} onChange={(e) => set({ assignee: e.target.value as AssigneeKind })}>
            {ASSIGNEE_KINDS.map((k) => (
              <option key={k} value={k}>{ASSIGNEE_LABELS[k]}</option>
            ))}
          </select>
        </label>
        {form.assignee === "other" && (
          <label>
            Nome do responsável
            <input value={form.assigneeName} onChange={(e) => set({ assigneeName: e.target.value })} required maxLength={120} />
          </label>
        )}
      </div>
    </>
  );
}

function TaskForm({
  task,
  meetingId,
  projects,
  meetings,
  onClose,
  onSaved,
  onDeleted,
}: Readonly<{
  task: Task | null;
  meetingId?: string;
  projects: Project[];
  meetings: { id: string; title: string }[];
  onClose: () => void;
  onSaved: (task: Task) => void;
  onDeleted: () => void;
}>) {
  const [form, setForm] = useState(() => initialState(task, meetingId));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [version, setVersion] = useState(0);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  function applyHint() {
    const date = task?.dueHint ? hintToDate(task.dueHint, todayIso()) : null;
    if (date) set({ dueDate: date });
    else setError("Não deu para entender o prazo dito. Escolha a data no campo Prazo.");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = task
        ? await api<Task>(`/tasks/${task.id}`, { method: "PATCH", json: toPatch(form, task) })
        : await api<Task>("/tasks", { method: "POST", json: toInput(form) });
      onSaved(saved);
      setVersion((v) => v + 1);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!task) return;
    try {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} className="task-form">
      <h2>{task ? "Editar tarefa" : "Nova tarefa"}</h2>
      <Fields form={form} set={set} task={task} projects={projects} meetings={meetings} onUseHint={applyHint} />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        {task && (
          <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
            Excluir
          </button>
        )}
        <button type="button" onClick={onClose}>Cancelar</button>
        <button className="primary" disabled={busy}>{task ? "Salvar" : "Criar tarefa"}</button>
      </div>
      {task && <Origin task={task} />}
      {task && <TaskHistory taskId={task.id} version={`${task.updatedAt}:${version}`} />}
      <ConfirmDialog
        open={confirmDelete}
        title="Excluir tarefa?"
        message="A tarefa e o histórico dela serão apagados. O item da reunião de origem continua como está."
        confirmLabel="Sim, excluir"
        danger
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </form>
  );
}

/** Criar (task = null) e editar tarefa. O formulário nasce de novo a cada abertura. */
export function TaskDialog({
  open,
  task,
  meetingId,
  projects,
  meetings,
  onClose,
  onSaved,
  onDeleted,
}: Readonly<{
  open: boolean;
  task: Task | null;
  meetingId?: string;
  projects: Project[];
  meetings: { id: string; title: string }[];
  onClose: () => void;
  onSaved: (task: Task) => void;
  onDeleted: () => void;
}>) {
  return (
    <Dialog open={open} onClose={onClose} label={task ? "Editar tarefa" : "Nova tarefa"} className="task-dialog">
      <TaskForm
        key={task?.id ?? "nova"}
        task={task}
        meetingId={meetingId}
        projects={projects}
        meetings={meetings}
        onClose={onClose}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </Dialog>
  );
}
