import type { PoolClient } from "pg";
import {
  LIVE_SPEAKER_PREFIX,
  REMOTE_SPEAKER_LABEL,
  USER_SPEAKER_LABEL,
  type Channel,
  type Segment,
  type Speaker,
  type SpeakerNameSource,
  type TranscriptPass,
} from "@meeting-bot/contracts";
import { config } from "../config";
import { pool, withTransaction } from "../db";
import { invalidateTranscript } from "../search/dirty";

export interface NewSegment {
  channel: Channel;
  speaker: string | null;
  text: string;
  start: number;
  end: number;
}

export interface SegmentRow {
  id: number;
  channel: Channel;
  pass: TranscriptPass;
  speaker: string | null;
  text: string;
  start: number;
  end: number;
}

function mapRow(r: Record<string, unknown>): SegmentRow {
  return {
    id: Number(r.id),
    channel: r.channel as Channel,
    pass: r.pass as TranscriptPass,
    speaker: (r.speaker as string | null) ?? null,
    text: r.text as string,
    start: Number(r.start_seconds),
    end: Number(r.end_seconds),
  };
}

export async function insertLiveSegments(meetingId: string, segments: NewSegment[]): Promise<SegmentRow[]> {
  if (!segments.length) return [];
  const values: unknown[] = [];
  const tuples = segments.map((s, i) => {
    const o = i * 6;
    values.push(meetingId, s.channel, s.speaker, s.text, s.start, s.end);
    return `($${o + 1}, $${o + 2}, 'live', $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
  });
  const { rows } = await pool.query(
    `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
     VALUES ${tuples.join(", ")}
     RETURNING id, channel, pass, speaker, text, start_seconds, end_seconds`,
    values,
  );
  return rows.map(mapRow);
}

// Passe final pronto → mostra só ele; enquanto isso, a transcrição ao vivo.
export async function getSegments(meetingId: string, opts: { afterId?: number } = {}): Promise<SegmentRow[]> {
  const { rows } = await pool.query(
    `SELECT id, channel, pass, speaker, text, start_seconds, end_seconds
     FROM transcript_segments
     WHERE meeting_id = $1 AND id > $2
       AND pass = CASE WHEN EXISTS (
         SELECT 1 FROM transcript_segments f WHERE f.meeting_id = $1 AND f.pass = 'final'
       ) THEN 'final' ELSE 'live' END
     ORDER BY start_seconds ASC, id ASC`,
    [meetingId, opts.afterId ?? 0],
  );
  return rows.map(mapRow);
}

export async function getSegmentsByIds(meetingId: string, ids: number[]): Promise<SegmentRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, channel, pass, speaker, text, start_seconds, end_seconds
     FROM transcript_segments WHERE meeting_id = $1 AND id = ANY($2) ORDER BY start_seconds, id`,
    [meetingId, ids],
  );
  return rows.map(mapRow);
}

export async function countFinalSegments(meetingId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM transcript_segments WHERE meeting_id = $1 AND pass = 'final'`,
    [meetingId],
  );
  return rows[0].n;
}

export type EvidenceRemapper = (client: PoolClient, meetingId: string, finals: SegmentRow[]) => Promise<void>;

// Substitui toda a transcrição pelo passe final numa única transação.
// O remapeador (US4) move as evidências dos itens antes de apagar os segmentos antigos.
export async function replaceWithFinal(
  meetingId: string,
  segments: NewSegment[],
  remap?: EvidenceRemapper,
  provider = "worker-gpu",
): Promise<SegmentRow[]> {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM transcript_segments WHERE meeting_id = $1 AND pass = 'final'`, [meetingId]);
    const inserted: SegmentRow[] = [];
    const BATCH = 500;
    for (let i = 0; i < segments.length; i += BATCH) {
      const batch = segments.slice(i, i + BATCH);
      const values: unknown[] = [];
      const tuples = batch.map((s, j) => {
        const o = j * 6;
        values.push(meetingId, s.channel, s.speaker, s.text, s.start, s.end);
        return `($${o + 1}, $${o + 2}, 'final', $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
      });
      const { rows } = await client.query(
        `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
         VALUES ${tuples.join(", ")}
         RETURNING id, channel, pass, speaker, text, start_seconds, end_seconds`,
        values,
      );
      inserted.push(...rows.map(mapRow));
    }
    if (remap) await remap(client, meetingId, inserted);
    await client.query(`DELETE FROM transcript_segments WHERE meeting_id = $1 AND pass = 'live'`, [meetingId]);
    // os trechos de transcrição da busca saem na mesma transação (FR-014); a reindexação vem no fim do pipeline
    await invalidateTranscript(client, meetingId);
    await client.query(
      `UPDATE meetings SET transcribed_at = now(), transcription_provider = $2 WHERE id = $1`,
      [meetingId, provider],
    );
    // Retranscrição: nomes da chamada e padrões são refeitos (a numeração dos "Speaker N" muda); os manuais ficam por rótulo.
    await client.query(
      `DELETE FROM meeting_speakers WHERE meeting_id = $1 AND (name_source IS NULL OR name_source = 'call')`,
      [meetingId],
    );
    await seedSpeakers(client, meetingId, inserted);
    return inserted;
  });
}

async function seedSpeakers(client: PoolClient, meetingId: string, segments: SegmentRow[]): Promise<void> {
  const labels = new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)));
  for (const label of labels) {
    await client.query(
      `INSERT INTO meeting_speakers (meeting_id, label, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, label) DO NOTHING`,
      [meetingId, label, label === USER_SPEAKER_LABEL ? config.userDisplayName : label],
    );
  }
}

function toSpeaker(r: Record<string, unknown>): Speaker {
  return {
    label: r.label as string,
    displayName: r.display_name as string,
    isUser: r.label === USER_SPEAKER_LABEL,
    nameSource: (r.name_source as SpeakerNameSource | null) ?? null,
    nameConfidence: r.name_confidence === null || r.name_confidence === undefined ? null : Number(r.name_confidence),
  };
}

export async function getSpeakers(meetingId: string): Promise<Speaker[]> {
  const { rows } = await pool.query(
    `SELECT label, display_name, name_source, name_confidence FROM meeting_speakers WHERE meeting_id = $1 ORDER BY label`,
    [meetingId],
  );
  return rows.map(toSpeaker);
}

// Renomear grava origem "manual" (nunca sobrescrita pelo casamento); nome igual ao rótulo = voltar ao padrão.
export async function renameSpeaker(meetingId: string, label: string, displayName: string): Promise<Speaker | null> {
  const { rows } = await pool.query(
    `INSERT INTO meeting_speakers (meeting_id, label, display_name, name_source)
     SELECT $1, $2, $3, CASE WHEN $3 = $2 THEN NULL ELSE 'manual' END WHERE EXISTS (
       SELECT 1 FROM transcript_segments WHERE meeting_id = $1 AND speaker = $2
     )
     ON CONFLICT (meeting_id, label) DO UPDATE
       SET display_name = EXCLUDED.display_name, name_source = EXCLUDED.name_source, name_confidence = NULL
     RETURNING label, display_name, name_source, name_confidence`,
    [meetingId, label, displayName],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

// Nome exibido: renomeação da reunião > nome do usuário (canal mic) > rótulo. Rótulo ao vivo ("live:Nome") vale o nome.
export function speakerNameResolver(speakers: Speaker[]): (label: string | null) => string | null {
  const names = new Map(speakers.map((s) => [s.label, s.displayName]));
  return (label) => {
    if (!label) return null;
    if (label.startsWith(LIVE_SPEAKER_PREFIX)) return label.slice(LIVE_SPEAKER_PREFIX.length) || null;
    return names.get(label) ?? (label === USER_SPEAKER_LABEL ? config.userDisplayName : label);
  };
}

export function toSegmentJson(row: SegmentRow, nameOf: (label: string | null) => string | null): Segment {
  return { ...row, speakerName: nameOf(row.speaker) };
}

export function defaultSpeaker(channel: Channel, diarized: string | null): string | null {
  if (channel === "mic") return USER_SPEAKER_LABEL;
  if (channel === "remote") return diarized ?? REMOTE_SPEAKER_LABEL;
  return diarized;
}
