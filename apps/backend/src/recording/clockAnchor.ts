import { BYTES_PER_SECOND } from "./chunker";

// Relógio da linha do tempo = relógio do áudio gravado (spec 006, plan D2). O .ogg e o PCM ao vivo saem do
// mesmo ffmpeg e começam juntos; cada bloco PCM chega depois de capturado, então o menor valor de
// (chegada − bytes/taxa) é a melhor estimativa do instante zero do áudio (erro = a menor latência do pipe).

const BYTES_PER_MS = BYTES_PER_SECOND / 1000;

export class ClockAnchor {
  private anchorMs: number | null = null;
  private bytes = 0;

  /** Registra um bloco PCM que acabou de chegar (`nowMs` = performance.now() do processo). */
  observe(blockBytes: number, nowMs: number): void {
    if (blockBytes <= 0) return;
    this.bytes += blockBytes;
    const candidate = nowMs - this.bytes / BYTES_PER_MS;
    if (this.anchorMs === null || candidate < this.anchorMs) this.anchorMs = candidate;
  }

  get ready(): boolean {
    return this.anchorMs !== null;
  }

  /** Segundos do áudio gravado em `nowMs`; null enquanto nenhum bloco chegou. */
  toSeconds(nowMs: number): number | null {
    if (this.anchorMs === null) return null;
    return Math.max(0, (nowMs - this.anchorMs) / 1000);
  }
}
