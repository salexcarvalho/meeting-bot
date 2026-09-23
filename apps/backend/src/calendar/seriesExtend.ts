import type { RecurrenceRule } from "@meeting-bot/contracts";
import { emitMeetingChanged, pool, withTransaction } from "../db";
import { addInterval, RECURRENCE_MAX_DAYS, RECURRENCE_MAX_OCCURRENCES } from "./service";

// Trava dura pra série sem fim definido ("pra sempre") não crescer sem limite.
const SERIES_ABSOLUTE_CAP = 500;
const TICK_MS = 3_600_000;

interface SeriesTemplate {
  series_id: string;
  created_by: string;
  title: string;
  platform: string;
  url: string | null;
  project_id: string | null;
  project_suggested: boolean;
  recurrence_rule: RecurrenceRule;
  last_start: Date;
  last_end: Date;
  status: string;
  skip_recording: boolean;
}

async function extendOne(series: SeriesTemplate, horizon: Date): Promise<void> {
  const until = series.recurrence_rule.until ? new Date(series.recurrence_rule.until) : null;
  const cap = until && until.getTime() < horizon.getTime() ? until.getTime() : horizon.getTime();
  const durationMs = series.last_end.getTime() - series.last_start.getTime();

  const { rows: countRows } = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [
    series.series_id,
  ]);
  const remaining = SERIES_ABSOLUTE_CAP - countRows[0].n;
  if (remaining <= 0) return;

  const starts: Date[] = [];
  let cursor = addInterval(series.last_start, series.recurrence_rule.freq, series.recurrence_rule.interval);
  while (cursor.getTime() <= cap && starts.length < RECURRENCE_MAX_OCCURRENCES && starts.length < remaining) {
    starts.push(cursor);
    cursor = addInterval(cursor, series.recurrence_rule.freq, series.recurrence_rule.interval);
  }
  if (!starts.length) return;

  const status = series.skip_recording ? "skipped" : "scheduled";
  await withTransaction(async (client) => {
    for (const s of starts) {
      const end = new Date(s.getTime() + durationMs);
      const { rows } = await client.query(
        `INSERT INTO meetings (title, platform, url, status, created_by, source, scheduled_start, scheduled_end,
           project_id, project_suggested, series_id, recurrence_rule, skip_recording)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (series_id, scheduled_start) WHERE series_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          series.title, series.platform, series.url, status, series.created_by, s, end,
          series.project_id, series.project_suggested, series.series_id, JSON.stringify(series.recurrence_rule),
          series.skip_recording,
        ],
      );
      if (rows[0]) emitMeetingChanged(rows[0].id);
    }
  });
}

// Pega, por série, só a ocorrência mais recente (qualquer status): se ela estiver cancelada,
// a série foi encerrada por "cancelar a partir daqui" e não deve reviver.
export async function extendActiveSeries(now = new Date()): Promise<void> {
  const horizon = new Date(now.getTime() + RECURRENCE_MAX_DAYS * 86_400_000);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (series_id) series_id, created_by, title, platform, url, project_id, project_suggested,
       recurrence_rule, scheduled_start AS last_start, scheduled_end AS last_end, status, skip_recording
     FROM meetings
     WHERE series_id IS NOT NULL
     ORDER BY series_id, scheduled_start DESC`,
  );

  for (const series of rows as SeriesTemplate[]) {
    if (series.status === "cancelled") continue;
    const until = series.recurrence_rule.until ? new Date(series.recurrence_rule.until) : null;
    if (until && until.getTime() <= series.last_start.getTime()) continue;
    if (series.last_start.getTime() >= horizon.getTime()) continue;
    await extendOne(series, horizon).catch((err) => console.error("[série] erro ao estender", series.series_id, err));
  }
}

let extending = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (extending) return;
  extending = true;
  try {
    await extendActiveSeries();
  } catch (err) {
    console.error("[série] erro no ciclo:", err);
  } finally {
    extending = false;
  }
}

export function startSeriesExtender(): void {
  timer ??= setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
}

export function stopSeriesExtender(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
