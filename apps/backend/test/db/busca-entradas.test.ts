import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchHarness } from "./busca-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// Entradas hostis na busca e no chat: nenhuma pode virar 500 (consulta SQL, tsquery, datas).
describe.skipIf(!enabled)("busca: entradas hostis nunca viram erro 500", async () => {
  const { startSearchHarness, loadGolden } = await import("./busca-harness");
  const { setChatGenerator } = await import("../../src/search/chat/service");
  let h: SearchHarness;

  beforeAll(async () => {
    h = await startSearchHarness([["be-ana", "USER", "Ana Lima"]]);
    const loaded = await loadGolden(h, "be-ana");
    await h.index(...Object.values(loaded.meetings));
    setChatGenerator((async () => ({ answered: false, answer: "", citations: [] })) as never);
  });

  afterAll(async () => {
    setChatGenerator(null);
    await h.stop();
  });

  const queries = [
    "certificado\u0000digital",
    `"aspas abertas`,
    "a & b | !c <-> d :* ((",
    "'; DROP TABLE search_chunks; --",
    "\\",
    "-",
    "- - -",
    "OR OR OR",
    "ç~´`^ ñ 日本語 😀",
    "x".repeat(500),
  ];

  for (const mode of ["hybrid", "text", "semantic"]) {
    it.each(queries)(`busca (${mode}): %j responde sem erro`, async (q) => {
      const res = await h.call("be-ana", "GET", `/search?q=${encodeURIComponent(q)}&mode=${mode}`);
      expect(res.status).toBeLessThan(500);
    });
  }

  it("datas impossíveis ou fora do intervalo não viram 500", async () => {
    for (const extra of ["&from=2026-02-30", "&to=2026-13-01", "&from=2026-02-31T10:00:00Z", "&from=0000-01-01", "&to=99999-01-01"]) {
      const res = await h.call("be-ana", "GET", `/search?q=certificado${extra}`);
      expect(res.status, extra).toBe(400);
    }
  });

  it("chat: pergunta com NUL ou datas impossíveis não vira 500", async () => {
    const nul = await h.call("be-ana", "POST", "/search/chat", { question: "certificado\u0000digital do provedor" });
    expect(nul.status).toBe(400);
    const date = await h.call("be-ana", "POST", "/search/chat", { question: "certificado", scope: { from: "2026-02-30" } });
    expect(date.status).toBe(400);
    const hist = await h.call("be-ana", "POST", "/search/chat", {
      question: "certificado",
      history: [{ role: "user", content: "a\u0000b" }],
    });
    expect(hist.status).toBe(400);
  });
});
