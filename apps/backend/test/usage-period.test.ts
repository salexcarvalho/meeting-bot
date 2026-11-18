import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/usage/cursor";
import { currentMonth, monthRange, PeriodError, resolvePeriod } from "../src/usage/period";

describe("período dos painéis (month ou from/to)", () => {
  const now = new Date("2026-11-15T15:00:00Z");

  it("sem parâmetros usa o mês corrente no fuso", () => {
    const period = resolvePeriod({}, now);
    expect(period.month).toBe("2026-11");
    expect(period.from.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(period.to.toISOString()).toBe("2026-12-01T03:00:00.000Z");
  });

  it("aceita month=AAAA-MM ou um intervalo livre", () => {
    expect(resolvePeriod({ month: "2026-09" }, now).month).toBe("2026-09");
    const range = resolvePeriod({ from: "2026-10-01T00:00:00Z", to: "2026-10-15T00:00:00Z" }, now);
    expect(range.month).toBeNull();
    expect(range.to.getTime()).toBeGreaterThan(range.from.getTime());
  });

  it("recusa month com from/to, to antes de from, só um dos dois e mês malformado", () => {
    const both = { month: "2026-09", from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" };
    expect(() => resolvePeriod(both, now)).toThrow(PeriodError);
    expect(() => resolvePeriod({ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, now)).toThrow(/depois de from/);
    expect(() => resolvePeriod({ from: "2026-10-01T00:00:00Z" }, now)).toThrow(PeriodError);
    expect(() => resolvePeriod({ month: "2026-13" }, now)).toThrow(PeriodError);
    expect(() => resolvePeriod({ month: "09/2026" }, now)).toThrow(PeriodError);
    expect(() => resolvePeriod({ from: "ontem", to: "hoje" }, now)).toThrow(PeriodError);
  });

  it("janela máxima de 24 meses", () => {
    expect(() => resolvePeriod({ from: "2024-01-01T00:00:00Z", to: "2025-12-31T00:00:00Z" }, now)).not.toThrow();
    expect(() => resolvePeriod({ from: "2023-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, now)).toThrow(/24 meses/);
  });
});

describe("cursor de paginação", () => {
  it("ida e volta preservam o instante com microssegundos e o id", () => {
    const cursor = encodeCursor("2026-11-15 12:00:00.123456+00", "42");
    expect(decodeCursor(cursor)).toEqual({ at: "2026-11-15 12:00:00.123456+00", id: "42" });
  });

  it("cursor adulterado vira nulo (400), nunca vai para o SQL", () => {
    const tampered = [
      "lixo",
      "",
      encodeCursor("2026-11-15 12:00:00+00; select 1", "1"),
      encodeCursor("2026-11-15 12:00:00+00", "1 OR 1=1"),
      "A".repeat(300),
    ];
    for (const bad of tampered) expect(decodeCursor(bad)).toBeNull();
  });
});

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
