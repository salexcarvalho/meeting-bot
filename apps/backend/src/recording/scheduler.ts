import type { PoolClient } from "pg";
import type { ChannelLiveState, RecordingEvent } from "@meeting-bot/contracts";
import { hostAgentOwner } from "./owner";
import { tickAutoAssistant } from "../bot/autoJoin";
import { config } from "../config";
import { emitMeetingChanged, pool, withTransaction } from "../db";
import { hub } from "../live/hub";
import { allowIngest } from "./audioIngest";
import { conflicts, decide, STOP_REASON_LABELS, type SchedMeeting, type SchedulerAction } from "./decide";
import { finalizeRecording, isFinalizing } from "./finalize";
import {
  checkHostAgentTimeout,
  hostAgentCapture,
  hostAgentLastSeen,
  isHostAgentOnline,
} from "./hostAgentState";
import { LOCAL_CHANNELS, peekRuntime, runtimeFor } from "./runtime";

// Controle da gravação local (research.md R12): tick de 5 s sob advisory lock.

const LOCK_KEY = 73_100_001;
const TICK_MS = 5_000;
const PUBLISH_MS = 2_000;
const STOPPING_MAX_MS = 120_000;
const STOPPING_MIN_MS = 15_000;
const LOCAL_SOURCES = ["ics", "manual"];

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ActiveInfo {
  status: "recording" | "stopping";
  startedAt: Date | null;
  endedAt: Date | null;
}

const active = new Map<string, ActiveInfo>();
let conflictIds: string[] = [];
let tickTimer: NodeJS.Timeout | null = null;
let publishTimer: NodeJS.Timeout | null = null;
let ticking = false;

export function activeRecordingId(): string | null {
  for (const [id, info] of active) if (info.status === "recording") return id;
  return active.keys().next().value ?? null;
}

export function hasActiveRecording(): boolean {
  return active.size > 0;
}

export function conflictMeetingIds(): string[] {
  return conflictIds;
}

const SELECT_COLUMNS = `id, status, scheduled_start, scheduled_end, skip_recording, started_at, ended_at,
  stop_requested, last_speech_at, created_by`;

// Reunião de outro usuário nunca é gravada nesta máquina (vira "não gravada" depois do horário).
// Com AUTO_LOCAL_RECORDING=false o PC não começa a gravar sozinho: quem grava é o assistente.
function toSched(r: Record<string, any>, ownerId: string | null): SchedMeeting {
  const rt = peekRuntime(r.id);
  const dbSpeech: Date | null = r.last_speech_at;
  const memSpeech = rt?.lastSpeechAt ?? null;
  return {
    id: r.id,
    status: r.status,
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
    skipRecording: r.skip_recording || !config.autoLocalRecording || !ownerId || r.created_by !== ownerId,
    startedAt: r.started_at,
    stopRequested: r.stop_requested,
    lastSpeechAt: dbSpeech && memSpeech ? (dbSpeech > memSpeech ? dbSpeech : memSpeech) : (dbSpeech ?? memSpeech),
  };
}

async function applyAction(client: PoolClient, action: SchedulerAction): Promise<boolean> {
  if (action.kind === "start") {
    const r = await client.query(
      `UPDATE meetings SET status = 'recording', started_at = now(), ended_at = NULL, stop_requested = false,
         last_speech_at = NULL, error_message = NULL
       WHERE id = $1 AND status = 'scheduled'`,
      [action.meetingId],
    );
    return r.rowCount === 1;
  }
  if (action.kind === "stop") {
    const r = await client.query(
      `UPDATE meetings SET status = 'stopping', ended_at = now(), stop_requested = false
       WHERE id = $1 AND status = 'recording'`,
      [action.meetingId],
    );
    return r.rowCount === 1;
  }
  const r = await client.query(`UPDATE meetings SET status = 'missed' WHERE id = $1 AND status = 'scheduled'`, [
    action.meetingId,
  ]);
  return r.rowCount === 1;
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    checkHostAgentTimeout();
    const now = new Date();
    // Antes das decisões locais: a reunião que o assistente pega sai de `scheduled`.
    await tickAutoAssistant(now);
    const owner = await hostAgentOwner();
    const applied = await withTransaction(async (client) => {
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1) AS locked`, [LOCK_KEY]);
      if (!lock.rows[0].locked) return [] as SchedulerAction[];
      const { rows } = await client.query(
        `SELECT ${SELECT_COLUMNS} FROM meetings
         WHERE source = ANY($1) AND scheduled_start IS NOT NULL
           AND (status IN ('recording', 'stopping') OR (status = 'scheduled' AND scheduled_start <= $2))`,
        [LOCAL_SOURCES, now],
      );
      const state = {
        meetings: rows.map((r) => toSched(r, owner?.id ?? null)),
        hostAgentOnline: isHostAgentOnline(now.getTime()),
        hostAgentLastSeen: hostAgentLastSeen(),
      };
      const done: SchedulerAction[] = [];
      for (const action of decide(now, state, {
        maxRecordingMs: config.maxRecordingMs,
        silenceStopMs: config.silenceStopMs,
        agentGoneMs: 5 * 60_000,
      })) {
        if (await applyAction(client, action)) done.push(action);
      }
      conflictIds = conflicts(now, {
        ...state,
        meetings: state.meetings.map((m) => {
          const a = done.find((d) => d.meetingId === m.id);
          if (a?.kind === "start") return { ...m, status: "recording" as const };
          if (a?.kind === "stop") return { ...m, status: "stopping" as const };
          return m;
        }),
      });
      return done;
    });

    for (const action of applied) {
      if (action.kind === "start") {
        runtimeFor(action.meetingId);
        console.log(`[scheduler] gravação iniciada: ${action.meetingId}`);
      } else if (action.kind === "stop") {
        const rt = runtimeFor(action.meetingId);
        rt.stoppingSince = Date.now();
        rt.stopReason = STOP_REASON_LABELS[action.reason];
        console.log(`[scheduler] gravação encerrando (${action.reason}): ${action.meetingId}`);
      }
      emitMeetingChanged(action.meetingId);
    }

    await refreshActive();
    for (const [id, info] of active) {
      if (info.status !== "stopping" || isFinalizing(id)) continue;
      const rt = runtimeFor(id);
      rt.stoppingSince ??= Date.now();
      const waited = Date.now() - rt.stoppingSince;
      const uploading = LOCAL_CHANNELS.some((ch) => rt.channels[ch].connected && !rt.channels[ch].ended);
      const capturing = hostAgentCapture()?.meetingId === id;
      if (waited >= STOPPING_MAX_MS || (!uploading && !capturing && waited >= STOPPING_MIN_MS)) {
        void finalizeRecording(id).finally(() =>
          refreshActive().catch((err) => console.error("[scheduler] falha ao atualizar gravações ativas:", err)),
        );
      }
    }
  } catch (err) {
    console.error("[scheduler] erro no ciclo:", err);
  } finally {
    ticking = false;
  }
}

async function refreshActive(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, status, started_at, ended_at FROM meetings
     WHERE source = ANY($1) AND status IN ('recording', 'stopping')`,
    [LOCAL_SOURCES],
  );
  active.clear();
  for (const r of rows) active.set(r.id, { status: r.status, startedAt: r.started_at, endedAt: r.ended_at });
}

function recordingEvent(id: string, info: ActiveInfo): RecordingEvent {
  const rt = runtimeFor(id);
  const capture = hostAgentCapture();
  const channel = (ch: "mic" | "remote"): ChannelLiveState => {
    const c = rt.channels[ch];
    const reported = capture?.meetingId === id ? capture.channels[ch]?.state : undefined;
    return {
      state: c.ended ? "recording" : (reported ?? (c.connected ? "recording" : "waiting")),
      lastAudioAt: c.lastAudioAt?.toISOString() ?? null,
    };
  };
  const end = info.endedAt ?? new Date();
  return {
    type: "recording",
    meetingId: id,
    elapsedSeconds: info.startedAt ? Math.max(0, Math.round((end.getTime() - info.startedAt.getTime()) / 1000)) : 0,
    lastSpeechAt: rt.lastSpeechAt?.toISOString() ?? null,
    lagSeconds: Math.max(rt.channels.mic.lagSeconds, rt.channels.remote.lagSeconds),
    channels: { mic: channel("mic"), remote: channel("remote") },
    ...(info.status === "stopping" && rt.stopReason ? { stopReason: rt.stopReason } : {}),
  };
}

function publishRecording(): void {
  for (const [id, info] of active) hub.publishBoth(id, recordingEvent(id, info));
}

// Início manual ("Gravar agora").
export async function startRecordingNow(meetingId: string): Promise<void> {
  if (!isHostAgentOnline()) {
    throw new RecordingError("O agente do desktop está offline. Inicie-o para gravar.", 503);
  }
  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);
    const { rows } = await client.query(
      `SELECT id, source, status, created_by FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    const m = rows[0];
    if (!m) throw new RecordingError("Reunião não encontrada.", 404);
    const owner = await hostAgentOwner();
    if (!owner || m.created_by !== owner.id) {
      throw new RecordingError(
        owner
          ? `O agente do desktop desta máquina grava só as reuniões de ${owner.name}.`
          : "Nenhum dono configurado para o agente do desktop (AGENT_OWNER).",
        409,
      );
    }
    if (!LOCAL_SOURCES.includes(m.source)) {
      throw new RecordingError("Só reuniões da agenda podem ser gravadas pelo desktop.", 409);
    }
    if (!["scheduled", "skipped", "missed"].includes(m.status)) {
      throw new RecordingError("Esta reunião não pode ser gravada agora.", 409);
    }
    const other = await client.query(
      `SELECT id FROM meetings WHERE source = ANY($1) AND status IN ('recording', 'stopping') AND id <> $2 LIMIT 1`,
      [LOCAL_SOURCES, meetingId],
    );
    if (other.rows[0]) {
      throw new RecordingError("Já existe uma gravação em andamento. Pare-a antes de iniciar outra.", 409, {
        conflictMeetingId: other.rows[0].id,
      });
    }
    await client.query(
      `UPDATE meetings SET status = 'recording', started_at = now(), ended_at = NULL, stop_requested = false,
         skip_recording = false, last_speech_at = NULL, error_message = NULL
       WHERE id = $1`,
      [meetingId],
    );
  });
  allowIngest(meetingId);
  runtimeFor(meetingId);
  emitMeetingChanged(meetingId);
  await refreshActive();
}

// Botão Parar. false = não é uma gravação local em andamento.
export async function requestStop(meetingId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE meetings SET stop_requested = true WHERE id = $1 AND source = ANY($2) AND status = 'recording'`,
    [meetingId, LOCAL_SOURCES],
  );
  if (r.rowCount !== 1) return false;
  void tick();
  return true;
}

export async function startScheduler(): Promise<void> {
  await refreshActive();
  tickTimer ??= setInterval(() => void tick(), TICK_MS);
  publishTimer ??= setInterval(publishRecording, PUBLISH_MS);
  void tick();
}

export async function stopScheduler(): Promise<void> {
  if (tickTimer) clearInterval(tickTimer);
  if (publishTimer) clearInterval(publishTimer);
  tickTimer = publishTimer = null;
}
