import { STATUS_LABELS, type MeetingListItem, type MeetingSummary } from "@meeting-bot/contracts";
import { botProgress, isBotActive } from "../bot/state";
import { isAgendaWorkingDay } from "../calendar/offDay";
import type { MeetingRow } from "../db";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toMeetingSummary(m: MeetingRow): MeetingSummary {
  return {
    id: m.id,
    title: m.title,
    platform: m.platform,
    url: m.url,
    status: m.status,
    statusLabel: STATUS_LABELS[m.status] ?? "Erro",
    source: m.source,
    scheduledStart: iso(m.scheduled_start),
    scheduledEnd: iso(m.scheduled_end),
    startedAt: iso(m.started_at),
    endedAt: iso(m.ended_at),
    project: m.project_id ? { id: m.project_id, name: m.project_name ?? "", suggested: m.project_suggested } : null,
    skipRecording: m.skip_recording,
    offDay: m.scheduled_start ? !isAgendaWorkingDay(m.scheduled_start) : false,
    autoOnOffDay: m.auto_on_off_day,
    itemsEnabled: m.extract_items,
    organizer: m.organizer,
    attendees: Array.isArray(m.attendees) ? m.attendees : [],
    errorMessage: m.error_message,
    botActive: isBotActive(m.id),
    botProgress: botProgress(m.id),
    botDisplayName: m.bot_display_name,
    createdBy: m.created_by_username,
    createdAt: m.created_at.toISOString(),
    seriesId: m.series_id,
    recurrence: m.recurrence_rule,
  };
}

/**
 * Item de lista por espectador. `m` vem de `meetingSelectFor(viewer)`. Estes campos dependem de quem
 * pergunta e por isso nunca entram em `toMeetingSummary` (difundido igual a todos pelo WebSocket).
 */
export function toMeetingListItem(m: MeetingRow, viewerId: string): MeetingListItem {
  const owner = m.created_by === viewerId;
  const sharedAccess = m.viewer_share_access === "edit" || m.viewer_share_access === "read" ? m.viewer_share_access : null;
  return {
    ...toMeetingSummary(m),
    access: owner ? "owner" : (sharedAccess ?? "read"),
    ownerName: owner ? null : (m.owner_name ?? m.created_by_username),
    shareCount: owner ? Number(m.share_count ?? 0) : null,
    shareUnseen: !owner && sharedAccess !== null && Boolean(m.share_unseen),
  };
}
