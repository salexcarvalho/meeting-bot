import { useEffect, useState } from "react";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_STATUSES, TASK_STATUS_LABELS, type MeetingListItem, type Project } from "@meeting-bot/contracts";
import { api } from "../../api";
import { ALL_VALUE, OPEN_VALUE, type TaskFilterState } from "../../tasks";

const DEBOUNCE_MS = 300;
const MEETING_LIMIT = 200;

const DUE_OPTIONS: [string, string][] = [
  ["", "Qualquer prazo"],
  ["overdue", "Atrasadas"],
  ["today", "Vencem hoje"],
  ["week", "Esta semana"],
  ["month", "Este mês"],
  ["none", "Sem prazo"],
];

const ASSIGNEE_OPTIONS: [string, string][] = [
  ["", "Qualquer responsável"],
  ["me", "Eu"],
  ["none", "Não confirmado"],
  ["other", "Outra pessoa"],
];

const SORT_OPTIONS: [string, string][] = [
  ["due", "Prazo"],
  ["priority", "Prioridade"],
  ["updated", "Atualizadas"],
  ["created", "Criadas"],
];

/** Reuniões que o usuário vê (para filtrar e para ligar a tarefa a uma reunião). */
export function useMeetingOptions(): { id: string; title: string }[] {
  const [meetings, setMeetings] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ meetings: MeetingListItem[] }>(`/meetings?limit=${MEETING_LIMIT}`)
      .then((r) => alive && setMeetings(r.meetings.map((m) => ({ id: m.id, title: m.title }))))
      .catch(() => alive && setMeetings([]));
    return () => {
      alive = false;
    };
  }, []);
  return meetings;
}

function Options({ list }: Readonly<{ list: [string, string][] }>) {
  return (
    <>
      {list.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </>
  );
}

const STATUS_OPTIONS: [string, string][] = [
  [OPEN_VALUE, "Abertas"],
  [ALL_VALUE, "Todas"],
  ...TASK_STATUSES.map((s): [string, string] => [s, TASK_STATUS_LABELS[s]]),
];

const PRIORITY_OPTIONS: [string, string][] = [
  ["", "Qualquer prioridade"],
  ...TASK_PRIORITIES.map((p): [string, string] => [p, TASK_PRIORITY_LABELS[p]]),
];

export function TaskFilters({
  filters,
  projects,
  meetings,
  active,
  onChange,
  onClear,
}: Readonly<{
  filters: TaskFilterState;
  projects: Project[];
  meetings: { id: string; title: string }[];
  active: boolean;
  onChange: (patch: Partial<TaskFilterState>) => void;
  onClear: () => void;
}>) {
  const [text, setText] = useState(filters.q);
  const [name, setName] = useState(filters.assigneeName);

  useEffect(() => setText(filters.q), [filters.q]);
  useEffect(() => setName(filters.assigneeName), [filters.assigneeName]);

  useEffect(() => {
    if (text === filters.q) return;
    const timer = window.setTimeout(() => onChange({ q: text.trim() }), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, filters.q, onChange]);

  useEffect(() => {
    if (name === filters.assigneeName) return;
    const timer = window.setTimeout(() => onChange({ assigneeName: name.trim() }), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [name, filters.assigneeName, onChange]);

  return (
    <form className="task-filters" role="search" aria-label="Filtros de tarefas" onSubmit={(e) => e.preventDefault()}>
      <label>
        Buscar
        <input type="search" value={text} maxLength={100} placeholder="Título ou descrição" onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Status
        <select value={filters.status} onChange={(e) => onChange({ status: e.target.value })}>
          <Options list={STATUS_OPTIONS} />
        </select>
      </label>
      <label>
        Projeto
        <select value={filters.projectId} onChange={(e) => onChange({ projectId: e.target.value })}>
          <option value="">Todos os projetos</option>
          <option value="none">Sem projeto</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Prazo
        <select value={filters.due} onChange={(e) => onChange({ due: e.target.value })}>
          <Options list={DUE_OPTIONS} />
        </select>
      </label>
      <label>
        Responsável
        <select value={filters.assignee} onChange={(e) => onChange({ assignee: e.target.value, assigneeName: "" })}>
          <Options list={ASSIGNEE_OPTIONS} />
        </select>
      </label>
      {filters.assignee === "other" && (
        <label>
          Nome do responsável
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label>
        Prioridade
        <select value={filters.priority} onChange={(e) => onChange({ priority: e.target.value })}>
          <Options list={PRIORITY_OPTIONS} />
        </select>
      </label>
      <label>
        Reunião
        <select value={filters.meetingId} onChange={(e) => onChange({ meetingId: e.target.value })}>
          <option value="">Todas as reuniões</option>
          {meetings.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ordenar por
        <select value={filters.sort} onChange={(e) => onChange({ sort: e.target.value })}>
          <Options list={SORT_OPTIONS} />
        </select>
      </label>
      <div className="task-filters-actions">
        <button type="button" onClick={onClear} disabled={!active}>
          Limpar filtros
        </button>
      </div>
    </form>
  );
}
