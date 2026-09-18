import type {
  AgendaResponse,
  ImportResult,
  Platform,
  ScheduledMeetingInput,
  ScheduledMeetingPatch,
} from "@meeting-bot/contracts";
import { visibleMeetingsSql } from "../authz";
import { config } from "../config";
import { emitMeetingChanged, getMeeting, meetingSelect, MeetingRow, pool, withTransaction } from "../db";
import { toMeetingSummary } from "../meetings/summary";
import { hostAgentStatusFor } from "../recording/hostAgentState";
import type { User } from "../types";
import { detectMeetingUrl, parseIcs, type Occurrence } from "./ics";
import { dayRange, decideUpsert, EDITABLE_STATUSES, localMidnight, suggestProject, todayIn } from "./rules";

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  keywords: string[];
}

async function listProjectMatchers(): Promise<ProjectRow[]> {
  const { rows } = await pool.query(`SELECT id, name, keywords FROM projects ORDER BY name`);
  return rows;
}

export function importRange(now = new Date()): { from: Date; to: Date } {
  const today = todayIn(config.appTimezone, now);
  const [y, m, d] = today.split("-").map(Number);
  const iso = (days: number) => new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return { from: localMidnight(iso(-1), config.appTimezone), to: localMidnight(iso(31), config.appTimezone) };
}

function sameData(row: MeetingRow, o: Occurrence): boolean {
  return (
    row.title === o.title &&
    row.scheduled_start?.getTime() === o.start.getTime() &&
    row.scheduled_end?.getTime() === o.end.getTime() &&
    (row.url ?? null) === o.url &&
    (row.organizer ?? null) === o.organizer &&
    (row.location ?? null) === o.location &&
    (row.description ?? null) === o.description &&
    JSON.stringify(row.attendees ?? []) === JSON.stringify(o.attendees)
  );
}

export async function importIcs(files: { name: string; text: string }[], userId: string): Promise<ImportResult> {
  const result: ImportResult = {
    created: 0, updated: 0, cancelled: 0, unchanged: 0, ignored: 0, partialSeries: [], errors: [],
  };
  const projects = await listProjectMatchers();
  const range = importRange();
  const now = Date.now();
  const touched = new Set<string>();
  const partialSeries = new Set<string>();

  for (const file of files) {
    let parsed;
    try {
      parsed = parseIcs(file.text, range);
    } catch (err) {
      result.errors.push({ file: file.name, message: (err as Error).message });
      continue;
    }
    result.ignored += parsed.ignored;
    parsed.partialSeries.forEach((title) => partialSeries.add(title));

    await withTransaction(async (client) => {
      for (const o of parsed.occurrences) {
        if (o.cancelsSeries) {
          const { rows } = await client.query(
            `UPDATE meetings SET status = 'cancelled', ical_sequence = GREATEST(ical_sequence, $2)
             WHERE ical_uid = $1 AND created_by = $4 AND status = ANY($3) AND status <> 'cancelled' RETURNING id`,
            [o.uid, o.sequence, EDITABLE_STATUSES, userId],
          );
          result.cancelled += rows.length;
          rows.forEach((r) => touched.add(r.id));
          continue;
        }

        const { rows } = await client.query(
          `${meetingSelect} WHERE m.ical_uid = $1 AND m.recurrence_key = $2 AND m.created_by = $3 FOR UPDATE OF m`,
          [o.uid, o.recurrenceKey, userId],
        );
        const existing = (rows[0] as MeetingRow | undefined) ?? null;
        const decision = decideUpsert(
          existing && { status: existing.status, ical_sequence: existing.ical_sequence, changed: !sameData(existing, o) },
          { sequence: o.sequence, cancelled: o.cancelled },
        );

        const ended = o.end.getTime() <= now;
        if (decision === "create") {
          const project = suggestProject(o.title, projects);
          const { rows: created } = await client.query(
            `INSERT INTO meetings (title, platform, url, status, created_by, source, scheduled_start, scheduled_end,
               organizer, attendees, description, location, ical_uid, recurrence_key, ical_sequence,
               project_id, project_suggested)
             VALUES ($1, $2, $3, $4, $5, 'ics', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
            [
              o.title, o.platform, o.url, ended ? "missed" : "scheduled", userId, o.start, o.end,
              o.organizer, JSON.stringify(o.attendees), o.description, o.location, o.uid, o.recurrenceKey,
              o.sequence, project?.id ?? null, Boolean(project),
            ],
          );
          touched.add(created[0].id);
          result.created++;
        } else if (decision === "update" && existing) {
          const status =
            existing.status === "skipped" ? "skipped" : ended ? "missed" : "scheduled";
          await client.query(
            `UPDATE meetings SET title = $2, platform = $3, url = $4, status = $5, scheduled_start = $6,
               scheduled_end = $7, organizer = $8, attendees = $9, description = $10, location = $11,
               ical_sequence = $12
             WHERE id = $1`,
            [
              existing.id, o.title, o.platform, o.url, status, o.start, o.end, o.organizer,
              JSON.stringify(o.attendees), o.description, o.location, o.sequence,
            ],
          );
          touched.add(existing.id);
          result.updated++;
        } else if (decision === "cancel" && existing) {
          await client.query(`UPDATE meetings SET status = 'cancelled', ical_sequence = $2 WHERE id = $1`, [
            existing.id,
            o.sequence,
          ]);
          touched.add(existing.id);
          result.cancelled++;
        } else if (decision === "ignore") {
          result.ignored++;
        } else {
          result.unchanged++;
        }
      }
    }).catch((err) => {
      result.errors.push({ file: file.name, message: `Falha ao salvar: ${(err as Error).message}` });
    });
  }

  touched.forEach(emitMeetingChanged);
  result.partialSeries = [...partialSeries].slice(0, 10);
  return result;
}

export async function getAgenda(date: string, user: User): Promise<AgendaResponse> {
  const { start, end } = dayRange(date, config.appTimezone);
  const { rows } = await pool.query(
    `${meetingSelect}
     WHERE COALESCE(m.scheduled_start, m.started_at, m.created_at) >= $1
       AND COALESCE(m.scheduled_start, m.started_at, m.created_at) < $2
       AND ${visibleMeetingsSql(user, "m", 3)}
     ORDER BY COALESCE(m.scheduled_start, m.started_at, m.created_at), m.created_at`,
    [start, end, user.id],
  );
  const { rows: rec } = await pool.query(
    `SELECT m.id FROM meetings m
      WHERE m.status IN ('recording', 'stopping') AND m.source IN ('ics', 'manual')
        AND ${visibleMeetingsSql(user, "m", 1)}
      LIMIT 1`,
    [user.id],
  );
  return {
    date,
    timezone: config.appTimezone,
    meetings: (rows as MeetingRow[]).map(toMeetingSummary),
    hostAgent: await hostAgentStatusFor(user),
    recordingMeetingId: rec[0]?.id ?? null,
  };
}

function normalizeUrl(raw: string | null | undefined): { url: string | null; platform: Platform } {
  const value = raw?.trim();
  if (!value) return { url: null, platform: "none" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CalendarError("Link inválido.");
  }
  if (parsed.protocol !== "https:") throw new CalendarError("Use um link https.");
  const found = detectMeetingUrl(parsed.toString());
  return found ?? { url: parsed.toString(), platform: "other" };
}

async function assertProject(projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const { rowCount } = await pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if (!rowCount) throw new CalendarError("Projeto não encontrado.");
}

export async function createScheduled(input: ScheduledMeetingInput, userId: string): Promise<MeetingRow> {
  const { url, platform } = normalizeUrl(input.url);
  await assertProject(input.projectId);
  const start = new Date(input.start);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  let projectId = input.projectId ?? null;
  let suggested = false;
  if (!projectId) {
    const match = suggestProject(input.title, await listProjectMatchers());
    projectId = match?.id ?? null;
    suggested = Boolean(match);
  }
  const { rows } = await pool.query(
    `INSERT INTO meetings (title, platform, url, status, created_by, source, scheduled_start, scheduled_end,
       project_id, project_suggested)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9) RETURNING id`,
    [input.title, platform, url, end.getTime() <= Date.now() ? "missed" : "scheduled", userId, start, end, projectId, suggested],
  );
  emitMeetingChanged(rows[0].id);
  return (await getMeeting(rows[0].id))!;
}

export async function updateScheduled(id: string, patch: ScheduledMeetingPatch): Promise<MeetingRow> {
  const meeting = await getMeeting(id);
  if (!meeting) throw new CalendarError("Reunião não encontrada.", 404);
  const sets: string[] = [];
  const values: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.title !== undefined) set("title", patch.title);
  if (patch.projectId !== undefined) {
    await assertProject(patch.projectId);
    set("project_id", patch.projectId);
    set("project_suggested", false);
  }

  const touchesSchedule = patch.start !== undefined || patch.durationMinutes !== undefined || patch.url !== undefined;
  if (touchesSchedule) {
    if (!["ics", "manual"].includes(meeting.source) || !EDITABLE_STATUSES.includes(meeting.status)) {
      throw new CalendarError("Horário e link só podem mudar antes da gravação.", 409);
    }
    if (patch.url !== undefined) {
      const { url, platform } = normalizeUrl(patch.url);
      set("url", url);
      set("platform", platform);
    }
    if (patch.start !== undefined || patch.durationMinutes !== undefined) {
      const start = patch.start ? new Date(patch.start) : meeting.scheduled_start;
      if (!start) throw new CalendarError("Informe o início.");
      const currentDuration =
        meeting.scheduled_start && meeting.scheduled_end
          ? Math.round((meeting.scheduled_end.getTime() - meeting.scheduled_start.getTime()) / 60_000)
          : 60;
      const end = new Date(start.getTime() + (patch.durationMinutes ?? currentDuration) * 60_000);
      set("scheduled_start", start);
      set("scheduled_end", end);
      if (meeting.status === "missed" && end.getTime() > Date.now()) set("status", "scheduled");
      if (meeting.status === "scheduled" && end.getTime() <= Date.now()) set("status", "missed");
    }
  }

  if (sets.length) {
    await pool.query(`UPDATE meetings SET ${sets.join(", ")} WHERE id = $1`, values);
    emitMeetingChanged(id);
  }
  return (await getMeeting(id))!;
}

export async function setSkip(id: string, skip: boolean): Promise<MeetingRow> {
  const meeting = await getMeeting(id);
  if (!meeting) throw new CalendarError("Reunião não encontrada.", 404);
  if (!["scheduled", "skipped", "missed"].includes(meeting.status)) {
    throw new CalendarError("Não é possível mudar a gravação desta reunião agora.", 409);
  }
  const ended = (meeting.scheduled_end?.getTime() ?? 0) <= Date.now();
  const status = skip ? "skipped" : ended ? "missed" : "scheduled";
  await pool.query(`UPDATE meetings SET skip_recording = $2, status = $3 WHERE id = $1`, [id, skip, status]);
  emitMeetingChanged(id);
  return (await getMeeting(id))!;
}

export { todayIn };
