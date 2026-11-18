import { describe, expect, it } from "vitest";
import {
  disambiguateNames,
  foldName,
  identifyTile,
  isPresentationTile,
  isSelfMarked,
  normalizeDisplayName,
  participantKey,
} from "../src/bot/speakers/names";

describe("normalizeDisplayName", () => {
  it("remove marcadores em português e inglês", () => {
    expect(normalizeDisplayName("Maria Souza (Você)")).toBe("Maria Souza");
    expect(normalizeDisplayName("Maria Souza (You)")).toBe("Maria Souza");
    expect(normalizeDisplayName("João Lima (Convidado)")).toBe("João Lima");
    expect(normalizeDisplayName("João Lima (Guest)")).toBe("João Lima");
    expect(normalizeDisplayName("Ana (External)")).toBe("Ana");
    expect(normalizeDisplayName("Ana (Externo)")).toBe("Ana");
  });

  it("remove o estado do microfone e da câmera depois da vírgula", () => {
    expect(normalizeDisplayName("Maria Souza, Microphone muted")).toBe("Maria Souza");
    expect(normalizeDisplayName("Maria Souza, Microfone desativado, Câmera ligada")).toBe("Maria Souza");
    expect(normalizeDisplayName("Maria Souza, speaking")).toBe("Maria Souza");
  });

  it("mantém vírgula que faz parte do nome e parênteses que não são marcador", () => {
    expect(normalizeDisplayName("Souza, Maria")).toBe("Souza, Maria");
    expect(normalizeDisplayName("Maria (Financeiro)")).toBe("Maria (Financeiro)");
  });

  it("tira espaços extras, caracteres de controle e invisíveis", () => {
    expect(normalizeDisplayName("  Maria \u0000  ​Souza\n ")).toBe("Maria Souza");
  });

  it("limita a 120 caracteres e a entrada gigante não trava", () => {
    expect(normalizeDisplayName("a".repeat(500))).toHaveLength(120);
    const started = performance.now();
    normalizeDisplayName(`${"(".repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("identifyTile", () => {
  it("ignora o assistente (com ou sem acento e caixa), a própria conta, apresentação e vazio", () => {
    expect(identifyTile("Ata do Sérgio", "ata do sergio")).toEqual({ name: null, ignored: "assistant" });
    expect(identifyTile("Maria (Você)", "Ata")).toEqual({ name: null, ignored: "self" });
    expect(identifyTile("Maria está apresentando", "Ata")).toEqual({ name: null, ignored: "presentation" });
    expect(identifyTile("Maria is presenting", "Ata")).toEqual({ name: null, ignored: "presentation" });
    expect(identifyTile("  (Guest) ", "Ata")).toEqual({ name: null, ignored: "empty" });
    expect(identifyTile("Maria Souza, Muted", "Ata")).toEqual({ name: "Maria Souza" });
  });

  it("detecta marcador próprio e apresentação", () => {
    expect(isSelfMarked("Eu (Eu)")).toBe(true);
    expect(isSelfMarked("Maria")).toBe(false);
    expect(isPresentationTile("Presenting: Maria")).toBe(true);
  });
});

describe("chave e desambiguação", () => {
  it("usa o identificador da plataforma e, sem ele, o nome sem acento nem caixa", () => {
    expect(participantKey("devices/12", "Maria")).toBe("id:devices/12");
    expect(participantKey("", "João Lima")).toBe(participantKey(undefined, "joão  LIMA"));
    expect(participantKey("", "Joao Lima")).toBe("name:joao lima");
    expect(foldName("  Ação  Já ")).toBe("acao ja");
  });

  it("duas pessoas com o mesmo nome viram 'Nome' e 'Nome (2)' na ordem da primeira fala", () => {
    const names = disambiguateNames([
      { key: "b", name: "Maria", firstAt: 30 },
      { key: "a", name: "Maria", firstAt: 10 },
      { key: "c", name: "João", firstAt: 5 },
    ]);
    expect(names.get("a")).toBe("Maria");
    expect(names.get("b")).toBe("Maria (2)");
    expect(names.get("c")).toBe("João");
  });
});
