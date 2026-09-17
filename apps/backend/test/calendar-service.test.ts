import { describe, expect, it } from "vitest";
import { dayRange, decideUpsert, normalizeText, suggestProject } from "../src/calendar/rules";

const projects = [
  { id: "p1", name: "Farmácia Digital", keywords: [] },
  { id: "p2", name: "SUS Escolha", keywords: ["sus-escolha"] },
  { id: "p3", name: "Portal SES", keywords: [] },
  { id: "p4", name: "InfraVision", keywords: ["infra vision", "iv"] },
  { id: "p5", name: "Agenith", keywords: [] },
];

describe("suggestProject", () => {
  it("encontra pelo nome sem acento e sem caixa", () => {
    expect(suggestProject("Daily farmacia digital", projects)?.id).toBe("p1");
    expect(suggestProject("PORTAL SES - integração", projects)?.id).toBe("p3");
  });

  it("usa palavras-chave e respeita limites de palavra", () => {
    expect(suggestProject("Revisão Infra Vision", projects)?.id).toBe("p4");
    expect(suggestProject("Alinhamento IV", projects)?.id).toBe("p4");
    expect(suggestProject("Revisão de privacidade", projects)).toBeNull(); // "iv" dentro de palavra
  });

  it("sem correspondência retorna null", () => {
    expect(suggestProject("1:1 com gestor", projects)).toBeNull();
  });

  it("prefere o nome mais longo", () => {
    const list = [
      { id: "a", name: "SES", keywords: [] },
      { id: "b", name: "Portal SES", keywords: [] },
    ];
    expect(suggestProject("Portal SES", list)?.id).toBe("b");
  });
});

describe("normalizeText", () => {
  it("remove acentos e pontuação", () => {
    expect(normalizeText("Integração: Regulação/SUS!")).toBe("integracao regulacao sus");
  });
});

describe("decideUpsert", () => {
  const base = { status: "scheduled" as const, ical_sequence: 1, changed: true };

  it("cria quando não existe", () => {
    expect(decideUpsert(null, { sequence: 0, cancelled: false })).toBe("create");
  });

  it("atualiza quando SEQUENCE é igual ou maior e ainda não gravou", () => {
    expect(decideUpsert(base, { sequence: 1, cancelled: false })).toBe("update");
    expect(decideUpsert({ ...base, status: "skipped" }, { sequence: 2, cancelled: false })).toBe("update");
    expect(decideUpsert({ ...base, status: "missed" }, { sequence: 2, cancelled: false })).toBe("update");
  });

  it("ignora versão antiga, sem mudanças ou reunião já gravada", () => {
    expect(decideUpsert(base, { sequence: 0, cancelled: false })).toBe("unchanged");
    expect(decideUpsert({ ...base, changed: false }, { sequence: 1, cancelled: false })).toBe("unchanged");
    expect(decideUpsert({ ...base, status: "recording" }, { sequence: 5, cancelled: false })).toBe("unchanged");
    expect(decideUpsert({ ...base, status: "done" }, { sequence: 5, cancelled: true })).toBe("unchanged");
  });

  it("cancela reunião ainda não gravada", () => {
    expect(decideUpsert(base, { sequence: 1, cancelled: true })).toBe("cancel");
    expect(decideUpsert({ ...base, status: "cancelled" }, { sequence: 1, cancelled: true })).toBe("unchanged");
    expect(decideUpsert(null, { sequence: 1, cancelled: true })).toBe("ignore");
  });

  it("reativa reunião cancelada quando chega versão nova", () => {
    expect(decideUpsert({ ...base, status: "cancelled" }, { sequence: 2, cancelled: false })).toBe("update");
  });
});

describe("dayRange", () => {
  it("calcula o dia no fuso de São Paulo", () => {
    const { start, end } = dayRange("2026-09-16", "America/Sao_Paulo");
    expect(start.toISOString()).toBe("2026-09-16T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-17T03:00:00.000Z");
  });

  it("funciona em fuso com horário de verão", () => {
    const { start, end } = dayRange("2026-03-08", "America/New_York");
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("recusa data inválida", () => {
    expect(() => dayRange("16/09/2026", "America/Sao_Paulo")).toThrow();
  });
});
