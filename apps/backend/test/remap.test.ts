import { describe, expect, it } from "vitest";
import { chunkSegments } from "../src/agent/chunks";
import { remapEvidence, type TimedSegment } from "../src/agent/remap";

const finals: TimedSegment[] = [
  { id: 1, channel: "remote", start: 0, end: 10 },
  { id: 2, channel: "remote", start: 10, end: 25 },
  { id: 3, channel: "mic", start: 12, end: 20 },
  { id: 4, channel: "remote", start: 60, end: 70 },
];

describe("remapEvidence", () => {
  it("escolhe a maior sobreposição no mesmo canal", () => {
    expect(remapEvidence({ channel: "remote", start: 8, end: 18 }, finals)).toBe(2);
    expect(remapEvidence({ channel: "mic", start: 8, end: 18 }, finals)).toBe(3);
  });

  it("sem sobreposição, usa o mais próximo em até 10 s", () => {
    expect(remapEvidence({ channel: "remote", start: 32, end: 35 }, finals)).toBe(2);
    expect(remapEvidence({ channel: "remote", start: 50, end: 52 }, finals)).toBe(4);
  });

  it("sem candidato, devolve null", () => {
    expect(remapEvidence({ channel: "remote", start: 40, end: 45 }, finals)).toBeNull();
    expect(remapEvidence({ channel: "mixed", start: 0, end: 5 }, finals)).toBeNull();
  });
});

describe("chunkSegments", () => {
  it("divide por tokens estimados com sobreposição de 2", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ id: i, text: "x".repeat(700) }));
    const chunks = chunkSegments(segs, 1_000);
    expect(chunks.map((c) => c.map((s) => s.id))).toEqual([
      [0, 1, 2, 3],
      [2, 3, 4, 5],
      [4, 5, 6, 7],
      [6, 7, 8, 9],
    ]);
  });

  it("segmento maior que a janela ainda avança", () => {
    const segs = [{ text: "y".repeat(20_000) }, { text: "z" }];
    expect(chunkSegments(segs, 100)).toHaveLength(2);
  });
});
