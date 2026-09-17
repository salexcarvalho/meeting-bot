import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

export const run = promisify(execFile);

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  const value = Number(String(stdout).trim());
  if (!Number.isFinite(value)) throw new Error(`ffprobe sem duração para ${path.basename(file)}`);
  return value;
}

// Trecho [offset, offset+seconds) em Opus mono 16 kHz, na memória.
export async function opusSlice(file: string, offset: number, seconds: number): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-ss", offset.toFixed(3), "-t", seconds.toFixed(3), "-i", file,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
      "-f", "ogg", "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout as Buffer;
}
