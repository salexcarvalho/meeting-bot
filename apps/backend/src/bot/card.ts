import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";

// Imagem que a câmera do assistente mostra na reunião (constituição 1.6.0, princípio II): só o
// ícone do agente, parado. Convidado anônimo não tem foto no Meet/Teams; a câmera virtual é o
// único jeito de a imagem aparecer. O Chromium lê o .y4m como webcam
// (--use-file-for-fake-video-capture) e repete o quadro; nada é filmado.

export const CARD_WIDTH = 1280;
export const CARD_HEIGHT = 720;
const ICON = 440;

const CIRCLE = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*lte(hypot(X-(W-1)/2,Y-(H-1)/2),W/2)'`;

/** Argumentos do ffmpeg: ícone recortado em círculo, centralizado num fundo escuro, um quadro. */
export function cardArgs(iconPath: string, out: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x161b26:s=${CARD_WIDTH}x${CARD_HEIGHT}:r=15:d=1`,
    "-i",
    iconPath,
    "-filter_complex",
    `[1:v]scale=${ICON}:${ICON}:force_original_aspect_ratio=increase,crop=${ICON}:${ICON},${CIRCLE}[icon];` +
      `[0:v][icon]overlay=x=(W-w)/2:y=(H-h)/2,format=yuv420p[out]`,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-r",
    "15",
    "-f",
    "yuv4mpegpipe",
    out,
  ];
}

function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.trim()}`));
    });
  });
}

export interface CameraCard {
  file: string;
  dispose(): Promise<void>;
}

/** Gera o cartão num diretório temporário (apagado por `dispose`). */
export async function createCameraCard(iconPath: string, timeoutMs = 15_000): Promise<CameraCard> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mb-card-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  const file = path.join(dir, "camera.y4m");
  try {
    await run(cardArgs(iconPath, file), timeoutMs);
    return { file, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}
