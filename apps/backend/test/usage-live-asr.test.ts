import { describe, expect, it } from "vitest";
import { LiveAsrAccumulator, type LiveAsrDelta } from "../src/usage/liveAsr";

const MEETING = "11111111-1111-1111-1111-111111111111";
const FLUSH_MS = 10 * 60_000;

function setup() {
  const deltas: LiveAsrDelta[] = [];
  const clock = { now: 1_000_000 };
  const acc = new LiveAsrAccumulator(() => FLUSH_MS, (d) => deltas.push(d), () => clock.now);
  return { acc, deltas, clock };
}

describe("acumulador do ASR ao vivo", () => {
  it("200 trechos não viram 200 linhas: uma por intervalo de flush", () => {
    const { acc, deltas, clock } = setup();
    for (let i = 0; i < 200; i++) {
      acc.add(MEETING, "mixed", { duration: 15, elapsed: 1.5 });
      clock.now += 5_000; // 200 trechos em ~16 min
    }
    acc.flush(MEETING, "mixed");
    expect(deltas.length).toBeLessThanOrEqual(3);
    expect(deltas.reduce((s, d) => s + d.audioSeconds, 0)).toBe(3000);
    expect(deltas.reduce((s, d) => s + d.chunks, 0)).toBe(200);
  });

  it("flush por tempo grava o delta e zera (sem dupla contagem no close)", () => {
    const { acc, deltas, clock } = setup();
    acc.add(MEETING, "remote", { duration: 20, elapsed: 2 });
    clock.now += FLUSH_MS;
    acc.add(MEETING, "remote", { duration: 10, elapsed: 1 });
    expect(deltas).toEqual([{ meetingId: MEETING, channel: "remote", audioSeconds: 30, computeMs: 3000, chunks: 2 }]);
    acc.flush(MEETING, "remote");
    acc.flush(MEETING, "remote");
    expect(deltas).toHaveLength(1);
  });

  it("flush no fechamento descarrega o que sobrou; sem áudio não grava linha", () => {
    const { acc, deltas } = setup();
    acc.add(MEETING, "mic", { duration: 12.5, elapsed: 0.8 });
    acc.flush(MEETING, "mic");
    expect(deltas).toEqual([{ meetingId: MEETING, channel: "mic", audioSeconds: 12.5, computeMs: 800, chunks: 1 }]);
    acc.flush(MEETING, "remote");
    acc.add(MEETING, "mixed", { duration: 0, elapsed: 0.1 });
    acc.flush(MEETING, "mixed");
    expect(deltas).toHaveLength(1);
  });

  it("canais e reuniões acumulam separados", () => {
    const { acc, deltas } = setup();
    acc.add(MEETING, "mic", { duration: 10, elapsed: 1 });
    acc.add(MEETING, "remote", { duration: 20, elapsed: 2 });
    acc.add("22222222-2222-2222-2222-222222222222", "mic", { duration: 30, elapsed: 3 });
    acc.flush(MEETING, "mic");
    acc.flush(MEETING, "remote");
    expect(deltas.map((d) => [d.channel, d.audioSeconds])).toEqual([
      ["mic", 10],
      ["remote", 20],
    ]);
  });

  it("valores negativos não diminuem o acumulado", () => {
    const { acc, deltas } = setup();
    acc.add(MEETING, "mic", { duration: 10, elapsed: 1 });
    acc.add(MEETING, "mic", { duration: -5, elapsed: -1 });
    acc.flush(MEETING, "mic");
    expect(deltas[0]).toMatchObject({ audioSeconds: 10, computeMs: 1000 });
  });
});
