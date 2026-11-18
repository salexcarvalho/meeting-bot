import type { SpeakerTimelineInfo, SpeakerTimelineStatus } from "@meeting-bot/contracts";
import { pool } from "../db";
import type { SpeechInterval } from "../recording/speakerTimeline";

// Linha do tempo de quem falou na chamada (spec 006). Os nomes são de terceiros: ficam só com a reunião
// (ON DELETE CASCADE, sem prazo próprio) e nunca vão para log, auditoria ou provedor externo.

/** Resumo da leitura guardado em `meetings.speaker_timeline_meta`; nunca traz nomes de pessoas. */
export interface SpeakerTimelineMeta {
  status: SpeakerTimelineStatus;
  /** camada de seletor que achou os quadros (semântica, estrutural, painel) e perfil do Teams */
  source?: string;
  layer?: number;
  reason?: string;
  people: number;
  intervals: number;
  skewMs?: number;
  /** rótulos que ficaram sem nome e o motivo (ex.: { "Speaker 2": "purity" }) */
  undecided?: Record<string, string>;
}

export interface ActivityRow {
  key: string;
  name: string;
  start: number;
  end: number;
}

const BATCH = 500;

/** Grava os intervalos em lote (um insert multilinha por até 500 linhas). */
export async function insertActivity(meetingId: string, platform: string, intervals: SpeechInterval[]): Promise<void> {
  for (let i = 0; i < intervals.length; i += BATCH) {
    const batch = intervals.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((it, j) => {
      const o = j * 6;
      values.push(meetingId, it.key, it.name, platform, it.start, it.end);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    await pool.query(
      `INSERT INTO speaker_activity (meeting_id, participant_key, display_name, platform, start_seconds, end_seconds)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

export async function listActivity(meetingId: string): Promise<ActivityRow[]> {
  const { rows } = await pool.query(
    `SELECT participant_key, display_name, start_seconds, end_seconds
       FROM speaker_activity WHERE meeting_id = $1 ORDER BY start_seconds, id`,
    [meetingId],
  );
  return rows.map((r) => ({
    key: r.participant_key,
    name: r.display_name,
    start: Number(r.start_seconds),
    end: Number(r.end_seconds),
  }));
}

export async function deleteActivity(meetingId: string): Promise<void> {
  await pool.query(`DELETE FROM speaker_activity WHERE meeting_id = $1`, [meetingId]);
}

export async function readTimelineMeta(meetingId: string): Promise<SpeakerTimelineMeta | null> {
  const { rows } = await pool.query(`SELECT speaker_timeline_meta FROM meetings WHERE id = $1`, [meetingId]);
  return (rows[0]?.speaker_timeline_meta as SpeakerTimelineMeta | null) ?? null;
}

export async function writeTimelineMeta(meetingId: string, meta: SpeakerTimelineMeta): Promise<void> {
  await pool.query(`UPDATE meetings SET speaker_timeline_meta = $2 WHERE id = $1`, [meetingId, meta]);
}

/** Junta ao que já estava guardado (ex.: o casamento acrescenta o deslocamento ao estado da leitura). */
export async function mergeTimelineMeta(meetingId: string, patch: Partial<SpeakerTimelineMeta>): Promise<void> {
  await pool.query(
    `UPDATE meetings SET speaker_timeline_meta = COALESCE(speaker_timeline_meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [meetingId, JSON.stringify(patch)],
  );
}

/** O que a interface vê da leitura: estado, motivo e contagem de pessoas. */
export function toTimelineInfo(meta: SpeakerTimelineMeta | null): SpeakerTimelineInfo | null {
  if (!meta) return null;
  return {
    status: meta.status,
    people: meta.people,
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.source ? { source: meta.source } : {}),
  };
}
