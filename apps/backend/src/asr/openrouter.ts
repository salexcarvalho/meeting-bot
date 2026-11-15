import { config } from "../config";
import { audit } from "../security/audit";
import { classifyError } from "../usage/errorCode";
import { ownerOfMeeting, recordUsage } from "../usage/recorder";
import { opusSlice, probeDuration } from "./ffmpeg";
import type { Channel } from "@meeting-bot/contracts";
import type { JobChannelResult, JobFile } from "./workerClient";

// ASR externo de teste: OpenRouter /audio/transcriptions (padrão deepgram/nova-3).
// Só existe com ALLOW_EXTERNAL_ASR=true (Constituição 1.1.0, princípio I); nunca no ao vivo.

// O provedor corta requisições longas (~60 s de processamento): trechos de 20 min.
const SLICE_SECONDS = 20 * 60;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const MAX_WORDS_PER_SEGMENT = 40;
const WORD_GAP_S = 1.2;

export const EXTERNAL_ASR_ID = "openrouter";

export interface ExternalAsrStatus {
  model: string;
  available: boolean;
  isDefault: boolean;
}

export function externalAsrStatus(): ExternalAsrStatus | null {
  const ext = config.externalAsr;
  if (!ext.allowed) return null;
  return { model: ext.model, available: Boolean(ext.apiKey), isDefault: config.asrProvider === "openrouter" };
}

export function providerLabel(): string {
  return `openrouter:${config.externalAsr.model}`;
}

export class ExternalAsrError extends Error {
  /** status HTTP da recusa, quando houve resposta; alimenta o código de erro do registro de uso */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface SttWord {
  word: string;
  start: number;
  end: number;
  speaker?: number | string | null;
}

interface SttResponse {
  text?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string; speaker?: number | string | null }[];
  words?: SttWord[];
  usage?: { seconds?: number; cost?: number; input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

type RawSegment = { start: number; end: number; text: string; speaker: string | null };

// Sem `segments`: agrupa palavras por falante, pausa e tamanho.
export function wordsToSegments(words: SttWord[]): RawSegment[] {
  const out: RawSegment[] = [];
  let current: (RawSegment & { count: number }) | null = null;
  for (const w of words) {
    const speaker = w.speaker === undefined || w.speaker === null ? null : String(w.speaker);
    const text = w.word.trim();
    if (!text) continue;
    if (
      current &&
      current.speaker === speaker &&
      w.start - current.end <= WORD_GAP_S &&
      current.count < MAX_WORDS_PER_SEGMENT
    ) {
      current.text += ` ${text}`;
      current.end = w.end;
      current.count++;
      continue;
    }
    if (current) out.push({ start: current.start, end: current.end, text: current.text, speaker: current.speaker });
    current = { start: w.start, end: w.end, text, speaker, count: 1 };
  }
  if (current) out.push({ start: current.start, end: current.end, text: current.text, speaker: current.speaker });
  return out;
}

export function parseSttResponse(data: SttResponse, sliceSeconds: number): RawSegment[] {
  if (data.segments?.length) {
    return data.segments
      .filter((s) => s.text?.trim())
      .map((s) => ({
        start: s.start,
        end: Math.max(s.end, s.start),
        text: s.text.trim(),
        speaker: s.speaker === undefined || s.speaker === null ? null : String(s.speaker),
      }));
  }
  if (data.words?.length) return wordsToSegments(data.words);
  const text = data.text?.trim();
  return text ? [{ start: 0, end: data.duration ?? sliceSeconds, text, speaker: null }] : [];
}

async function postSlice(body: Record<string, unknown>): Promise<SttResponse> {
  const ext = config.externalAsr;
  let lastError = "";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${ext.url}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ext.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      break;
    }
    const text = await res.text();
    let data: SttResponse = {};
    try {
      data = text ? (JSON.parse(text) as SttResponse) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (res.ok) return data;
    const message = typeof data.error === "string" ? data.error : (data.error?.message ?? `HTTP ${res.status}`);
    lastError = `${res.status}: ${message}`.slice(0, 300);
    lastStatus = res.status;
    // Opções do provedor recusadas: tenta sem elas.
    if (res.status === 400 && body.provider) {
      console.warn(`[asr-externo] opções do provedor recusadas (${lastError}); repetindo sem diarização`);
      const { provider: _ignored, ...rest } = body;
      body = rest;
      continue;
    }
    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 413) break;
    if (attempt < RETRY_DELAYS_MS.length && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    break;
  }
  throw new ExternalAsrError(`OpenRouter recusou a transcrição (${lastError})`, lastStatus);
}

/** Soma o uso das fatias de um canal: vira uma única linha em ai_usage_logs. */
class ChannelMeter {
  sent = 0;
  seconds = 0;
  durationMs = 0;
  private cost: number | null = null;
  private input: number | null = null;
  private output: number | null = null;

  add(usage: SttResponse["usage"], fallbackSeconds: number, ms: number): void {
    this.seconds += typeof usage?.seconds === "number" ? usage.seconds : fallbackSeconds;
    this.durationMs += ms;
    if (typeof usage?.cost === "number") this.cost = (this.cost ?? 0) + usage.cost;
    if (typeof usage?.input_tokens === "number") this.input = (this.input ?? 0) + usage.input_tokens;
    if (typeof usage?.output_tokens === "number") this.output = (this.output ?? 0) + usage.output_tokens;
  }

  /** Só registra se alguma fatia chegou a ser enviada (falha de ffmpeg antes do envio não é uso). */
  record(meetingId: string, channel: Channel, error: unknown): void {
    if (this.sent === 0) return;
    recordUsage({
      category: "asr",
      purpose: "asr_final",
      provider: "deepgram",
      model: config.externalAsr.model,
      meetingId,
      channel,
      inputTokens: this.input,
      outputTokens: this.output,
      audioSeconds: this.seconds,
      costUsd: this.cost,
      durationMs: this.durationMs,
      computeMs: null,
      attempts: this.sent,
      success: error === null,
      errorCode: error === null ? null : classifyError(error),
      label: null,
    });
  }
}

type SliceSegments = { segments: JobChannelResult["segments"]; diarized: boolean };

// Falantes são numerados por parte: o provedor não mantém identidade entre requisições.
function sliceToSegments(raw: RawSegment[], offset: number, part: { index: number; total: number }, diarize: boolean): SliceSegments {
  const order = new Map<string, number>();
  const segments: JobChannelResult["segments"] = [];
  let diarized = false;
  for (const s of raw) {
    let speaker: string | null = null;
    if (diarize && s.speaker !== null) {
      if (!order.has(s.speaker)) order.set(s.speaker, order.size + 1);
      const n = order.get(s.speaker)!;
      speaker = part.total > 1 ? `Speaker ${n} (parte ${part.index + 1})` : `Speaker ${n}`;
      diarized = true;
    }
    segments.push({
      start: Math.round((offset + s.start) * 100) / 100,
      end: Math.round((offset + s.end) * 100) / 100,
      text: s.text,
      speaker,
    });
  }
  return { segments, diarized };
}

export async function transcribeFileExternal(
  meetingId: string,
  file: JobFile,
  opts: { language: string },
  onProgress: (fraction: number) => void,
): Promise<JobChannelResult> {
  const ext = config.externalAsr;
  if (!ext.allowed) throw new ExternalAsrError("ASR externo desabilitado (ALLOW_EXTERNAL_ASR=false).");
  if (!ext.apiKey) throw new ExternalAsrError("OPENROUTER_API_KEY não configurada no .env.");

  const duration = await probeDuration(file.path);
  const slices = Math.max(1, Math.ceil(duration / SLICE_SECONDS));
  const segments: JobChannelResult["segments"] = [];
  let diarized = false;
  const owner = await ownerOfMeeting(meetingId).catch(() => null);
  const meter = new ChannelMeter();

  try {
    for (let i = 0; i < slices; i++) {
      const offset = i * SLICE_SECONDS;
      const length = Math.min(SLICE_SECONDS, duration - offset);
      if (length <= 0.2) break;
      const audio = await opusSlice(file.path, offset, length);
      const body: Record<string, unknown> = {
        model: ext.model,
        input_audio: { data: audio.toString("base64"), format: "ogg" },
        language: opts.language,
        response_format: "verbose_json",
        timestamp_granularities: ["segment", "word"],
      };
      if (file.diarize) body.provider = { options: { deepgram: { diarize: true, smart_format: true } } };

      audit(
        "external_asr",
        { meetingId, channel: file.channel, seconds: Math.round(length), model: ext.model, purpose: "asr_final", phase: "start" },
        owner,
      );
      const started = Date.now();
      meter.sent++;
      const data = await postSlice(body);
      meter.add(data.usage, length, Date.now() - started);
      const raw = parseSttResponse(data, length);
      console.log(
        `[asr-externo ${meetingId.slice(0, 8)}/${file.channel}] parte ${i + 1}/${slices}: ${raw.length} segmentos em ${((Date.now() - started) / 1000).toFixed(1)}s` +
          (data.usage?.cost !== undefined ? `, custo US$ ${data.usage.cost}` : ""),
      );
      const part = sliceToSegments(raw, offset, { index: i, total: slices }, file.diarize);
      segments.push(...part.segments);
      diarized ||= part.diarized;
      onProgress((i + 1) / slices);
    }
  } catch (err) {
    meter.record(meetingId, file.channel, err);
    audit(
      "external_asr",
      { meetingId, channel: file.channel, model: ext.model, purpose: "asr_final", phase: "end", success: false, errorCode: classifyError(err) },
      owner,
    );
    throw err;
  }
  meter.record(meetingId, file.channel, null);
  audit(
    "external_asr",
    { meetingId, channel: file.channel, model: ext.model, purpose: "asr_final", phase: "end", success: true, seconds: Math.round(meter.seconds) },
    owner,
  );
  return { channel: file.channel, duration, diarized, segments };
}
