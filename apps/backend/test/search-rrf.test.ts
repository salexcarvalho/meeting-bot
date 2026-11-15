import { describe, expect, it } from "vitest";
import { dropNeighbors, fuse, RRF_K } from "../src/search/rrf";

describe("fusão RRF", () => {
  it("soma 1/(k+posição) das duas listas e marca de onde veio", () => {
    const fused = fuse({ text: [1, 2, 3], semantic: [3, 1] });
    const score = (rank: number) => 1 / (RRF_K + rank);
    expect(fused.map((f) => f.id)).toEqual([1, 3, 2]);
    expect(fused[0].score).toBeCloseTo(score(1) + score(2));
    expect(fused[0].matchedBy.sort()).toEqual(["semantic", "text"]);
    expect(fused[2].matchedBy).toEqual(["text"]);
  });

  it("empate: melhor posição individual, depois menor id", () => {
    // 1 e 2 têm o mesmo score somado; 1 tem a melhor posição individual
    const fused = fuse({ text: [1, 2], semantic: [2, 1] });
    expect(fused.map((f) => f.id)).toEqual([1, 2]);
    expect(fuse({ text: [9], semantic: [7] }).map((f) => f.id)).toEqual([7, 9]);
  });

  it("listas de tamanhos diferentes e uma lista vazia", () => {
    expect(fuse({ text: [], semantic: [5, 6] }).map((f) => f.id)).toEqual([5, 6]);
    expect(fuse({ text: [4] }).map((f) => f.matchedBy)).toEqual([["text"]]);
    expect(fuse({})).toEqual([]);
  });
});

describe("trechos vizinhos", () => {
  const hit = (id: number, meetingId: string, seq: number, kind = "transcript", sourceId = "") => ({ id, meetingId, seq, kind, sourceId });

  it("mantém só o melhor de dois trechos consecutivos da mesma reunião", () => {
    const kept = dropNeighbors([hit(1, "m1", 4), hit(2, "m1", 5), hit(3, "m1", 9), hit(4, "m2", 5)]);
    expect(kept.map((h) => h.id)).toEqual([1, 3, 4]);
  });

  it("não agrupa tipos ou origens diferentes", () => {
    const kept = dropNeighbors([hit(1, "m1", 0, "item", "a"), hit(2, "m1", 0, "item", "b"), hit(3, "m1", 0, "adr", "a")]);
    expect(kept.map((h) => h.id)).toEqual([1, 2, 3]);
  });
});
