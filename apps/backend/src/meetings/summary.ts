import { STATUS_LABELS, type MeetingSummary } from "@meeting-bot/contracts";
import { botProgress, isBotActive } from "../bot/state";
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
