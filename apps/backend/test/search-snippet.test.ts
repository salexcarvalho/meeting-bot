import { describe, expect, it } from "vitest";
import { hasMatch, MARK_START, MARK_STOP, parseHeadline, plainSnippet } from "../src/search/snippet";

const mark = (text: string) => `${MARK_START}${text}${MARK_STOP}`;

describe("trecho com destaque (ts_headline)", () => {
  it("transforma os delimitadores em partes tipadas, sem HTML", () => {
    const parts = parseHeadline(`renovar os ${mark("certificados")} antes de janeiro`);
    expect(parts).toEqual([
      { text: "renovar os ", match: false },
      { text: "certificados", match: true },
      { text: " antes de janeiro", match: false },
    ]);
    expect(hasMatch(parts)).toBe(true);
  });

  it("não interpreta marcação do próprio conteúdo", () => {
    const parts = parseHeadline(`veja <b>${mark("isto")}</b> <script>x</script>`);
    expect(parts.map((p) => p.text).join("")).toBe("veja <b>isto</b> <script>x</script>");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["isto"]);
  });

  it("trunca em ~320 caracteres visíveis e junta partes vizinhas iguais", () => {
    const parts = parseHeadline(`${"a".repeat(200)} ${mark("b".repeat(200))}`);
    const total = parts.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(320);
    expect(parts.at(-1)?.match).toBe(true);
  });

  it("remove caracteres de controle e espaços repetidos", () => {
    expect(parseHeadline("a\u0000b\u0007   c")).toEqual([{ text: "ab c", match: false }]);
  });

  it("marcação não fechada destaca até o fim; entrada vazia dá lista vazia", () => {
    expect(parseHeadline(`${MARK_START}solto`)).toEqual([{ text: "solto", match: true }]);
    expect(parseHeadline("")).toEqual([]);
  });
});

describe("trecho sem destaque", () => {
  it("devolve o começo do conteúdo, cortado em fronteira de palavra", () => {
    const text = Array.from({ length: 200 }, (_, i) => `palavra${i}`).join(" ");
    const [part] = plainSnippet(text);
    expect(part.match).toBe(false);
    expect(part.text.length).toBeLessThanOrEqual(321);
    expect(part.text.endsWith("…")).toBe(true);
    expect(plainSnippet("curto")).toEqual([{ text: "curto", match: false }]);
    expect(plainSnippet("   ")).toEqual([]);
  });
});
