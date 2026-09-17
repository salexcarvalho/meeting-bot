// Segmentação do PCM ao vivo por energia (research.md R3).
// Quadros de 30 ms; corta numa pausa ≥ 500 ms depois de ≥ 8 s; aos 30 s força o corte
// no quadro mais silencioso dos últimos 3 s. Trechos sem fala são marcados `silent`
// para não ocupar a GPU.

export const BYTES_PER_SECOND = 32_000;
const FRAME_BYTES = 960; // 30 ms de s16le 16 kHz mono
const FRAME_SECONDS = FRAME_BYTES / BYTES_PER_SECOND;

export interface Chunk {
  offsetBytes: number;
  pcm: Buffer;
  silent: boolean;
}

export interface ChunkerOptions {
  minSeconds?: number;
  maxSeconds?: number;
  pauseMs?: number;
  forceWindowSeconds?: number;
  minSpeechMs?: number;
}

// Piso de ruído: percentil 20 dos últimos 10 s, limitado a uma faixa plausível
// (fala contínua não pode virar "ruído").
const HISTORY_FRAMES = Math.round(10 / FRAME_SECONDS);
const FLOOR_MIN_RMS = 60;
const FLOOR_MAX_RMS = 600;
const SPEECH_FACTOR = 2.5;
const SPEECH_MIN_RMS = 250;
const FLOOR_REFRESH_FRAMES = 10;

interface Frame {
  data: Buffer;
  rms: number;
  speech: boolean;
}

function rmsOf(frame: Buffer): number {
  let sum = 0;
  const samples = frame.length >> 1;
  for (let i = 0; i < samples; i++) {
    const v = frame.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export class Chunker {
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private readonly pauseFrames: number;
  private readonly forceWindowFrames: number;
  private readonly minSpeechFrames: number;

  private offset: number;
  private pending: Buffer = Buffer.alloc(0);
  private frames: Frame[] = [];
  private silentRun = 0;
  private history: number[] = [];
  private historyPos = 0;
  private sinceFloor = FLOOR_REFRESH_FRAMES;
  private threshold = SPEECH_MIN_RMS;

  constructor(offsetBytes = 0, opts: ChunkerOptions = {}) {
    this.offset = offsetBytes;
    this.minFrames = Math.round((opts.minSeconds ?? 8) / FRAME_SECONDS);
    this.maxFrames = Math.round((opts.maxSeconds ?? 30) / FRAME_SECONDS);
    this.pauseFrames = Math.ceil((opts.pauseMs ?? 500) / 1000 / FRAME_SECONDS);
    this.forceWindowFrames = Math.round((opts.forceWindowSeconds ?? 3) / FRAME_SECONDS);
    this.minSpeechFrames = Math.ceil((opts.minSpeechMs ?? 300) / 1000 / FRAME_SECONDS);
  }

  // Byte (no arquivo do canal) em que começa o próximo trecho.
  get nextOffset(): number {
    return this.offset;
  }

  get bufferedBytes(): number {
    return this.frames.length * FRAME_BYTES + this.pending.length;
  }

  reset(offsetBytes: number): void {
    this.offset = offsetBytes;
    this.pending = Buffer.alloc(0);
    this.frames = [];
    this.silentRun = 0;
  }

  push(data: Buffer): Chunk[] {
    const buf = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const whole = buf.length - (buf.length % FRAME_BYTES);
    const out: Chunk[] = [];
    for (let pos = 0; pos < whole; pos += FRAME_BYTES) {
      this.addFrame(buf.subarray(pos, pos + FRAME_BYTES), out);
    }
    this.pending = Buffer.from(buf.subarray(whole));
    return out;
  }

  // Entrega o que sobrou (fim da gravação).
  flush(): Chunk[] {
    const tail = this.pending.subarray(0, this.pending.length & ~1);
    this.pending = Buffer.alloc(0);
    if (!this.frames.length && !tail.length) return [];
    const chunk = this.cut(this.frames.length);
    if (tail.length) {
      chunk.pcm = Buffer.concat([chunk.pcm, tail]);
      this.offset += tail.length;
    }
    return [chunk];
  }

  private updateFloor(rms: number): void {
    if (this.history.length < HISTORY_FRAMES) this.history.push(rms);
    else {
      this.history[this.historyPos] = rms;
      this.historyPos = (this.historyPos + 1) % HISTORY_FRAMES;
    }
    if (++this.sinceFloor < FLOOR_REFRESH_FRAMES) return;
    this.sinceFloor = 0;
    const sorted = [...this.history].sort((a, b) => a - b);
    const p20 = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
    const floor = Math.min(FLOOR_MAX_RMS, Math.max(FLOOR_MIN_RMS, p20));
    this.threshold = Math.max(SPEECH_MIN_RMS, floor * SPEECH_FACTOR);
  }

  private addFrame(data: Buffer, out: Chunk[]): void {
    const rms = rmsOf(data);
    this.updateFloor(rms);
    const speech = rms >= this.threshold;
    this.frames.push({ data, rms, speech });
    this.silentRun = speech ? 0 : this.silentRun + 1;

    const n = this.frames.length;
    if (n >= this.minFrames && this.silentRun >= this.pauseFrames) {
      out.push(this.cut(n));
    } else if (n >= this.maxFrames) {
      let best = n - 1;
      for (let i = Math.max(0, n - this.forceWindowFrames); i < n; i++) {
        if (this.frames[i].rms < this.frames[best].rms) best = i;
      }
      out.push(this.cut(best + 1));
    }
  }

  private cut(count: number): Chunk {
    const taken = this.frames.slice(0, count);
    this.frames = this.frames.slice(count);
    const speechFrames = taken.reduce((acc, f) => acc + (f.speech ? 1 : 0), 0);
    const chunk: Chunk = {
      offsetBytes: this.offset,
      pcm: Buffer.concat(taken.map((f) => f.data)),
      silent: speechFrames < this.minSpeechFrames,
    };
    this.offset += count * FRAME_BYTES;
    let run = 0;
    for (let i = this.frames.length - 1; i >= 0 && !this.frames[i].speech; i--) run++;
    this.silentRun = run;
    return chunk;
  }
}
