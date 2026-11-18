import { describe, expect, it } from "vitest";
import { matchSpeakers, nameSegments, type MatchInterval, type MatchSegment } from "../src/meetings/speakerNames";

interface Turn {
  label: string | null;
  key: string;
  name: string;
  start: number;
  end: number;
}

const WINDOWS: [string, string, string][] = [
  ["Speaker 1", "m", "Maria Souza"],
  ["Speaker 2", "j", "João Lima"],
  ["Speaker 3", "a", "Ana Costa"],
];

/** Conversa em rodízio: cada pessoa fala `turn` segundos por vez, `rounds` voltas. */
function conversation(rounds = 6, turn = 8, who = WINDOWS): Turn[] {
  const out: Turn[] = [];
  let t = 10;
  for (let r = 0; r < rounds; r++) {
    for (const [label, key, name] of who) {
      out.push({ label, key, name, start: t, end: t + turn });
      t += turn + 1;
    }
  }
  return out;
}

const segmentsOf = (turns: Turn[]): MatchSegment[] => turns.map((t) => ({ label: t.label, start: t.start + 0.2, end: t.end - 0.2 }));
const intervalsOf = (turns: Turn[], skew = 0): MatchInterval[] =>
  turns.map((t) => ({ key: t.key, name: t.name, start: t.start + skew, end: t.end + skew }));

describe("matchSpeakers: casos básicos", () => {
  it("cada Speaker N recebe o nome de quem aparece falando, com confiança alta", () => {
    const turns = conversation();
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns));
    expect(result.valid).toBe(true);
    expect(result.names.get("Speaker 1")?.name).toBe("Maria Souza");
    expect(result.names.get("Speaker 2")?.name).toBe("João Lima");
    expect(result.names.get("Speaker 3")?.name).toBe("Ana Costa");
    for (const decision of result.names.values()) expect(decision.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.undecided).toEqual({});
  });

  it.each([
    [1.2, 1200],
    [-0.8, -800],
  ])("estima o atraso do indicador por reunião (%s s)", (skew, expectedMs) => {
    const turns = conversation();
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns, skew));
    expect(Math.abs(result.skewMs - expectedMs)).toBeLessThanOrEqual(150);
    expect(result.names.get("Speaker 2")?.name).toBe("João Lima");
    expect(result.valid).toBe(true);
  });

  it("dois clusters da mesma pessoa recebem o mesmo nome", () => {
    const turns = conversation().map((t, i) => (t.label === "Speaker 1" && i % 2 === 0 ? { ...t, label: "Speaker 4" } : t));
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns));
    expect(result.names.get("Speaker 1")?.name).toBe("Maria Souza");
    expect(result.names.get("Speaker 4")?.name).toBe("Maria Souza");
  });

  it("um cluster com duas pessoas (diarização fundiu as vozes) fica sem nome", () => {
    const turns = conversation().map((t) => (t.label === "Speaker 2" ? { ...t, label: "Speaker 1" } : t));
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns));
    expect(result.names.has("Speaker 1")).toBe(false);
    expect(["purity", "margin"]).toContain(result.undecided["Speaker 1"]);
    expect(result.names.get("Speaker 3")?.name).toBe("Ana Costa");
  });

  it("sem maioria clara entre duas pessoas, o rótulo continua Speaker N (nome errado é pior que nenhum)", () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 6; i++) {
      turns.push({ label: "Speaker 1", key: "m", name: "Maria", start: 10 + i * 20, end: 10 + i * 20 + 11 });
      turns.push({ label: "Speaker 1", key: "j", name: "João", start: 10 + i * 20 + 11, end: 10 + i * 20 + 20 });
    }
    const result = matchSpeakers(segmentsOf(turns.map((t) => ({ ...t, label: t.label }))), intervalsOf(turns));
    expect(result.names.size).toBe(0);
  });

  it("pouca evidência (menos de 2 s) não nomeia", () => {
    const segments: MatchSegment[] = [{ label: "Speaker 1", start: 10, end: 11.5 }, ...segmentsOf(conversation(4, 8, WINDOWS.slice(1)))];
    const intervals = [{ key: "m", name: "Maria", start: 10, end: 11.5 }, ...intervalsOf(conversation(4, 8, WINDOWS.slice(1)))];
    const result = matchSpeakers(segments, intervals);
    expect(result.names.has("Speaker 1")).toBe(false);
    expect(result.undecided["Speaker 1"]).toBe("evidence");
  });

  it("fala simultânea divide o tempo entre os ativos (ninguém leva o crédito inteiro)", () => {
    const segments: MatchSegment[] = [{ label: "Speaker 1", start: 0, end: 20 }];
    const result = matchSpeakers(
      [...segments, ...segmentsOf(conversation(2, 8, WINDOWS.slice(1)))],
      [
        { key: "m", name: "Maria", start: 0, end: 20 },
        { key: "j", name: "João", start: 0, end: 20 },
        ...intervalsOf(conversation(2, 8, WINDOWS.slice(1))),
      ],
    );
    // metade para cada: pureza 0,5 < 0,6
    expect(result.names.has("Speaker 1")).toBe(false);
  });

  it("nomes iguais de pessoas diferentes saem 'Nome' e 'Nome (2)'", () => {
    const turns = conversation(6, 8, [
      ["Speaker 1", "k1", "Maria"],
      ["Speaker 2", "k2", "Maria"],
      ["Speaker 3", "a", "Ana"],
    ]);
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns));
    expect(result.names.get("Speaker 1")?.name).toBe("Maria");
    expect(result.names.get("Speaker 2")?.name).toBe("Maria (2)");
  });

  it("o último nome da mesma pessoa vale (Convidado vira o nome real)", () => {
    const turns = conversation();
    const intervals = intervalsOf(turns).map((i, n) => (i.key === "m" && n < 3 ? { ...i, name: "Convidado" } : i));
    expect(matchSpeakers(segmentsOf(turns), intervals).names.get("Speaker 1")?.name).toBe("Maria Souza");
  });

  it("user e Remoto nunca são renomeados", () => {
    const turns = conversation();
    const segments = [...segmentsOf(turns), { label: "user", start: 10, end: 40 }, { label: "Remoto", start: 50, end: 90 }];
    const result = matchSpeakers(segments, intervalsOf(turns));
    expect(result.names.has("user")).toBe(false);
    expect(result.names.has("Remoto")).toBe(false);
  });

  it("rótulos do ASR externo 'Speaker N (parte i)' são nomeados por rótulo", () => {
    const turns = conversation().map((t) => ({ ...t, label: `${t.label} (parte ${t.start < 80 ? 1 : 2})` }));
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns));
    expect(result.names.get("Speaker 1 (parte 1)")?.name).toBe("Maria Souza");
    expect(result.names.get("Speaker 1 (parte 2)")?.name).toBe("Maria Souza");
  });
});

describe("matchSpeakers: leitura ruim", () => {
  it("cobertura baixa: linha do tempo que não bate com a fala é descartada inteira", () => {
    const turns = conversation();
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns, 500));
    expect(result.valid).toBe(false);
    expect(result.names.size).toBe(0);
    expect(result.speechCoverage).toBeLessThan(0.5);
  });

  it("indicador preso (todos falando o tempo todo) não gera nome", () => {
    const turns = conversation();
    const stuck: MatchInterval[] = WINDOWS.map(([, key, name]) => ({ key, name, start: 0, end: 600 }));
    const result = matchSpeakers(segmentsOf(turns), stuck);
    expect(result.names.size).toBe(0);
  });

  it("sem linha do tempo ou sem segmentos: sem nomes e sem erro", () => {
    expect(matchSpeakers(segmentsOf(conversation()), []).valid).toBe(false);
    expect(matchSpeakers([], intervalsOf(conversation())).names.size).toBe(0);
  });

  it("intervalos curtos demais são ignorados", () => {
    const result = matchSpeakers(segmentsOf(conversation()), [{ key: "m", name: "Maria", start: 10, end: 10.2 }]);
    expect(result.valid).toBe(false);
  });

  it("1 hora de reunião casa em menos de 1 s", () => {
    const turns = conversation(60, 8);
    const started = performance.now();
    const result = matchSpeakers(segmentsOf(turns), intervalsOf(turns, 0.6));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.names.size).toBe(3);
  });
});

describe("nameSegments (sem diarização)", () => {
  const turns = conversation(3, 8).map((t) => ({ ...t, label: null }));

  it("cada segmento leva o nome de quem mais falou nele", () => {
    const segments = segmentsOf(turns);
    const result = nameSegments(segments, segments.map((_, i) => i), intervalsOf(turns));
    expect(result.valid).toBe(true);
    expect(result.names.get(0)).toBe("Maria Souza");
    expect(result.names.get(1)).toBe("João Lima");
  });

  it("sem maioria, o segmento fica sem nome; sem dados, tudo como veio", () => {
    const segments: MatchSegment[] = [...segmentsOf(turns), { label: null, start: 1000, end: 1010 }];
    const result = nameSegments(segments, [segments.length - 1], intervalsOf(turns));
    expect(result.names.size).toBe(0);
    expect(nameSegments(segments, [0], []).valid).toBe(false);
  });
});
