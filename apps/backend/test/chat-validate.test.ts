import { describe, expect, it } from "vitest";
import { CHAT_NOT_FOUND_ANSWER, type SearchHitValue } from "@meeting-bot/contracts";
import type { PromptSource } from "../src/search/chat/prompt";
import { cleanMarkers, validateChat } from "../src/search/chat/validate";

function source(partial: Partial<SearchHitValue> & { content: string }): PromptSource {
  const { content, ...rest } = partial;
  return {
    content,
    hit: {
      id: 1,
      kind: "transcript",
      meeting: { id: "m1", title: "Revisão", date: "2026-10-05T13:00:00.000Z", project: null },
      snippet: [],
      speaker: "Ana",
      matchedBy: ["text"],
      reviewStatus: null,
      target: { meetingId: "m1", kind: "transcript", segmentId: 10, start: 872, end: 940, itemId: null, adrId: null },
      ...rest,
    },
  };
}

const transcript = source({ content: "Ana: Fica decidido: tokens de duas horas com renovação automática.\nBia: Concordo." });
const item = source({
  id: 2,
  kind: "item",
  reviewStatus: "proposto",
  content: "Decisão: usar autenticação única",
  target: { meetingId: "m1", kind: "item", segmentId: null, start: null, end: null, itemId: "it1", adrId: null },
});

const out = (answer: string, citations: { ref: number; quote: string }[], answered = true) => ({ answered, answer, citations });

describe("validação das citações do chat", () => {
  it("descarta ref inexistente e remove o marcador correspondente", () => {
    const result = validateChat(out("Tokens de duas horas [1]. Outra coisa [7].", [{ ref: 1, quote: "tokens de duas horas" }, { ref: 7, quote: "x" }]), [transcript]);
    expect(result.answered).toBe(true);
    expect(result.citations.map((c) => c.ref)).toEqual([1]);
    expect(result.answer).toBe("Tokens de duas horas [1]. Outra coisa.");
  });

  it("quote conferida por normalização (acento, caixa, pontuação) vira exact=true", () => {
    const result = validateChat(out("Duas horas [1].", [{ ref: 1, quote: "TOKENS de duas horas, com RENOVACAO automática" }]), [transcript]);
    expect(result.citations[0]).toMatchObject({ ref: 1, exact: true, quote: "TOKENS de duas horas, com RENOVACAO automática", proposed: false });
  });

  it("quote que não está no trecho mantém a citação com exact=false e sem quote", () => {
    const result = validateChat(out("Algo [1].", [{ ref: 1, quote: "frase inventada pelo modelo" }]), [transcript]);
    expect(result.answered).toBe(true);
    expect(result.citations[0]).toMatchObject({ exact: false, quote: null });
    expect(result.citations[0].target.start).toBe(872);
  });

  it("localiza o segmento pela quote e usa o horário dele", () => {
    const locate = (_: PromptSource, quote: string) => (quote.includes("concordo") ? { segmentId: 12, start: 905 } : null);
    const result = validateChat(out("Concordaram [1].", [{ ref: 1, quote: "Concordo" }]), [transcript], locate);
    expect(result.citations[0].target).toMatchObject({ segmentId: 12, start: 905 });
    const miss = validateChat(out("x [1].", [{ ref: 1, quote: "tokens de duas horas" }]), [transcript], locate);
    expect(miss.citations[0].target).toMatchObject({ segmentId: 10, start: 872 });
  });

  it("item proposto fica sinalizado e aponta para o item", () => {
    const result = validateChat(out("Usar autenticação única [1].", [{ ref: 1, quote: "" }]), [item]);
    expect(result.citations[0]).toMatchObject({ proposed: true, exact: false });
    expect(result.citations[0].target.itemId).toBe("it1");
    expect(result.citations[0].label).toContain("item decisão, proposto");
  });

  it("answered=true sem nenhuma citação válida vira 'não encontrei'", () => {
    const result = validateChat(out("Resposta sem fonte.", []), [transcript]);
    expect(result).toEqual({ answered: false, answer: CHAT_NOT_FOUND_ANSWER, citations: [] });
    expect(validateChat(out("Fonte inexistente [4].", [{ ref: 4, quote: "a" }]), [transcript]).answered).toBe(false);
  });

  it("answered=false do modelo é respeitado, mesmo com citações", () => {
    expect(validateChat(out("", [{ ref: 1, quote: "a" }], false), [transcript]).answered).toBe(false);
    expect(validateChat(out("   ", [{ ref: 1, quote: "a" }]), [transcript]).answered).toBe(false);
  });

  it("citações duplicadas do mesmo trecho são mescladas, preferindo a conferida", () => {
    const result = validateChat(out("A [1] e B [1].", [{ ref: 1, quote: "nada a ver" }, { ref: 1, quote: "tokens de duas horas" }]), [transcript]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].exact).toBe(true);
    expect(result.answer).toBe("A [1] e B [1].");
  });

  it("limpeza de marcadores não deixa espaço solto antes da pontuação", () => {
    expect(cleanMarkers("Fato [2] , outro [1].", new Set([1]))).toBe("Fato, outro [1].");
  });
});
