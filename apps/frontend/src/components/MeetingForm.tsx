import { useState, type FormEvent } from "react";
import type { MeetingSummary, Project } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { fromLocalInput, minutesBetween, toLocalInput } from "../format";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

export function MeetingForm({
  open,
  meeting,
  projects,
  onClose,
  onSaved,
}: {
  open: boolean;
  meeting?: MeetingSummary | null;
  projects: Project[];
  onClose: () => void;
  onSaved: (m: MeetingSummary) => void;
}) {
  const toast = useToast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = Boolean(meeting);
  const scheduleLocked =
    editing &&
    (!["ics", "manual"].includes(meeting!.source) || !["scheduled", "skipped", "missed", "cancelled"].includes(meeting!.status));
  const duration = minutesBetween(meeting?.scheduledStart ?? null, meeting?.scheduledEnd ?? null) ?? 60;
  const defaultStart = (() => {
    if (meeting?.scheduledStart) return toLocalInput(meeting.scheduledStart);
    const d = new Date(Date.now() + 5 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return toLocalInput(d.toISOString());
  })();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      title: String(form.get("title") ?? "").trim(),
      projectId: (form.get("projectId") as string) || null,
    };
    if (!scheduleLocked) {
      body.start = fromLocalInput(String(form.get("start")));
      body.durationMinutes = Number(form.get("duration"));
      body.url = String(form.get("url") ?? "").trim() || null;
    }
    setBusy(true);
    setError("");
    try {
      const saved = editing
        ? await api<MeetingSummary>(`/meetings/${meeting!.id}`, { method: "PATCH", json: body })
        : await api<MeetingSummary>("/meetings/scheduled", { method: "POST", json: body });
      toast(editing ? "Reunião atualizada." : "Reunião cadastrada.");
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label={editing ? "Editar reunião" : "Nova reunião"}>
      <form onSubmit={submit}>
        <h2>{editing ? "Editar reunião" : "Nova reunião"}</h2>
        <label>
          Título
          <input name="title" defaultValue={meeting?.title ?? ""} required maxLength={300} autoFocus />
        </label>
        <div className="grid-2">
          <label>
            Início
            <input name="start" type="datetime-local" defaultValue={defaultStart} required disabled={scheduleLocked} />
          </label>
          <label>
            Duração
            <select name="duration" defaultValue={String(DURATIONS.includes(duration) ? duration : 60)} disabled={scheduleLocked}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} min` : `${d / 60} h`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Link (Teams, Meet ou outro — opcional)
          <input
            name="url"
            type="url"
            placeholder="https://teams.microsoft.com/l/meetup-join/…"
            defaultValue={meeting?.url ?? ""}
            disabled={scheduleLocked}
          />
        </label>
        <label>
          Projeto
          <select name="projectId" defaultValue={meeting?.project?.id ?? ""}>
            <option value="">{editing ? "— sem projeto —" : "— sugerir pelo título —"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {scheduleLocked && (
          <p className="muted small">
            {["ics", "manual"].includes(meeting!.source)
              ? "Horário e link não mudam depois que a gravação começou."
              : "Horário e link só existem para reuniões da agenda."}
          </p>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy}>Salvar</button>
        </div>
      </form>
    </Dialog>
  );
}
