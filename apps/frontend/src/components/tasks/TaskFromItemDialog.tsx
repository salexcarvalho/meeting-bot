import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  ASSIGNEE_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type Item,
  type Task,
  type TaskFromItemInput,
  type TaskPriority,
} from "@meeting-bot/contracts";
import { errorMessage } from "../../api";
import { createTaskFromItem, duplicateTaskId, suggestTitle, type AssigneeChoice } from "../../tasks";
import { Dialog } from "../Dialog";

const AUTO_LABEL = "Como está no item";
const CHOICES: AssigneeChoice[] = ["auto", "self", "other", "none"];

function choiceLabel(choice: AssigneeChoice): string {
  return choice === "auto" ? AUTO_LABEL : ASSIGNEE_LABELS[choice];
}

function buildInput(
  item: Item,
  f: { title: string; dueDate: string; priority: TaskPriority; assignee: AssigneeChoice; name: string },
  force: boolean,
): TaskFromItemInput {
  const input: TaskFromItemInput = { itemId: item.id, title: f.title.trim(), priority: f.priority };
  if (f.dueDate) input.dueDate = f.dueDate;
  if (f.assignee === "other") input.assignee = { kind: "other", name: f.name.trim() };
  else if (f.assignee === "self" || f.assignee === "none") input.assignee = { kind: f.assignee };
  if (force) input.force = true;
  return input;
}

function Form({
  item,
  onClose,
  onCreated,
}: Readonly<{ item: Item; onClose: () => void; onCreated: (task: Task, created: boolean) => void }>) {
  const [title, setTitle] = useState(() => suggestTitle(item.description));
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("media");
  const [assignee, setAssignee] = useState<AssigneeChoice>("auto");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [similar, setSimilar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(force: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await createTaskFromItem(buildInput(item, { title, dueDate, priority, assignee, name }, force));
      onCreated(r.task, r.created);
      onClose();
    } catch (err) {
      const taskId = duplicateTaskId(err);
      if (taskId) setSimilar(taskId);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(false);
  }

  return (
    <form onSubmit={submit} className="task-form">
      <h2>Virar tarefa</h2>
      <p className="item-quote">{item.description}</p>
      <label>
        Título
        <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} />
      </label>
      <div className="task-form-grid">
        <label>
          Prazo
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <span className="field-hint">
            {item.due ? `Prazo dito: ${item.due}. Em branco, o sistema interpreta o que for inequívoco.` : "Sem prazo no item."}
          </span>
        </label>
        <label>
          Prioridade
          <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>
          Responsável
          <select value={assignee} onChange={(e) => setAssignee(e.target.value as AssigneeChoice)}>
            {CHOICES.map((c) => (
              <option key={c} value={c}>{choiceLabel(c)}{c === "auto" && item.owner ? ` (${item.owner})` : ""}</option>
            ))}
          </select>
        </label>
        {assignee === "other" && (
          <label>
            Nome do responsável
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
        )}
      </div>
      {similar && (
        <div className="banner warn" role="alert">
          <p>
            Já existe uma tarefa parecida nesta reunião. <Link to={`/pendencias?tarefa=${similar}`}>Ver a tarefa parecida</Link>
          </p>
          <button type="button" disabled={busy} onClick={() => void send(true)}>
            Criar mesmo assim
          </button>
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancelar</button>
        <button className="primary" disabled={busy}>Criar tarefa</button>
      </div>
    </form>
  );
}

/** Confirmação de "Virar tarefa": campos derivados do item, editáveis; tarefa parecida pede confirmação. */
export function TaskFromItemDialog({
  item,
  onClose,
  onCreated,
}: Readonly<{ item: Item | null; onClose: () => void; onCreated: (task: Task, created: boolean) => void }>) {
  return (
    <Dialog open={item !== null} onClose={onClose} label="Virar tarefa" className="task-dialog">
      {item && <Form key={item.id} item={item} onClose={onClose} onCreated={onCreated} />}
    </Dialog>
  );
}
