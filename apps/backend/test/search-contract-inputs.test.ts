import { describe, expect, it } from "vitest";
import { ChatRequest, SearchQuery } from "@meeting-bot/contracts";

// Entradas que o Postgres recusaria (NUL, dia inexistente) são barradas no contrato: 400, nunca 500.
describe("contrato da busca: entradas inválidas", () => {
  it("recusa NUL na consulta, na pergunta e no histórico", () => {
    expect(SearchQuery.safeParse({ q: "a\u0000b" }).success).toBe(false);
    expect(ChatRequest.safeParse({ question: "a\u0000b" }).success).toBe(false);
    expect(ChatRequest.safeParse({ question: "ok", history: [{ role: "user", content: "a\u0000b" }] }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "certificado" }).success).toBe(true);
  });

  it("recusa dia inexistente e ano fora do tipo date; aceita dia real", () => {
    for (const from of ["2026-02-30", "2026-04-31", "2026-13-01", "0000-01-01", "2026-02-31T10:00:00Z"]) {
      expect(SearchQuery.safeParse({ q: "x", from }).success, from).toBe(false);
    }
    for (const from of ["2026-02-28", "2024-02-29", "2026-11-15T10:00:00Z"]) {
      expect(SearchQuery.safeParse({ q: "x", from }).success, from).toBe(true);
    }
    expect(ChatRequest.safeParse({ question: "x", scope: { to: "2026-02-30" } }).success).toBe(false);
  });
});
