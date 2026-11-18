import { describe, expect, it } from "vitest";
import { ClockAnchor } from "../src/recording/clockAnchor";

// 32 bytes por ms (16 kHz, s16le, mono)
const BYTES_100MS = 3200;

describe("âncora do relógio do áudio", () => {
  it("sem blocos não há relógio", () => {
    const anchor = new ClockAnchor();
    expect(anchor.ready).toBe(false);
    expect(anchor.toSeconds(1000)).toBeNull();
  });

  it("blocos regulares: o instante zero é a chegada menos o que já foi capturado", () => {
    const anchor = new ClockAnchor();
    for (let i = 1; i <= 10; i++) anchor.observe(BYTES_100MS, 5000 + i * 100);
    expect(anchor.toSeconds(6000)).toBeCloseTo(1, 3);
  });

  it("jitter: um bloco atrasado não desloca a âncora (vale o menor atraso)", () => {
    const anchor = new ClockAnchor();
    anchor.observe(BYTES_100MS, 5100);
    anchor.observe(BYTES_100MS, 5200 + 80);
    anchor.observe(BYTES_100MS, 5300);
    expect(anchor.toSeconds(5300)).toBeCloseTo(0.3, 3);
  });

  it("rajada: vários blocos de uma vez ainda dão o menor valor", () => {
    const anchor = new ClockAnchor();
    anchor.observe(BYTES_100MS, 5100);
    anchor.observe(BYTES_100MS * 5, 5900);
    expect(anchor.toSeconds(5900)).toBeCloseTo(0.9, 1);
    expect(anchor.toSeconds(5900)!).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it("perda de bloco só atrasa o relógio (nunca adianta além do real)", () => {
    const anchor = new ClockAnchor();
    anchor.observe(BYTES_100MS, 5100);
    // um bloco de 100 ms se perdeu: o byte contado fica atrás do tempo real
    anchor.observe(BYTES_100MS, 5300);
    expect(anchor.toSeconds(5300)!).toBeGreaterThanOrEqual(0.2);
  });

  it("monotônica: a âncora só diminui e o tempo nunca é negativo", () => {
    const anchor = new ClockAnchor();
    anchor.observe(BYTES_100MS, 5100);
    const first = anchor.toSeconds(6000)!;
    anchor.observe(BYTES_100MS, 5150);
    expect(anchor.toSeconds(6000)!).toBeGreaterThanOrEqual(first);
    expect(anchor.toSeconds(0)).toBe(0);
    anchor.observe(0, 9999);
    expect(anchor.toSeconds(6000)!).toBeGreaterThanOrEqual(first);
  });
});
