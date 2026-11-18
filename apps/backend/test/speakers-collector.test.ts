import { describe, expect, it, vi } from "vitest";
import { createSpeakerCollector, FLUSH_EVERY_MS, type CollectorDeps } from "../src/bot/speakers/collector";
import type { DrainResult, HostEdge, ProbeHost, ProbeStats } from "../src/bot/speakers/probe";
import { ClockAnchor } from "../src/recording/clockAnchor";
import { SpeakerTimeline, type SpeechInterval } from "../src/recording/speakerTimeline";
import type { SpeakerTimelineMeta } from "../src/repo/speakerActivity";

const STATS: ProbeStats = { tiles: 3, layer: 0, layerName: "semantic", errors: 0, polls: 10, speaking: 1, lastError: "" };

/** Relógio virtual: o áudio começa em t=0 e cada segundo chega 1 s de PCM. */
function harness(overrides: Partial<CollectorDeps> = {}, host?: Partial<ProbeHost>) {
  let t = 0;
  const anchor = new ClockAnchor();
  const timeline = new SpeakerTimeline();
  const persisted: SpeechInterval[][] = [];
  const finished: SpeakerTimelineMeta[] = [];
  const logs: string[] = [];
  let queue: HostEdge[] = [];
  const fakeHost: ProbeHost = {
    install: async () => undefined,
    drain: async (): Promise<DrainResult> => {
      const edges = queue;
      queue = [];
      return { edges, stats: STATS };
    },
    ...host,
  };
  const deps: CollectorDeps = {
    host: fakeHost,
    anchor,
    timeline,
    assistantName: "Ata do Sérgio",
    now: () => t,
    soundSinceLast: () => true,
    participants: async () => 4,
    persist: async (intervals) => {
      persisted.push(intervals);
    },
    finish: async (meta) => {
      finished.push(meta);
    },
    log: (m) => logs.push(m),
    sourceLabel: "teams:guest",
    ...overrides,
  };
  const collector = createSpeakerCollector(deps);
  return {
    collector,
    timeline,
    persisted,
    finished,
    logs,
    push: (raw: string, speaking: boolean, atSeconds: number, id = "") => queue.push({ id, raw, speaking, atNodeMs: atSeconds * 1000 }),
    /** avança o relógio, entrega o PCM correspondente e roda um ciclo */
    async advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        t += 1000;
        anchor.observe(32_000, t);
        await collector.tick();
      }
    },
  };
}

describe("coletor da linha do tempo", () => {
  it("converte as bordas para o relógio do áudio, ignora o assistente e grava em lote", async () => {
    const h = harness();
    await h.advance(1);
    h.push("Maria Souza, Microphone on", true, 2);
    h.push("Maria Souza, Microphone on", false, 6);
    h.push("Ata do Sérgio", true, 3);
    h.push("Maria (Você)", true, 3);
    await h.advance(FLUSH_EVERY_MS / 1000 + 2);
    expect(h.persisted.flat()).toEqual([expect.objectContaining({ name: "Maria Souza", start: 2, end: 6 })]);
    const meta = await h.collector.stop();
    expect(meta).toMatchObject({ status: "ok", people: 1, intervals: 1, source: "teams:guest/semantic" });
    expect(h.finished).toHaveLength(1);
  });

  it("parada com intervalo aberto fecha no fim e grava o último lote", async () => {
    const h = harness();
    await h.advance(1);
    h.push("João Lima", true, 3, "id-1");
    await h.advance(4);
    const meta = await h.collector.stop();
    const saved = h.persisted.flat();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "João Lima", start: 3 });
    expect(saved[0].end).toBeGreaterThan(4);
    expect(meta.intervals).toBe(1);
  });

  it("falha ao gravar não derruba: tenta de novo no lote seguinte, sem perder intervalos", async () => {
    let failures = 1;
    const saved: SpeechInterval[] = [];
    const h = harness({
      persist: async (intervals) => {
        if (failures-- > 0) throw new Error("banco fora");
        saved.push(...intervals);
      },
    });
    await h.advance(1);
    h.push("Ana", true, 2);
    h.push("Ana", false, 5);
    await h.advance(FLUSH_EVERY_MS / 1000 + 2);
    expect(saved).toEqual([]);
    expect(h.logs.filter((l) => l.includes("não consegui gravar"))).toHaveLength(1);
    await h.advance(FLUSH_EVERY_MS / 1000);
    expect(saved).toHaveLength(1);
  });

  it("sem nenhum dado, o resumo diz indisponível (sem quadros) em vez de ok", async () => {
    const h = harness({}, { drain: async () => ({ edges: [], stats: { ...STATS, tiles: 0 } }) });
    await h.advance(3);
    expect(await h.collector.stop()).toMatchObject({ status: "unavailable", reason: "no_tiles", people: 0, intervals: 0 });
  });

  it("quadros lidos mas ninguém detectado falando: parcial (sem indicador)", async () => {
    const h = harness();
    await h.advance(3);
    expect(await h.collector.stop()).toMatchObject({ status: "partial", reason: "no_indicator" });
  });

  it("sem relógio do áudio (nenhum PCM), as bordas são descartadas e o motivo é no_clock", async () => {
    const h = harness();
    h.push("Ana", true, 2);
    const meta = await h.collector.stop();
    expect(meta).toMatchObject({ status: "unavailable", reason: "no_clock" });
  });

  it("leitura que lança ou trava em um ciclo não derruba o seguinte e loga uma vez", async () => {
    let calls = 0;
    const h = harness({}, {
      drain: async () => {
        calls++;
        if (calls <= 3) throw new Error("página navegando");
        return { edges: [], stats: STATS };
      },
    });
    await h.advance(6);
    expect(calls).toBe(6);
    expect(h.logs.filter((l) => l.includes("erro no ciclo"))).toHaveLength(1);
    expect(await h.collector.stop()).toBeDefined();
  });

  it("indicador preso suspende o registro e a reunião fica parcial", async () => {
    const stuck: ProbeStats = { ...STATS, tiles: 4, speaking: 4 };
    const h = harness({}, { drain: async () => ({ edges: [], stats: stuck }) });
    await h.advance(60);
    h.push("Ana", true, 61);
    await h.advance(2);
    expect(h.timeline.peopleCount).toBe(0);
    expect(await h.collector.stop()).toMatchObject({ status: "partial", reason: "stuck" });
    expect(h.logs.filter((l) => l.includes("partial (stuck)"))).toHaveLength(1);
  });

  it("falha ao gravar o resumo final também só vai para o log", async () => {
    const finish = vi.fn().mockRejectedValue(new Error("banco fora"));
    const h = harness({ finish });
    await h.advance(2);
    await expect(h.collector.stop()).resolves.toBeDefined();
    expect(h.logs.some((l) => l.includes("resumo não gravado"))).toBe(true);
  });
});
