import { transcribeChunk, WorkerUnavailableError } from "../asr/workerClient";
import { config } from "../config";
import { pool } from "../db";
import { hub } from "../live/hub";
import { defaultSpeaker, getSpeakers, insertLiveSegments, speakerNameResolver, toSegmentJson } from "../repo/transcripts";
import { BYTES_PER_SECOND, Chunk, Chunker } from "./chunker";
import { glossaryFor } from "./glossary";
import { runtimeFor, type LocalChannel } from "./runtime";

// Transcrição ao vivo de um canal: corta o PCM recebido e manda cada trecho ao worker.

const MAX_QUEUE = 20; // ~10 min; além disso o passe final cobre o que ficar para trás
const BACKLOG_AS_SPEECH = 3;
const SPEECH_DB_THROTTLE_MS = 10_000;
const RETRY_MS = [2_000, 5_000, 10_000];

interface QueuedChunk extends Chunk {
  cutAt: number;
}

const sessions = new Map<string, LiveSession>();
const lastSpeechWrite = new Map<string, number>();

export function liveSession(meetingId: string, channel: LocalChannel): LiveSession {
  const key = `${meetingId}:${channel}`;
  let s = sessions.get(key);
  if (!s) {
    s = new LiveSession(meetingId, channel);
    sessions.set(key, s);
  }
  return s;
}

export function closeLiveSessions(meetingId: string): void {
  for (const [key, s] of sessions) {
    if (s.meetingId === meetingId) {
      s.close();
      sessions.delete(key);
    }
  }
  lastSpeechWrite.delete(meetingId);
}

export async function markSpeech(meetingId: string, at = new Date()): Promise<void> {
  const rt = runtimeFor(meetingId);
  if (!rt.lastSpeechAt || rt.lastSpeechAt < at) rt.lastSpeechAt = at;
  const last = lastSpeechWrite.get(meetingId) ?? 0;
  if (Date.now() - last < SPEECH_DB_THROTTLE_MS) return;
  lastSpeechWrite.set(meetingId, Date.now());
  await pool
    .query(`UPDATE meetings SET last_speech_at = GREATEST(COALESCE(last_speech_at, $2), $2) WHERE id = $1`, [
      meetingId,
      at,
    ])
    .catch((err) => console.error(`[live ${meetingId}] last_speech_at:`, err));
}

export class LiveSession {
  private readonly chunker = new Chunker();
  private queue: QueuedChunk[] = [];
  private running = false;
  private closed = false;
  private lastText = "";

  constructor(
    readonly meetingId: string,
    readonly channel: LocalChannel,
  ) {}

  // Nova conexão do host-agent: continua do byte informado.
  resume(offset: number): void {
    if (this.chunker.nextOffset + this.chunker.bufferedBytes !== offset) this.chunker.reset(offset);
  }

  push(data: Buffer): void {
    for (const chunk of this.chunker.push(data)) this.enqueue(chunk);
  }

  finish(): void {
    for (const chunk of this.chunker.flush()) this.enqueue(chunk);
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }

  private enqueue(chunk: Chunk): void {
    if (this.closed || chunk.silent) return;
    // Fila atrasada (GPU ocupada): energia alta já conta como fala para a regra de parada.
    if (this.queue.length >= BACKLOG_AS_SPEECH) void markSpeech(this.meetingId);
    this.queue.push({ ...chunk, cutAt: Date.now() });
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      console.warn(`[live ${this.meetingId}/${this.channel}] fila cheia; trecho antigo descartado`);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const chunk = this.queue[0];
        const ok = await this.process(chunk);
        if (ok) this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }

  // false = tentar de novo o mesmo trecho.
  private async process(chunk: QueuedChunk): Promise<boolean> {
    const base = chunk.offsetBytes / BYTES_PER_SECOND;
    const duration = chunk.pcm.length / BYTES_PER_SECOND;
    let attempt = 0;
    for (;;) {
      if (this.closed) return true;
      try {
        const prompt = [await glossaryFor(this.meetingId), this.lastText].filter(Boolean).join(" ");
        const result = await transcribeChunk(chunk.pcm, {
          language: config.transcriptionLanguage,
          prompt: prompt || undefined,
          channel: this.channel,
        });
        if (result.speech_seconds > 0) {
          await markSpeech(this.meetingId, new Date(chunk.cutAt));
        }
        const rows = await insertLiveSegments(
          this.meetingId,
          result.segments
            .filter((s) => s.text.trim())
            .map((s) => ({
              channel: this.channel,
              speaker: defaultSpeaker(this.channel, null),
              text: s.text.trim(),
              start: Math.round((base + s.start) * 100) / 100,
              end: Math.round((base + Math.max(s.end, s.start)) * 100) / 100,
            })),
        );
        const rt = runtimeFor(this.meetingId).channels[this.channel];
        rt.lagSeconds = Math.round(((Date.now() - chunk.cutAt) / 1000 + duration) * 10) / 10;
        if (rows.length) {
          this.lastText = rows.map((r) => r.text).join(" ").slice(-200);
          const nameOf = speakerNameResolver(await getSpeakers(this.meetingId));
          hub.publishToMeeting(this.meetingId, {
            type: "segments",
            meetingId: this.meetingId,
            pass: "live",
            segments: rows.map((r) => toSegmentJson(r, nameOf)),
          });
        }
        return true;
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) {
          console.error(`[live ${this.meetingId}/${this.channel}] trecho em ${base.toFixed(1)}s falhou:`, err);
          return true;
        }
        // Worker fora: a energia do trecho conta como fala e tentamos de novo.
        await markSpeech(this.meetingId, new Date(chunk.cutAt));
        const delay = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
        if (attempt === 1) console.warn(`[live ${this.meetingId}/${this.channel}] ${err.message}; aguardando`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.queue.length > MAX_QUEUE) return true;
      }
    }
  }
}
