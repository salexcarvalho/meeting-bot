import { randomUUID } from "crypto";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import path from "path";
import type { Response } from "express";
import { config } from "../config";

// Fotos e voz ficam no disco local (nunca saem da máquina), um diretório por usuário.

export interface Sniffed {
  ext: string;
  mime: string;
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const AUDIO_MIME: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString("latin1");

// Tipo real pelo conteúdo (magic bytes), ignorando o nome e o Content-Type enviados. Sem SVG.
export function sniffImage(buf: Buffer): Sniffed | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: IMAGE_MIME.png };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { ext: "jpg", mime: IMAGE_MIME.jpg };
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return { ext: "webp", mime: IMAGE_MIME.webp };
  return null;
}

export function sniffAudio(buf: Buffer): Sniffed | null {
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { ext: "webm", mime: AUDIO_MIME.webm };
  if (ascii(buf, 0, 4) === "OggS") return { ext: "ogg", mime: AUDIO_MIME.ogg };
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WAVE") return { ext: "wav", mime: AUDIO_MIME.wav };
  if (ascii(buf, 4, 8) === "ftyp") return { ext: "m4a", mime: AUDIO_MIME.m4a };
  if (ascii(buf, 0, 3) === "ID3" || startsWith(buf, [0xff, 0xfb]) || startsWith(buf, [0xff, 0xf3])) {
    return { ext: "mp3", mime: AUDIO_MIME.mp3 };
  }
  return null;
}

export function profileDir(userId: string): string {
  return path.join(config.dataDir, "profiles", userId);
}

const FILE_RE = /^[a-z-]+-[0-9a-f-]{36}\.(png|jpg|webp|webm|ogg|wav|m4a|mp3)$/;

/** Caminho absoluto de um arquivo salvo; recusa nomes fora do padrão gerado aqui. */
export function profileFilePath(userId: string, file: string): string | null {
  if (!FILE_RE.test(file)) return null;
  return path.join(profileDir(userId), file);
}

export async function saveProfileFile(userId: string, prefix: string, sniffed: Sniffed, data: Buffer): Promise<string> {
  const dir = profileDir(userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${prefix}-${randomUUID()}.${sniffed.ext}`;
  const tmp = path.join(dir, `.${name}.part`);
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path.join(dir, name));
  return name;
}

export async function removeProfileFile(userId: string, file: string | null): Promise<void> {
  const full = file ? profileFilePath(userId, file) : null;
  if (full) await rm(full, { force: true });
}

export async function removeProfileDir(userId: string): Promise<void> {
  await rm(profileDir(userId), { recursive: true, force: true });
}

export function mimeOf(file: string): string {
  const ext = path.extname(file).slice(1);
  return IMAGE_MIME[ext] ?? AUDIO_MIME[ext] ?? "application/octet-stream";
}

export function sendProfileFile(res: Response, userId: string, file: string | null, versioned: boolean): void {
  const full = file ? profileFilePath(userId, file) : null;
  if (!full) {
    res.status(404).json({ error: "Arquivo não encontrado." });
    return;
  }
  res.sendFile(
    full,
    {
      headers: {
        "Content-Type": mimeOf(full),
        "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache",
        "Content-Disposition": "inline",
      },
    },
    (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Arquivo não encontrado." });
    },
  );
}
