import { useState } from "react";
import { Link } from "react-router";
import type { MeetingListItem, MeetingSummary } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { formatTime, recurrenceLabel } from "../format";
import { NoLinkBadge } from "./NoLinkBadge";
import { ShareBadge } from "./ShareBadge";
import { StatusBadge } from "./StatusBadge";
import { useToast } from "./Toast";
import { useCan } from "../session";

const PLATFORM: Record<string, string> = { teams: "Teams", meet: "Meet", other: "Link", upload: "Upload", none: "" };

// Dia sem agenda (fim de semana): sem lembrete nem gravação automática, a menos que o usuário peça.
function autoHint(meeting: MeetingSummary): string {
  if (meeting.offDay && !meeting.autoOnOffDay) return "dia sem agenda: sem lembrete nem gravação automática";
  return meeting.url ? "assistente entra no horário" : "sem link: não grava sozinho";
}

export function AgendaItem({
  meeting,
  onChange,
  onEdit,
  hostAgentOnline,
}: {
  meeting: MeetingListItem;
  onChange: (m: MeetingSummary) => void;
  onEdit: (m: MeetingListItem) => void;
  hostAgentOnline: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const can = useCan();
  // Na agenda, ações só nas próprias reuniões; compartilhadas se editam pela página da reunião.
  const manage = can("meetings.manage") && meeting.access === "owner";
  const local = manage && (meeting.source === "ics" || meeting.source === "manual");
  const start = meeting.scheduledStart ?? meeting.startedAt ?? meeting.createdAt;
  const end = meeting.scheduledEnd ?? meeting.endedAt;
  const canSkip = local && (meeting.status === "scheduled" || meeting.status === "skipped");
  // Com link, quem grava é o assistente; "Gravar agora" (PC) fica para reunião sem link.
  const canRecord = local && !meeting.url && ["scheduled", "skipped", "missed"].includes(meeting.status);
  const canSendAssistant =
    local && Boolean(meeting.url) && !meeting.botActive && ["scheduled", "skipped", "missed", "error"].includes(meeting.status);
  const canOffDay = local && meeting.offDay && (meeting.status === "scheduled" || meeting.status === "skipped");
  const canStop = manage && (meeting.status === "recording" || (meeting.botActive && meeting.status !== "stopping"));
  const canJoin = Boolean(meeting.url) && ["scheduled", "skipped", "recording", "missed"].includes(meeting.status);
  const canEdit = local && ["scheduled", "skipped", "missed", "cancelled"].includes(meeting.status);
  const canCancel = local && ["scheduled", "skipped", "missed"].includes(meeting.status);

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

  async function cancel(scope: "one" | "series") {
    if (scope === "series" && !window.confirm("Cancela esta e todas as próximas ocorrências desta série?")) return;
    setBusy(true);
    try {
      const result = await api<MeetingSummary[]>(`/meetings/${meeting.id}/cancel`, { method: "POST", json: { scope } });
      result.forEach(onChange);
      toast(scope === "series" ? `${result.length} reuniões canceladas.` : "Reunião cancelada.");
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
          <NoLinkBadge meeting={meeting} onFix={canEdit ? () => onEdit(meeting) : undefined} />
          {meeting.project && (
            <span className="badge" title={meeting.project.suggested ? "Sugerido pelo título" : undefined}>
              {meeting.project.name}
              {meeting.project.suggested ? " ?" : ""}
            </span>
          )}
          <ShareBadge access={meeting.access} ownerName={meeting.ownerName} shareCount={meeting.shareCount} shareUnseen={meeting.shareUnseen} />
          {meeting.recurrence && (
            <span className="badge" title="Reunião recorrente">
              {recurrenceLabel(meeting.recurrence)}
            </span>
          )}
          {PLATFORM[meeting.platform] && <span className="muted">{PLATFORM[meeting.platform]}</span>}
          {meeting.skipRecording && meeting.status !== "skipped" && <span className="muted">sem gravação</span>}
          {meeting.status === "scheduled" && !meeting.skipRecording && <span className="muted">{autoHint(meeting)}</span>}
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
        {canSendAssistant && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => act(`/meetings/${meeting.id}/assistant`, undefined, "Assistente a caminho da reunião.")}
          >
            {meeting.status === "error" ? "Enviar assistente de novo" : "Enviar assistente agora"}
          </button>
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
        {canOffDay && (
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => act(`/meetings/${meeting.id}/auto-off-day`, { enabled: !meeting.autoOnOffDay })}
          >
            {meeting.autoOnOffDay ? "Voltar ao padrão" : "Avisar e gravar neste dia"}
          </button>
        )}
        {canEdit && (
          <button type="button" className="small" onClick={() => onEdit(meeting)}>
            Editar
          </button>
        )}
        {canCancel && (
          <button type="button" className="small danger" disabled={busy} onClick={() => cancel("one")}>
            Cancelar
          </button>
        )}
        {canCancel && meeting.seriesId && (
          <button type="button" className="small danger" disabled={busy} onClick={() => cancel("series")}>
            Cancelar série
          </button>
        )}
      </div>
    </li>
  );
}
