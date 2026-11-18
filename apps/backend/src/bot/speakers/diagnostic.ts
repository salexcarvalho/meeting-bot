import { mkdir, writeFile } from "fs/promises";
import path from "path";
import type { Page } from "playwright";
import { config } from "../../config";
import { DIAGNOSTIC_SOURCE } from "./diagnosticSource";
import { withTimeout } from "./probe";

// Salva localmente, em DATA_DIR/debug/speakers/<reunião>/, a estrutura dos quadros da chamada (sem texto,
// nomes, áudio ou vídeo) a cada ciclo do coletor. Serve para a captura T001 e para recalibrar os seletores.

export const MAX_SNAPSHOTS = 120;
const MAX_NODES = 400;

export function diagnosticDir(meetingId: string): string {
  return path.join(config.dataDir, "debug", "speakers", meetingId);
}

export function createDiagnostic(page: Page, meetingId: string, log: (message: string) => void): () => Promise<void> {
  let count = 0;
  let announced = false;
  return async () => {
    if (count >= MAX_SNAPSHOTS || page.isClosed()) return;
    const frames: unknown[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const source = `(${DIAGNOSTIC_SOURCE})(${JSON.stringify({ maxNodes: MAX_NODES })})`;
      const snapshot = await withTimeout(frame.evaluate(source));
      if (snapshot) frames.push(snapshot);
    }
    if (!frames.length) return;
    const dir = diagnosticDir(meetingId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${String(count++).padStart(4, "0")}.json`), JSON.stringify({ frames }));
    if (!announced) {
      announced = true;
      log(`diagnóstico dos nomes: salvando a estrutura dos quadros em ${dir} (sem nomes, áudio ou vídeo)`);
    }
  };
}
