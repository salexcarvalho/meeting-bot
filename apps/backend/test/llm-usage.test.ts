import { describe, expect, it } from "vitest";
import { currentMonth, monthRange } from "../src/llm/usage";

// O relatório soma por mês no fuso da aplicação: a virada não pode cair no dia errado.
describe("mês do consumo de LLM", () => {
  it("vai da meia-noite do dia 1 à meia-noite do dia 1 do mês seguinte (America/Sao_Paulo)", () => {
    const { from, to } = monthRange("2026-09");
    expect(from.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("dezembro vira para janeiro do ano seguinte", () => {
    const { from, to } = monthRange("2026-12");
    expect(from.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(to.toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });

  it("recusa mês inválido", () => {
    expect(() => monthRange("2026-13")).toThrow(/AAAA-MM/);
    expect(() => monthRange("setembro")).toThrow(/AAAA-MM/);
  });

  it("mês corrente usa o fuso, não o UTC", () => {
    // 1º de outubro 00:30 UTC ainda é 30 de setembro em São Paulo
    expect(currentMonth(new Date("2026-10-01T00:30:00Z"))).toBe("2026-09");
    expect(currentMonth(new Date("2026-10-01T03:30:00Z"))).toBe("2026-10");
  });
});
