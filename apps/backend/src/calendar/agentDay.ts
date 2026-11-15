import type { AgentDayMeeting, AgentMeetingsResponse } from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";
import { dayRange, todayIn } from "./rules";

// Leitura da agenda de um dia para o agente externo (GET /api/agent/meetings). Só consulta: nada é gravado,
// e o escopo é o mesmo do heartbeat e da importação (reuniões agendadas do dono do agente).

export interface AgentDayRow {
  id: string;
  ical_uid: string | null;
  title: string;
  scheduled_start: Date;
  scheduled_end: Date;
  url: string | null;
  platform: AgentDayMeeting["platform"] | "none";
  skip_recording: boolean;
  status: AgentDayMeeting["status"];
  recurring: boolean;
}

export function toAgentDayMeeting(r: AgentDayRow): AgentDayMeeting {
  return {
    id: r.id,
    icalUid: r.ical_uid,
    title: r.title,
    start: r.scheduled_start.toISOString(),
    end: r.scheduled_end.toISOString(),
    url: r.url,
    platform: r.platform === "none" ? null : r.platform,
    skipRecording: r.skip_recording,
    status: r.status,
    recurring: r.recurring,
  };
}

/** Reuniões agendadas (`ics`/`manual`) do dono que começam em `date` (AAAA-MM-DD, fuso da aplicação; padrão hoje). */
export async function agentDayMeetings(ownerId: string, date?: string): Promise<AgentMeetingsResponse> {
  const day = date ?? todayIn(config.appTimezone);
  const { start, end } = dayRange(day, config.appTimezone);
  const { rows } = await pool.query<AgentDayRow>(
    `SELECT id, ical_uid, title, scheduled_start, scheduled_end, url, platform, skip_recording, status,
            (recurrence_key <> '' OR series_id IS NOT NULL) AS recurring
     FROM meetings
     WHERE source IN ('ics', 'manual') AND created_by = $1
       AND scheduled_start >= $2 AND scheduled_start < $3
     ORDER BY scheduled_start, created_at`,
    [ownerId, start, end],
  );
  return { date: day, meetings: rows.map(toAgentDayMeeting) };
}
