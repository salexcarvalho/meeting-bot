import type { Channel, GpuStats } from "@meeting-bot/contracts";
import { config } from "../config";

// Cliente do worker-gpu (contracts/worker-gpu.md).

export interface WorkerHealth {
  ok: boolean;
  model: string;
  compute_type: string;
  device: string;
  diarization: "enabled" | "disabled" | "unavailable";
  diarization_reason: string | null;
  error: string | null;
}

export interface ChunkSegment {
  start: number;
  end: number;
  text: string;
}

export interface ChunkResponse {
  duration: number;
  speech_seconds: number;
  elapsed: number;
  segments: ChunkSegment[];
}

export interface JobFile {
  path: string;
  channel: Channel;
  diarize: boolean;
}

export interface JobChannelResult {
  channel: Channel;
  duration: number;
  diarized: boolean;
  segments: (ChunkSegment & { speaker: string | null })[];
}

interface JobStatus {
  status: "queued" | "running" | "done" | "error";
  step: string | null;
  progress: number;
  error: string | null;
  result: { channels: JobChannelResult[] } | null;
}

export class WorkerUnavailableError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function workerHealth(): Promise<WorkerHealth | null> {
  try {
    const res = await fetch(`${config.workerUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as WorkerHealth;
  } catch {
    return null;
  }
}

export async function workerGpu(): Promise<GpuStats | null> {
  try {
    const res = await fetch(`${config.workerUrl}/gpu`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { name: string; utilization: number; memory_used_mb: number; memory_total_mb: number };
    return {
      name: data.name,
      utilization: data.utilization,
      memoryUsedMb: data.memory_used_mb,
      memoryTotalMb: data.memory_total_mb,
    };
  } catch {
    return null;
  }
}

export async function transcribeChunk(
  pcm: Buffer,
  opts: { language: string; prompt?: string; channel: Channel },
): Promise<ChunkResponse> {
  const params = new URLSearchParams({ language: opts.language, channel: opts.channel });
  if (opts.prompt) params.set("prompt", opts.prompt.slice(0, 400));
  let res: Response;
  try {
    res = await fetch(`${config.workerUrl}/transcribe/chunk?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new WorkerUnavailableError(`worker-gpu indisponível: ${(err as Error).message}`);
  }
  if (res.status === 503) throw new WorkerUnavailableError("worker-gpu carregando o modelo");
  if (!res.ok) throw new Error(`worker-gpu respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as ChunkResponse;
}

async function submitJob(files: JobFile[], opts: { language: string; prompt?: string }, deadline: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${config.workerUrl}/jobs/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: opts.language, prompt: opts.prompt?.slice(0, 400) || null, files }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 202) return ((await res.json()) as { job_id: string }).job_id;
      const text = (await res.text()).slice(0, 300);
      if (res.status !== 503) throw new Error(`worker-gpu recusou o job (${res.status}): ${text}`);
    } catch (err) {
      if (!(err instanceof TypeError) && (err as Error).name !== "TimeoutError") throw err;
    }
    if (Date.now() > deadline) throw new WorkerUnavailableError("worker-gpu indisponível há mais de 15 minutos");
    console.warn(`[worker] indisponível (tentativa ${attempt}); nova tentativa em 10s`);
    await sleep(10_000);
  }
}

// Envia um job e acompanha até o fim. Se o worker reiniciar (job some → 404),
// o job é reenviado.
export async function runTranscriptionJob(
  files: JobFile[],
  opts: { language: string; prompt?: string },
  onProgress?: (step: string | null, progress: number) => void,
): Promise<JobChannelResult[]> {
  const WAIT_MS = 15 * 60_000;
  let deadline = Date.now() + WAIT_MS;
  let jobId = await submitJob(files, opts, deadline);
  let resubmits = 0;
  for (;;) {
    await sleep(2000);
    let status: JobStatus | null = null;
    try {
      const res = await fetch(`${config.workerUrl}/jobs/${jobId}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) {
        if (++resubmits > 3) throw new Error("worker-gpu perdeu o job repetidas vezes");
        console.warn(`[worker] job ${jobId} perdido (worker reiniciou?); reenviando`);
        deadline = Date.now() + WAIT_MS;
        jobId = await submitJob(files, opts, deadline);
        continue;
      }
      status = (await res.json()) as JobStatus;
      deadline = Date.now() + WAIT_MS;
    } catch (err) {
      if (Date.now() > deadline) throw new WorkerUnavailableError(`worker-gpu indisponível: ${(err as Error).message}`);
      continue;
    }
    if (status.status === "done") return status.result?.channels ?? [];
    if (status.status === "error") throw new Error(`Falha na transcrição: ${status.error ?? "erro desconhecido"}`);
    onProgress?.(status.step, status.progress);
  }
}
