import type { Channel } from "@meeting-bot/contracts";
import { config } from "../config";
import { recordUsage } from "./recorder";

// ASR ao vivo agregado por (reunião, canal): em vez de uma linha por trecho de áudio, acumula em
// memória e grava um delta a cada USAGE_ASR_FLUSH_MINUTES e no fechamento da sessão (append-only).

export interface ChunkUsage {
  /** segundos de áudio do trecho */
  duration: number;
  /** segundos de processamento no worker */
  elapsed: number;
}

export interface LiveAsrDelta {
  meetingId: string;
  channel: Channel;
  audioSeconds: number;
  computeMs: number;
  chunks: number;
}

interface Bucket {
  audioSeconds: number;
  elapsedSeconds: number;
  chunks: number;
  since: number;
}

export class LiveAsrAccumulator {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly flushMs: () => number,
    private readonly sink: (delta: LiveAsrDelta) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private key(meetingId: string, channel: Channel): string {
    return `${meetingId}:${channel}`;
  }

  /** Soma o trecho; descarrega o delta quando o intervalo de flush já passou. */
  add(meetingId: string, channel: Channel, chunk: ChunkUsage): void {
    const key = this.key(meetingId, channel);
    const bucket = this.buckets.get(key) ?? { audioSeconds: 0, elapsedSeconds: 0, chunks: 0, since: this.now() };
    bucket.audioSeconds += Math.max(chunk.duration, 0);
    bucket.elapsedSeconds += Math.max(chunk.elapsed, 0);
    bucket.chunks++;
    this.buckets.set(key, bucket);
    if (this.now() - bucket.since >= this.flushMs()) this.flush(meetingId, channel);
  }

  /** Grava e zera o acumulado do canal; sem áudio acumulado não grava nada. */
  flush(meetingId: string, channel: Channel): void {
    const key = this.key(meetingId, channel);
    const bucket = this.buckets.get(key);
    this.buckets.delete(key);
    if (!bucket || bucket.audioSeconds <= 0) return;
    this.sink({
      meetingId,
      channel,
      audioSeconds: bucket.audioSeconds,
      computeMs: Math.round(bucket.elapsedSeconds * 1000),
      chunks: bucket.chunks,
    });
  }
}

function writeDelta(delta: LiveAsrDelta): void {
  recordUsage({
    category: "asr",
    purpose: "asr_ao_vivo",
    provider: "whisper",
    model: null,
    meetingId: delta.meetingId,
    channel: delta.channel,
    inputTokens: null,
    outputTokens: null,
    audioSeconds: delta.audioSeconds,
    costUsd: null,
    durationMs: delta.computeMs,
    computeMs: delta.computeMs,
    attempts: 1,
    success: true,
    errorCode: null,
    label: `${delta.chunks} trechos`,
  });
}

export const liveAsrUsage = new LiveAsrAccumulator(() => config.usageAsrFlushMinutes * 60_000, writeDelta);
