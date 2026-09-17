import { describe, expect, it } from "vitest";
import { findDuplicate, jaccard, normalizeTokens, type DedupCandidate } from "../src/agent/dedup";

const existing: DedupCandidate[] = [
  { id: "1", type: "decisao", description: "Usar PostgreSQL como banco de dados principal do portal", reviewStatus: "proposto" },
  { id: "2", type: "pendencia", description: "João vai revisar a política de backup até sexta", reviewStatus: "aprovado" },
  { id: "3", type: "risco", description: "Atraso na integração com o SUS por causa do certificado", reviewStatus: "rejeitado" },
];

describe("normalizeTokens", () => {
  it("remove stopwords pt-BR, acentos e pontuação", () => {
    expect([...normalizeTokens("A política de backup, do Portal, é crítica!")]).toEqual([
      "politica",
      "backup",
      "portal",
      "critica",
    ]);
  });
});

describe("jaccard", () => {
  it("calcula interseção sobre união", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe("findDuplicate", () => {
  it("mescla item do mesmo tipo com Jaccard ≥ 0,55", () => {
    const dup = findDuplicate({ type: "decisao", description: "Usar o PostgreSQL como banco principal do portal" }, existing);
    expect(dup?.id).toBe("1");
  });

  it("não mescla tipos diferentes", () => {
    expect(
      findDuplicate({ type: "decisao_arquitetural", description: "Usar PostgreSQL como banco de dados principal do portal" }, existing),
    ).toBeNull();
  });

  it("não mescla itens só parecidos", () => {
    expect(findDuplicate({ type: "decisao", description: "Usar Redis como cache do portal" }, existing)).toBeNull();
  });

  it("devolve o rejeitado para o descarte silencioso", () => {
    const dup = findDuplicate(
      { type: "risco", description: "Integração com o SUS pode atrasar por causa do certificado" },
      existing,
    );
    expect(dup?.reviewStatus).toBe("rejeitado");
  });
});
