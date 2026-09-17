import { describe, expect, it } from "vitest";
import { BYTES_PER_SECOND, Chunker, type Chunk } from "../src/recording/chunker";

const RATE = 16_000;

function tone(seconds: number, amplitude = 8000, freq = 440): Buffer {
  const samples = Math.round(seconds * RATE);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  }
  return buf;
}

const silence = (seconds: number) => Buffer.alloc(Math.round(seconds * RATE) * 2);

// Entrega em frames de tamanhos variados, como o WebSocket faria.
function feed(chunker: Chunker, audio: Buffer, frame = 6_400): Chunk[] {
  const out: Chunk[] = [];
  for (let pos = 0; pos < audio.length; pos += frame) out.push(...chunker.push(audio.subarray(pos, pos + frame)));
  return out;
}

const seconds = (c: Chunk) => c.pcm.length / BYTES_PER_SECOND;

describe("Chunker", () => {
  it("corta na pausa de 500 ms depois de 8 s de áudio", () => {
    const chunker = new Chunker();
    const chunks = feed(chunker, Buffer.concat([tone(10), silence(1), tone(5)]));
    expect(chunks).toHaveLength(1);
    expect(seconds(chunks[0])).toBeGreaterThan(10.4);
    expect(seconds(chunks[0])).toBeLessThan(10.7);
    expect(chunks[0].silent).toBe(false);
  });

  it("não corta em pausa antes de 8 s", () => {
    const chunker = new Chunker();
    const chunks = feed(chunker, Buffer.concat([tone(3), silence(1), tone(3)]));
    expect(chunks).toHaveLength(0);
    const rest = chunker.flush();
    expect(rest).toHaveLength(1);
    expect(seconds(rest[0])).toBeCloseTo(7, 1);
  });

  it("força o corte aos 30 s no ponto de menor energia dos últimos 3 s", () => {
    const chunker = new Chunker();
    // Fala contínua com uma queda curta (200 ms) em 28 s, sem pausa de 500 ms.
    const audio = Buffer.concat([tone(28), tone(0.2, 50), tone(12)]);
    const chunks = feed(chunker, audio);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(seconds(chunks[0])).toBeGreaterThan(28);
    expect(seconds(chunks[0])).toBeLessThanOrEqual(28.25);
  });

  it("sem queda de energia, corta em no máximo 30 s", () => {
    const chunker = new Chunker();
    const chunks = feed(chunker, tone(65));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(seconds(c)).toBeLessThanOrEqual(30.01);
  });

  it("marca trechos de silêncio para não ir à GPU", () => {
    const chunker = new Chunker();
    const chunks = [...feed(chunker, silence(20)), ...chunker.flush()];
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.silent)).toBe(true);
  });

  it("ruído baixo constante não conta como fala", () => {
    const chunker = new Chunker();
    const chunks = [...feed(chunker, tone(12, 120, 60)), ...chunker.flush()];
    expect(chunks.every((c) => c.silent)).toBe(true);
  });

  it("mantém os offsets contínuos e cobre todos os bytes", () => {
    const chunker = new Chunker(64_000);
    const audio = Buffer.concat([tone(9), silence(0.7), tone(12), silence(2), tone(31), silence(0.3)]);
    const chunks = [...feed(chunker, audio, 4_096), ...chunker.flush()];
    let expected = 64_000;
    for (const c of chunks) {
      expect(c.offsetBytes).toBe(expected);
      expected += c.pcm.length;
    }
    expect(expected - 64_000).toBe(audio.length);
    expect(Buffer.concat(chunks.map((c) => c.pcm)).equals(audio)).toBe(true);
  });

  it("reset recomeça a partir do offset informado", () => {
    const chunker = new Chunker();
    feed(chunker, tone(5));
    chunker.reset(320_000);
    expect(chunker.bufferedBytes).toBe(0);
    const chunks = [...feed(chunker, tone(2)), ...chunker.flush()];
    expect(chunks[0].offsetBytes).toBe(320_000);
    expect(chunker.nextOffset).toBe(320_000 + tone(2).length);
  });
});
