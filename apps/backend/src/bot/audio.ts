import { ChildProcessWithoutNullStreams, execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Cada reunião ganha seu próprio sink nulo no PulseAudio. O Chromium da
 * reunião toca nele (via PULSE_SINK) e o ffmpeg grava o .monitor — assim
 * duas reuniões simultâneas não misturam áudio.
 */
export async function createSink(sinkName: string): Promise<string> {
  const { stdout } = await execFileAsync("pactl", [
    "load-module",
    "module-null-sink",
    `sink_name=${sinkName}`,
    `sink_properties=device.description=${sinkName}`,
  ]);
  return stdout.trim();
}

export async function removeSink(moduleId: string): Promise<void> {
  await execFileAsync("pactl", ["unload-module", moduleId]).catch((err) =>
    console.error(`[audio] falha ao remover sink ${moduleId}:`, err.message)
  );
}

/**
 * Grava o sink em Opus e, com `onPcm`, entrega a mesma captura em PCM s16le 16 kHz mono
 * (saída padrão do ffmpeg) para a transcrição ao vivo.
 */
export function startRecording(
  sinkName: string,
  outPath: string,
  onPcm?: (pcm: Buffer) => void,
): ChildProcessWithoutNullStreams {
  // Opus mono 16kHz/32kbps: ~15MB por hora, suficiente pra fala.
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-y",
    "-f", "pulse",
    "-i", `${sinkName}.monitor`,
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libopus",
    "-b:a", "32k",
    "-application", "voip",
    // Grava no disco a cada pacote: dá pra ouvir o parcial durante a call.
    "-flush_packets", "1",
    outPath,
    ...(onPcm ? ["-ac", "1", "-ar", "16000", "-f", "s16le", "-flush_packets", "1", "pipe:1"] : []),
  ]);
  // O stdout sempre é lido: pipe cheio travaria a gravação do arquivo.
  ffmpeg.stdout.on("data", (data: Buffer) => {
    if (!onPcm) return;
    try {
      onPcm(data);
    } catch (err) {
      console.error(`[ffmpeg ${sinkName}] transcrição ao vivo:`, err);
    }
  });
  ffmpeg.stderr.on("data", (data) => console.error(`[ffmpeg ${sinkName}] ${String(data).trim()}`));
  return ffmpeg;
}

export async function stopRecording(ffmpeg: ChildProcessWithoutNullStreams): Promise<void> {
  if (ffmpeg.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => ffmpeg.once("close", () => resolve()));
  // "q" no stdin faz o ffmpeg fechar o arquivo direito (escreve o trailer).
  ffmpeg.stdin.write("q");
  ffmpeg.stdin.end();
  const timeout = setTimeout(() => ffmpeg.kill("SIGKILL"), 10_000);
  await closed;
  clearTimeout(timeout);
}
