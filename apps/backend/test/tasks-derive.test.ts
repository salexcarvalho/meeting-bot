import { describe, expect, it } from "vitest";
import { deriveTitle, parseDueText } from "../src/tasks/derive";

const TZ = "America/Sao_Paulo";
// Reunião em 12/11/2026 10:00 em São Paulo.
const MEETING = new Date("2026-11-12T13:00:00Z");

describe("deriveTitle", () => {
  it("usa a primeira frase curta sem o ponto final", () => {
    expect(deriveTitle("Enviar o desenho da integração até 30/11. Depois alinhar com o time.")).toBe(
      "Enviar o desenho da integração até 30/11",
    );
  });

  it("não corta em ponto dentro de número ou sigla colada", () => {
    expect(deriveTitle("Revisar contrato v1.2 com o jurídico")).toBe("Revisar contrato v1.2 com o jurídico");
  });

  it("para na primeira interrogação ou exclamação", () => {
    expect(deriveTitle("Quem envia o relatório? Ficou em aberto.")).toBe("Quem envia o relatório?");
  });

  it("usa só a primeira linha e colapsa espaços", () => {
    expect(deriveTitle("  Ligar   para o fornecedor\nconfirmar prazo  ")).toBe("Ligar para o fornecedor");
  });

  it("corta em palavra inteira com reticências quando passa de 120 caracteres", () => {
    const text = "palavra ".repeat(40).trim();
    const title = deriveTitle(text);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.slice(0, -1).endsWith("palavra")).toBe(true);
  });

  it("texto de uma palavra só e longo é cortado seco", () => {
    const title = deriveTitle("x".repeat(300));
    expect(title).toBe(`${"x".repeat(120)}…`);
  });

  it("frase curtíssima cai para o texto inteiro", () => {
    expect(deriveTitle("Ok. Enviar a planilha final")).toBe("Ok. Enviar a planilha final");
  });
});

describe("parseDueText", () => {
  const parse = (text: string | null) => parseDueText(text, MEETING, TZ);

  it("entende datas inequívocas", () => {
    expect(parse("30/11")).toEqual({ date: "2026-11-30", hint: null });
    expect(parse("30/11/2026")).toEqual({ date: "2026-11-30", hint: null });
    expect(parse("30/11/26")).toEqual({ date: "2026-11-30", hint: null });
    expect(parse("2026-11-30")).toEqual({ date: "2026-11-30", hint: null });
  });

  it("aceita prefixos como 'até', 'para o dia' e acentos", () => {
    expect(parse("até 5/12")).toEqual({ date: "2026-12-05", hint: null });
    expect(parse("Até o dia 05/12")).toEqual({ date: "2026-12-05", hint: null });
    expect(parse("para o dia 20/11")).toEqual({ date: "2026-11-20", hint: null });
  });

  it("dd/mm antes da data da reunião vai para o ano seguinte", () => {
    expect(parse("05/11")).toEqual({ date: "2027-11-05", hint: null });
    expect(parse("12/11")).toEqual({ date: "2026-11-12", hint: null });
  });

  it("hoje e amanhã partem do dia da reunião no fuso do usuário", () => {
    expect(parse("hoje")).toEqual({ date: "2026-11-12", hint: null });
    expect(parse("Amanhã")).toEqual({ date: "2026-11-13", hint: null });
    // 01:30 UTC ainda é o dia anterior em São Paulo
    expect(parseDueText("hoje", new Date("2026-11-13T01:30:00Z"), TZ).date).toBe("2026-11-12");
  });

  it("dia da semana e expressões vagas ficam só como prazo dito", () => {
    for (const text of ["sexta-feira", "semana que vem", "fim do mês", "próximo mês"]) {
      expect(parse(text)).toEqual({ date: null, hint: text });
    }
  });

  it("data impossível ou ambígua não vira data", () => {
    expect(parse("31/02")).toEqual({ date: null, hint: "31/02" });
    expect(parse("30/11 ou 05/12").date).toBeNull();
  });

  it("entrada vazia ou nula não tem prazo", () => {
    expect(parse("")).toEqual({ date: null, hint: null });
    expect(parse("   ")).toEqual({ date: null, hint: null });
    expect(parse(null)).toEqual({ date: null, hint: null });
  });

  it("limita o prazo dito a 120 caracteres", () => {
    expect(parse("x ".repeat(200)).hint?.length).toBeLessThanOrEqual(120);
  });
});
