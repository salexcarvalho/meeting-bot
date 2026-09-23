import { describe, expect, it } from "vitest";
import {
  AdrSugerido,
  Consolidacao,
  Extracao,
  ResumoTrecho,
  Narrativa,
  type Adr,
  type Item,
} from "@meeting-bot/contracts";
import { planAiItems } from "../src/agent/dedup";
import type { ValidItem } from "../src/agent/evidence";
import { batchByType, runAdrGeneration, runPostAnalysis, type PostAnalysisDeps } from "../src/agent/postAnalysis";
import type { WindowSegment } from "../src/agent/prompts";
import type { GenerateRequest } from "../src/llm/provider";

const segments: WindowSegment[] = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i,
  channel: "remote",
  start: i * 30,
  end: i * 30 + 25,
  speakerName: "Speaker 1",
  text:
    i === 1
      ? "Decidimos usar filas para a integração com o SUS " + "e mais detalhes ".repeat(120)
      : i === 7
        ? "Vamos usar PostgreSQL como banco principal do portal " + "e explicações ".repeat(120)
        : "conversa geral sobre o andamento do projeto " + "blá ".repeat(250),
}));

function fakeStore(initial: Item[]) {
  const items = [...initial];
  const adrs: Adr[] = [];
  let n = 0;
  const createAiItems = async (_m: string, valid: ValidItem[]) => {
    let created = 0;
    let merged = 0;
    const ids = new Map<string, string>();
    for (const step of planAiItems(items, valid)) {
      if (step.kind === "skip") continue;
      if (step.kind === "merge") {
        const target = items.find((i) => i.id === (ids.get(step.targetId) ?? step.targetId))!;
        target.evidence.push(...step.item.evidence);
        merged++;
        continue;
      }
      const id = `f${++n}`;
      ids.set(step.ref, id);
      items.push({
        id,
        meetingId: "m",
        type: step.item.type,
        description: step.item.description,
        owner: step.item.owner,
        due: step.item.due,
        attributes: step.item.attributes,
        reviewStatus: "proposto",
        origin: "final",
        evidence: step.item.evidence,
        createdAt: "",
        updatedAt: "",
        reviewedBy: null,
        reviewedAt: null,
        generatedBy: null,
      });
      created++;
    }
    return { created, merged };
  };
  return { items, adrs, createAiItems };
}

const liveItem = (over: Partial<Item>): Item => ({
  id: "live1",
  meetingId: "m",
  type: "decisao_arquitetural",
  description: "Usar filas para a integração com o SUS",
  owner: null,
  due: null,
  attributes: {},
  reviewStatus: "aprovado",
  origin: "live",
  evidence: [{ segmentId: null, start: 31, end: 50, channel: "remote", quote: null }],
  createdAt: "",
  updatedAt: "",
  reviewedBy: "sergio",
  reviewedAt: "",
  generatedBy: null,
  ...over,
});

function setup(initial: Item[], opts: { regenerating?: boolean; extractItems?: boolean } = {}) {
  const store = fakeStore(initial);
  const calls: { label: string; user: string; meetingId?: string }[] = [];
  const deps: PostAnalysisDeps = {
    loadContext: async () => ({
      title: "Reunião",
      project: null,
      participants: ["Sérgio"],
      liveSummary: null,
      analysisSummary: null,
      regenerating: Boolean(opts.regenerating),
      extractItems: opts.extractItems ?? true,
      segments,
    }),
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      calls.push({ label: req.label, user: req.user, meetingId: req.meetingId });
      if (req.schema === (Extracao as unknown)) {
        const refs = [...req.user.matchAll(/\[(S\d+) \d\d:\d\d\] Speaker 1: (\S+ \S+ \S+)/g)];
        const itens = [];
        for (const [, ref, start] of refs) {
          if (start.startsWith("Decidimos usar filas")) {
            itens.push({
              tipo: "decisao_arquitetural", descricao: "Usar filas na integração com o SUS", segmentos: [ref],
              citacao: "usar filas para a integração com o SUS", responsavel: null, prazo: null, dependencia: null,
              motivacao: null, impacto: null, sistema: null, categoria: null,
            });
          }
          if (start.startsWith("Vamos usar PostgreSQL")) {
            itens.push({
              tipo: "decisao_arquitetural", descricao: "Adotar PostgreSQL como banco principal do portal", segmentos: [ref],
              citacao: "usar PostgreSQL como banco principal", responsavel: null, prazo: null, dependencia: null,
              motivacao: null, impacto: null, sistema: null, categoria: null,
            });
          }
        }
        return Extracao.parse({ resumo_trecho: `trecho ${calls.length}`, itens }) as T;
      }
      if (req.schema === (ResumoTrecho as unknown)) return ResumoTrecho.parse({ resumo_trecho: `resumo ${calls.length}` }) as T;
      if (req.schema === (Consolidacao as unknown)) return Consolidacao.parse({ resumo: "resumo final", duplicados: [] }) as T;
      if (req.schema === (Narrativa as unknown)) {
        return Narrativa.parse({ objetivo: "o", resumo_executivo: "r", assuntos: [{ titulo: "t", resumo: "r" }], observacoes_arquiteto: [] }) as T;
      }
      return AdrSugerido.parse({
        titulo: `ADR para ${req.user.split("\n")[0]}`, contexto: "", problema: "", alternativas: [], decisao: "",
        consequencias: "", riscos: [],
      }) as T;
    },
    listItems: async () => store.items,
    listAdrs: async () => store.adrs,
    createAiItems: store.createAiItems,
    mergeInto: async () => [],
    async clearUnreviewed() {
      calls.push({ label: "limpeza", user: "" });
      const before = store.items.length;
      store.items.splice(0, store.items.length, ...store.items.filter((i) => i.reviewStatus !== "proposto" || i.origin === "manual"));
      return before - store.items.length;
    },
    resetChunkNotes: async () => {},
    saveChunkNote: async () => {},
    saveSummary: async () => {},
    saveAnalysis: async () => {},
    upsertAdr: async (_m, itemId, adr) => {
      store.adrs.push({
        id: `adr-${itemId}`, itemId, meetingId: "m", number: null, code: null, title: adr.titulo, context: "",
        problem: "", alternatives: [], decision: "", consequences: "", risks: [], status: "proposto", approvedAt: null,
        generatedBy: null,
      });
      return true;
    },
  };
  return { store, calls, deps };
}

describe("runPostAnalysis", () => {
  it("divide em chunks com sobreposição (repetidos como contexto)", async () => {
    const { calls, deps } = setup([]);
    await runPostAnalysis("m", () => {}, deps);
    const extractions = calls.filter((c) => c.label.startsWith("extração final"));
    expect(extractions.length).toBeGreaterThan(2);
    expect(extractions[1].user).toMatch(/\[S1 \d\d:\d\d contexto\]/);
    expect(extractions[1].user).toMatch(/\[S2 \d\d:\d\d contexto\]/);
    expect(extractions[0].user).not.toContain("contexto]");
  });

  it("item final duplicado de item ao vivo é absorvido (o ao vivo prevalece)", async () => {
    const { store, deps } = setup([liveItem({})]);
    await runPostAnalysis("m", () => {}, deps);
    const filas = store.items.filter((i) => /filas/i.test(i.description));
    expect(filas).toHaveLength(1);
    expect(filas[0].id).toBe("live1");
    expect(filas[0].reviewStatus).toBe("aprovado");
    expect(filas[0].evidence.length).toBeGreaterThan(1);
    expect(store.items.some((i) => /PostgreSQL/.test(i.description))).toBe(true);
  });

  it("item ao vivo rejeitado absorve o final em silêncio e não gera ADR", async () => {
    const { store, deps } = setup([liveItem({ reviewStatus: "rejeitado" })]);
    await runPostAnalysis("m", () => {}, deps);
    expect(store.items.filter((i) => /filas/i.test(i.description))).toHaveLength(1);
    expect(store.items[0].evidence).toHaveLength(1);
    expect(store.adrs.map((a) => a.itemId)).not.toContain("live1");
  });

  it("gera ADR só para decisões arquiteturais não rejeitadas", async () => {
    const { store, calls, deps } = setup([
      liveItem({}),
      liveItem({ id: "dec", type: "decisao", description: "Reunião semanal às terças" }),
    ]);
    await runPostAnalysis("m", () => {}, deps);
    const withAdr = store.adrs.map((a) => a.itemId).sort();
    const archIds = store.items.filter((i) => i.type === "decisao_arquitetural").map((i) => i.id).sort();
    expect(withAdr).toEqual(archIds);
    expect(withAdr).not.toContain("dec");
    expect(calls.filter((c) => c.label.startsWith("ADR"))).toHaveLength(archIds.length);
  });

  it("trechos maiores (modelo externo) fazem menos chamadas e toda chamada identifica a reunião", async () => {
    const small = setup([]);
    await runPostAnalysis("m", () => {}, small.deps);
    const big = setup([]);
    await runPostAnalysis("m", () => {}, { ...big.deps, chunkTokens: 12_000 });
    const count = (calls: { label: string }[]) => calls.filter((c) => c.label.startsWith("extração final")).length;
    expect(count(big.calls)).toBe(1);
    expect(count(small.calls)).toBeGreaterThan(count(big.calls));
    expect(big.calls.every((c) => c.meetingId === "m")).toBe(true);
  });

  it("gerar de novo apaga os propostos da IA antes de extrair; na primeira vez não", async () => {
    const old = { id: "velho", description: "Sugestão antiga do modelo anterior", reviewStatus: "proposto" as const };
    const first = setup([liveItem(old)]);
    await runPostAnalysis("m", () => {}, first.deps);
    expect(first.calls.some((c) => c.label === "limpeza")).toBe(false);
    expect(first.store.items.some((i) => i.id === "velho")).toBe(true);

    const again = setup([liveItem(old), liveItem({ id: "ok" })], { regenerating: true });
    await runPostAnalysis("m", () => {}, again.deps);
    expect(again.calls[0].label).toBe("limpeza");
    expect(again.store.items.some((i) => i.id === "velho")).toBe(false);
    expect(again.store.items.find((i) => i.id === "ok")?.reviewStatus).toBe("aprovado");
  });

  it("consolida em lotes por tipo, junta repetido ao revisado e nunca remove revisado", async () => {
    const { deps } = setup([
      liveItem({ id: "a1", type: "decisao", description: "Reunião semanal às terças" }),
      liveItem({ id: "r1", type: "risco", description: "Prazo apertado", reviewStatus: "rejeitado" }),
      ...[0, 1, 2].map((n) => liveItem({ id: `d${n}`, type: "decisao", description: `Decisão proposta ${n}`, reviewStatus: "proposto" })),
      liveItem({ id: "k1", type: "risco", description: "Risco proposto", reviewStatus: "proposto" }),
    ]);
    const merges: [string, string[]][] = [];
    const consolidations: { label: string; user: string }[] = [];
    await runPostAnalysis("m", () => {}, {
      ...deps,
      consolidationItems: 3,
      mergeInto: async (_m, keep, remove) => (merges.push([keep, remove]), remove),
      async generate<T>(req: GenerateRequest<T>): Promise<T> {
        if (req.schema !== (Consolidacao as unknown)) return deps.generate(req);
        consolidations.push({ label: req.label, user: req.user });
        const duplicados = req.user.includes("Decisão proposta 0")
          ? [{ manter: "R1", remover: ["I1", "R1"] }]
          : [{ manter: "I1", remover: ["R1"] }];
        return Consolidacao.parse({ resumo: "resumo", duplicados }) as T;
      },
    });
    expect(consolidations.map((c) => c.label)).toEqual(["consolidação final m 1/2", "consolidação final m 2/2"]);
    expect(consolidations[0].user).toContain("R1 [decisao] Reunião semanal às terças");
    expect(consolidations[0].user).not.toContain("Resumos dos trechos novos:\n(nenhum)");
    expect(consolidations[1].user).toContain("Resumos dos trechos novos:\n(nenhum)");
    expect(consolidations[1].user).toContain("R1 [risco] Prazo apertado");
    expect(merges).toEqual([["a1", ["d0"]]]);
  });
});

describe("batchByType", () => {
  const item = (id: string, type: Item["type"]) => liveItem({ id, type });
  it("não separa um tipo e divide o que passa do limite", () => {
    const items = [item("a", "decisao"), item("b", "risco"), item("c", "decisao"), item("d", "pendencia")];
    expect(batchByType(items, 3).map((b) => b.map((i) => i.id))).toEqual([["a", "c", "b"], ["d"]]);
    const many = [1, 2, 3, 4, 5].map((n) => item(`x${n}`, "risco"));
    expect(batchByType(many, 2).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batchByType([], 5)).toEqual([]);
  });
});

describe("runPostAnalysis com itens desligados", () => {
  it("gera só resumo e ata: sem itens, sem consolidação, sem ADR e sem apagar nada", async () => {
    const reviewedByHand = liveItem({ id: "manual1", origin: "manual", reviewStatus: "proposto" });
    const { store, calls, deps } = setup([reviewedByHand], { extractItems: false, regenerating: true });
    const saved: Narrativa[] = [];
    await runPostAnalysis("m", () => {}, {
      ...deps,
      saveAnalysis: async (_m, analysis) => {
        saved.push(analysis);
      },
    });

    const labels = calls.map((c) => c.label);
    expect(labels.some((l) => l.startsWith("resumo "))).toBe(true);
    expect(labels.some((l) => l.startsWith("narrativa"))).toBe(true);
    for (const forbidden of ["extração final", "consolidação", "limpeza", "adr"]) {
      expect(labels.filter((l) => l.toLowerCase().startsWith(forbidden))).toEqual([]);
    }
    // nada foi criado nem removido, mesmo com "regenerating"
    expect(store.items.map((i) => i.id)).toEqual(["manual1"]);
    expect(store.adrs).toEqual([]);
    // a narrativa não leva itens e as observações do arquiteto (que dependem deles) ficam de fora
    const narrative = calls.find((c) => c.label.startsWith("narrativa"))!;
    expect(narrative.user).toContain("Itens:\n(nenhum)");
    expect(saved).toHaveLength(1);
    expect(saved[0].observacoes_arquiteto).toEqual([]);
  });

  it("os resumos por trecho alimentam a narrativa", async () => {
    const { calls, deps } = setup([], { extractItems: false });
    await runPostAnalysis("m", () => {}, deps);
    const summaries = calls.filter((c) => c.label.startsWith("resumo "));
    expect(summaries.length).toBeGreaterThan(2);
    const narrative = calls.find((c) => c.label.startsWith("narrativa"))!;
    expect(narrative.user).toMatch(/Resumos em ordem:\n1\. resumo /);
  });
});

describe("runAdrGeneration (sob demanda)", () => {
  it("gera só a decisão pedida e usa o resumo da última análise", async () => {
    const { store, calls, deps } = setup([
      liveItem({}),
      liveItem({ id: "outra", description: "Adotar PostgreSQL como banco principal" }),
    ]);
    const result = await runAdrGeneration("m", () => {}, {
      ...deps,
      loadContext: async () => ({
        title: "Reunião",
        project: null,
        participants: [],
        liveSummary: "resumo ao vivo",
        analysisSummary: "resumo executivo salvo",
        regenerating: false,
        extractItems: true,
        segments,
      }),
    }, { itemId: "outra" });
    expect(result).toEqual({ generated: 1, skipped: 0, failed: 0 });
    expect(store.adrs.map((a) => a.itemId)).toEqual(["outra"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("Resumo da reunião: resumo executivo salvo");
  });

  it("mantém ADRs revisados ou travados e conta o que ficou de fora", async () => {
    const { store, deps } = setup([liveItem({}), liveItem({ id: "b" }), liveItem({ id: "c" })]);
    store.adrs.push({
      id: "adr-live1", itemId: "live1", meetingId: "m", number: 1, code: "ADR-001", title: "já aprovado",
      context: "", problem: "", alternatives: [], decision: "", consequences: "", risks: [], status: "aprovado",
      approvedAt: "", generatedBy: null,
    });
    const result = await runAdrGeneration("m", () => {}, {
      ...deps,
      upsertAdr: async (_m, itemId) => itemId !== "c",
    });
    expect(result).toEqual({ generated: 1, skipped: 2, failed: 0 });
  });

  it("resposta inválida conta como falha sem derrubar as demais", async () => {
    const { deps } = setup([liveItem({}), liveItem({ id: "b" })]);
    let n = 0;
    const result = await runAdrGeneration("m", () => {}, {
      ...deps,
      async generate<T>(req: GenerateRequest<T>): Promise<T> {
        if (++n === 1) throw new Error(`Resposta do LLM inválida (${req.label}): JSON inválido`);
        return deps.generate(req);
      },
    });
    expect(result).toEqual({ generated: 1, skipped: 0, failed: 1 });
  });
});
