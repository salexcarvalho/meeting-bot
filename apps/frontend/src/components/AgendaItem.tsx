import { useState } from "react";
import { Link } from "react-router";
import type { MeetingSummary } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { formatTime } from "../format";
import { StatusBadge } from "./StatusBadge";
import { useToast } from "./Toast";
import { useCan, useSession } from "../session";

const PLATFORM: Record<string, string> = { teams: "Teams", meet: "Meet", other: "Link", upload: "Upload", none: "" };

export function AgendaItem({
  meeting,
  onChange,
  onEdit,
  hostAgentOnline,
}: {
  meeting: MeetingSummary;
  onChange: (m: MeetingSummary) => void;
  onEdit: (m: MeetingSummary) => void;
  hostAgentOnline: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const can = useCan();
  const { user } = useSession();
  // Na agenda, ações só nas próprias reuniões; compartilhadas se editam pela página da reunião.
  const manage = can("meetings.manage") && meeting.createdBy === user.username;
  const local = manage && (meeting.source === "ics" || meeting.source === "manual");
  const start = meeting.scheduledStart ?? meeting.startedAt ?? meeting.createdAt;
  const end = meeting.scheduledEnd ?? meeting.endedAt;
  const canSkip = local && (meeting.status === "scheduled" || meeting.status === "skipped");
  const canRecord = local && ["scheduled", "skipped", "missed"].includes(meeting.status);
  const canStop = manage && (meeting.status === "recording" || (meeting.botActive && meeting.status !== "stopping"));
  const canJoin = Boolean(meeting.url) && ["scheduled", "skipped", "recording", "missed"].includes(meeting.status);
  const canEdit = local && ["scheduled", "skipped", "missed", "cancelled"].includes(meeting.status);

  async function act(path: string, json?: unknown, message?: string) {
    setBusy(true);
    try {
      const result = await api<MeetingSummary | { status: string }>(path, { method: "POST", json });
      if ("id" in result) onChange(result);
      if (message) toast(message);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="agenda-item">
      <div className="agenda-time">
        {formatTime(start)}
        {end && <span className="muted">até {formatTime(end)}</span>}
      </div>
      <div style={{ minWidth: 0 }}>
        <Link className="agenda-title" to={`/reunioes/${meeting.id}`}>
          {meeting.title}
        </Link>
        <div className="row small" style={{ marginTop: 4 }}>
          <StatusBadge status={meeting.status} label={meeting.statusLabel} />
          {meeting.project && (
            <span className="badge" title={meeting.project.suggested ? "Sugerido pelo título" : undefined}>
              {meeting.project.name}
              {meeting.project.suggested ? " ?" : ""}
            </span>
          )}
          {PLATFORM[meeting.platform] && <span className="muted">{PLATFORM[meeting.platform]}</span>}
          {meeting.skipRecording && meeting.status !== "skipped" && <span className="muted">sem gravação</span>}
          {meeting.organizer && <span className="muted">org.: {meeting.organizer}</span>}
          {meeting.attendees.length > 0 && <span className="muted">{meeting.attendees.length} participante(s)</span>}
        </div>
        {meeting.errorMessage && <div className="small error-text">{meeting.errorMessage}</div>}
      </div>
      <div className="agenda-actions">
        {canJoin && (
          <a className="button small primary" href={meeting.url!} target="_blank" rel="noopener noreferrer">
            Entrar
          </a>
        )}
        {canRecord && (
          <button
            type="button"
            className="small"
            disabled={busy || !hostAgentOnline}
            title={hostAgentOnline ? undefined : "O agente do desktop está offline"}
            onClick={() => act(`/meetings/${meeting.id}/record`, undefined, "Gravação iniciada.")}
          >
            Gravar agora
          </button>
        )}
        {canStop && (
          <button type="button" className="small danger" disabled={busy} onClick={() => act(`/meetings/${meeting.id}/end`, undefined, "Encerrando gravação…")}>
            Parar
          </button>
        )}
        {canSkip && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => act(`/meetings/${meeting.id}/skip`, { skip: meeting.status !== "skipped" })}
          >
            {meeting.status === "skipped" ? "Gravar no horário" : "Não gravar"}
          </button>
        )}
        {canEdit && (
          <button type="button" className="small" onClick={() => onEdit(meeting)}>
            Editar
          </button>
        )}
      </div>
    </li>
  );
}
