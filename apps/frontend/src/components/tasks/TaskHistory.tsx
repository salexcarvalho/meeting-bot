import { useEffect, useState } from "react";
import {
  ASSIGNEE_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type AssigneeKind,
  type TaskHistoryEntry,
  type TaskPriority,
  type TaskStatus,
} from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { formatDateTime } from "../../format";
import { formatDueDate } from "../../tasks";

const ACTION: Record<TaskHistoryEntry["action"], { label: string; tone: string }> = {
  created: { label: "Criada", tone: "primary" },
  edited: { label: "Editada", tone: "info" },
  status_changed: { label: "Status alterado", tone: "ok" },
};

const FIELD: Record<string, string> = {
  title: "Título",
  description: "Descrição",
  status: "Status",
  priority: "Prioridade",
  dueDate: "Prazo",
  dueHint: "Prazo dito",
  projectId: "Projeto",
  assignee: "Responsável",
};

const EMPTY = "—";

function assigneeValue(value: unknown): string {
  const a = value as { kind?: AssigneeKind; name?: string | null } | null;
  if (!a?.kind) return EMPTY;
  return a.kind === "other" && a.name ? a.name : ASSIGNEE_LABELS[a.kind];
}

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (field === "status") return TASK_STATUS_LABELS[value as TaskStatus] ?? String(value);
  if (field === "priority") return TASK_PRIORITY_LABELS[value as TaskPriority] ?? String(value);
  if (field === "dueDate") return formatDueDate(String(value));
  if (field === "assignee") return assigneeValue(value);
  if (field === "projectId") return "alterado";
  return String(value);
}

function Changes({ entry }: Readonly<{ entry: TaskHistoryEntry }>) {
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  const fields = Object.keys(after).filter((k) => k in FIELD);
  if (entry.action === "created") {
    return <p className="history-facts">{typeof after.title === "string" ? after.title : ""}</p>;
  }
  return (
    <>
      {fields.map((field) => (
        <p key={field} className="history-change">
          <span className="history-field">{FIELD[field]}</span>
          <span className="history-old">{formatValue(field, before[field])}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only">para</span>
          <span>{formatValue(field, after[field])}</span>
        </p>
      ))}
    </>
  );
}

/** Linha do tempo da tarefa ("Prazo: 30/11 → 05/12 · autor · há 2 h"), no padrão do histórico de itens. */
export function TaskHistory({ taskId, version }: Readonly<{ taskId: string; version: string }>) {
  const [history, setHistory] = useState<TaskHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setHistory(null);
    setError("");
    api<{ history: TaskHistoryEntry[] }>(`/tasks/${taskId}/history`)
      .then((r) => setHistory(r.history))
      .catch((err) => setError(errorMessage(err)));
  }, [taskId, version]);

  return (
    <section aria-label="Histórico da tarefa">
      <h3>Histórico</h3>
      {error && <p className="error-text">{error}</p>}
      {!history && !error && <p className="muted">Carregando…</p>}
      {history && (
        <ol className="history">
          {history.map((h) => (
            <li key={h.id} className={`history-entry ${ACTION[h.action].tone}`}>
              <div className="history-head">
                <strong>{ACTION[h.action].label}</strong>
                <span className="history-when">
                  <time dateTime={h.createdAt}>{formatDateTime(h.createdAt)}</time> · {h.actor ? h.actor.name : "sistema"}
                </span>
              </div>
              <Changes entry={h} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
