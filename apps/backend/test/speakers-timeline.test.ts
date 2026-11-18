import { describe, expect, it } from "vitest";
import { dropTimeline, getTimeline, SpeakerTimeline, timelineFor } from "../src/recording/speakerTimeline";

const NOW = 1000;

describe("histerese e fusão", () => {
  it("fala menor que 300 ms é descartada", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 10);
    t.addEdge("a", "Ana", false, 10.2);
    expect(t.snapshot(NOW)).toEqual([]);
  });

  it("pausa menor que 500 ms junta os intervalos; maior separa", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 10);
    t.addEdge("a", "Ana", false, 12);
    t.addEdge("a", "Ana", true, 12.3);
    t.addEdge("a", "Ana", false, 14);
    t.addEdge("a", "Ana", true, 15);
    t.addEdge("a", "Ana", false, 16);
    expect(t.snapshot(NOW).map((i) => [i.start, i.end])).toEqual([[10, 14], [15, 16]]);
  });

  it("intervalo aberto vale até 'agora' e fecha no fim da gravação", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 10);
    expect(t.snapshot(13).map((i) => [i.start, i.end])).toEqual([[10, 13]]);
    t.closeAll(20);
    expect(t.snapshot(NOW).map((i) => [i.start, i.end])).toEqual([[10, 20]]);
  });

  it("repetir a mesma borda não duplica", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 1);
    t.addEdge("a", "Ana", true, 2);
    t.addEdge("a", "Ana", false, 5);
    t.addEdge("a", "Ana", false, 6);
    expect(t.snapshot(NOW)).toHaveLength(1);
  });
});

describe("lotes para o banco", () => {
  it("só entrega o que já está definitivo (a pessoa pode voltar a falar em 500 ms)", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 10);
    t.addEdge("a", "Ana", false, 12);
    expect(t.drain(12.2)).toEqual([]);
    t.addEdge("a", "Ana", true, 12.3);
    t.addEdge("a", "Ana", false, 13);
    expect(t.drain(13.2)).toEqual([]);
    const settled = t.drain(14);
    expect(settled).toEqual([{ key: "a", name: "Ana", start: 10, end: 13 }]);
    expect(t.drain(20)).toEqual([]);
  });

  it("drain(all) entrega tudo no fim e o intervalo já gravado não é fundido de novo", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Ana", true, 10);
    t.addEdge("a", "Ana", false, 12);
    expect(t.drain(30)).toHaveLength(1);
    t.addEdge("a", "Ana", true, 30.1);
    t.addEdge("a", "Ana", false, 31);
    expect(t.drain(40, true)).toEqual([{ key: "a", name: "Ana", start: 30.1, end: 31 }]);
  });
});

describe("dominant", () => {
  const timeline = () => {
    const t = new SpeakerTimeline();
    t.addEdge("m", "Maria Souza", true, 120);
    t.addEdge("m", "Maria Souza", false, 134);
    t.addEdge("j", "João Lima", true, 134.5);
    t.addEdge("j", "João Lima", false, 140);
    return t;
  };

  it("pessoa com maioria do trecho leva o nome", () => {
    expect(timeline().dominant(121, 133, { nowSeconds: NOW })).toBe("Maria Souza");
  });

  it("sem pelo menos metade do trecho, sem nome; trecho vazio ou fora, sem nome", () => {
    const t = new SpeakerTimeline();
    t.addEdge("m", "Maria", true, 0);
    t.addEdge("m", "Maria", false, 4);
    t.addEdge("j", "João", true, 4.5);
    t.addEdge("j", "João", false, 9);
    expect(t.dominant(0, 10, { nowSeconds: NOW })).toBeNull();
    expect(timeline().dominant(300, 310, { nowSeconds: NOW })).toBeNull();
    expect(timeline().dominant(5, 5, { nowSeconds: NOW })).toBeNull();
  });

  it("empate exato não nomeia", () => {
    const t = new SpeakerTimeline();
    t.addEdge("m", "Maria", true, 0);
    t.addEdge("m", "Maria", false, 5);
    t.addEdge("j", "João", true, 0);
    t.addEdge("j", "João", false, 5);
    expect(t.dominant(0, 5, { nowSeconds: NOW })).toBeNull();
  });

  it("intervalo ainda aberto conta até 'agora' e o deslocamento desloca a janela", () => {
    const t = new SpeakerTimeline();
    t.addEdge("m", "Maria", true, 10);
    expect(t.dominant(10, 14, { nowSeconds: 14 })).toBe("Maria");
    expect(t.dominant(8, 11, { nowSeconds: 20, skewSeconds: 2 })).toBe("Maria");
  });

  it("nomes iguais de pessoas diferentes saem desambiguados", () => {
    const t = new SpeakerTimeline();
    t.addEdge("a", "Maria", true, 0);
    t.addEdge("a", "Maria", false, 2);
    t.addEdge("b", "Maria", true, 10);
    t.addEdge("b", "Maria", false, 14);
    expect(t.dominant(10, 14, { nowSeconds: NOW })).toBe("Maria (2)");
  });
});

describe("registro por reunião", () => {
  it("cria, consulta e descarta sem vazar", () => {
    const first = timelineFor("m1");
    expect(timelineFor("m1")).toBe(first);
    expect(getTimeline("m1")).toBe(first);
    dropTimeline("m1");
    expect(getTimeline("m1")).toBeUndefined();
  });
});
