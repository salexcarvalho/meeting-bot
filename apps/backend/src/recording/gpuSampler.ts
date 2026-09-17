import type { GpuStats } from "@meeting-bot/contracts";
import { workerGpu } from "../asr/workerClient";
import { hub } from "../live/hub";
import { queueState } from "../pipeline";
import { hasActiveRecording } from "./scheduler";

// Uso da GPU publicado a cada 5 s enquanto houver gravação ou processamento.
const SAMPLE_MS = 5_000;
let timer: NodeJS.Timeout | null = null;
let last: { at: number; stats: GpuStats } | null = null;
let sampling = false;

export async function sampleGpu(): Promise<GpuStats | null> {
  const stats = await workerGpu();
  if (stats) last = { at: Date.now(), stats };
  return stats;
}

export function lastGpu(): GpuStats | null {
  return last && Date.now() - last.at < 60_000 ? last.stats : null;
}

async function tick(): Promise<void> {
  if (sampling) return;
  if (!hasActiveRecording() && queueState().pending === 0 && !hub.size) return;
  sampling = true;
  try {
    const stats = await sampleGpu();
    if (stats && (hasActiveRecording() || queueState().pending > 0)) hub.publishAll({ type: "gpu", ...stats });
  } finally {
    sampling = false;
  }
}

export function startGpuSampler(): void {
  timer ??= setInterval(() => void tick(), SAMPLE_MS);
  timer.unref();
}

export function stopGpuSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
