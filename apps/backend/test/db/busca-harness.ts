import { readFileSync } from "node:fs";
import path from "node:path";
import { FakeEmbedder } from "../helpers/fakeEmbed";
import { startHarness, type Harness, type UserSpec } from "./tarefas-harness";

// Apoio dos testes de busca com Postgres (imagem com pgvector): app real, embedder falso e worker
// acionado à mão. Nenhum Ollama; o conteúdo vem do golden set sintético ou de textos curtos.

export interface SeedSegment {
  speaker?: string | null;
  text: string;
  start: number;
  end?: number;
}

export interface SearchHarness extends Harness {
  embedder: FakeEmbedder;
  /** insere segmentos `final` e devolve os ids */
  seedSegments(meetingId: string, segments: SeedSegment[]): Promise<number[]>;
  seedAdr(meetingId: string, itemId: string, adr: { title: string; decision: string; status?: string }): Promise<string>;
  setAnalysis(meetingId: string, analysis: object): Promise<void>;
  /** enfileira a reunião e roda o worker até esvaziar a fila (texto e vetores) */
  index(...meetingIds: string[]): Promise<void>;
  /** só a fila (sem rodar o worker) */
  enqueue(meetingId: string): Promise<void>;
  drain(): Promise<number>;
  search(who: string, query: string, extra?: string): Promise<{ status: number; json: any }>;
}

export async function startSearchHarness(specs: UserSpec[]): Promise<SearchHarness> {
  const h = await startHarness(specs);
  const { config } = await import("../../src/config");
  const { setEmbedder } = await import("../../src/search/embedder");
  const { markDirty } = await import("../../src/search/dirty");
  const { tick } = await import("../../src/search/worker");
  const { resetGateCache } = await import("../../src/search/gate");

  config.search.indexDebounceSeconds = 0;
  config.search.semantic = "auto";
  const embedder = new FakeEmbedder();
  setEmbedder(embedder);
  resetGateCache();

  async function drain(): Promise<number> {
    let worked = 0;
    while (await tick()) {
      worked++;
      if (worked > 200) throw new Error("worker não esvaziou a fila");
    }
    return worked;
  }

  const originalStop = h.stop;
  return {
    ...h,
    embedder,
    async seedSegments(meetingId, segments) {
      const ids: number[] = [];
      for (const s of segments) {
        const { rows } = await h.pool.query(
          `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
           VALUES ($1, 'remote', 'final', $2, $3, $4, $5) RETURNING id`,
          [meetingId, s.speaker ?? null, s.text, s.start, s.end ?? s.start + 10],
        );
        ids.push(Number(rows[0].id));
      }
      return ids;
    },
    async seedAdr(meetingId, itemId, adr) {
      const { rows } = await h.pool.query(
        `INSERT INTO adrs (item_id, meeting_id, title, context, problem, decision, consequences, status)
         VALUES ($1, $2, $3, 'contexto', 'problema', $4, 'consequências', $5) RETURNING id`,
        [itemId, meetingId, adr.title, adr.decision, adr.status ?? "proposto"],
      );
      return rows[0].id;
    },
    async setAnalysis(meetingId, analysis) {
      await h.pool.query(`UPDATE meetings SET analysis = $2, analyzed_at = now() WHERE id = $1`, [meetingId, JSON.stringify(analysis)]);
    },
    async enqueue(meetingId) {
      await markDirty(meetingId);
    },
    drain,
    async index(...meetingIds) {
      for (const id of meetingIds) await markDirty(id);
      await drain();
    },
    search(who, query, extra = "") {
      return h.call(who, "GET", `/search?q=${encodeURIComponent(query)}${extra}`);
    },
    async stop() {
      setEmbedder(null);
      await originalStop();
    },
  };
}

// ---------- golden set sintético (test/fixtures/search/golden.json) ----------

export interface Golden {
  meetings: {
    key: string;
    title: string;
    date: string;
    project: string | null;
    segments: { speaker: string; start: number; end: number; text: string }[];
    items: { id: string; type: string; description: string; status: "proposto" | "aprovado" | "rejeitado" }[];
    adr: { id: string; title: string; text: string; status: string } | null;
    analysis: { section: string; text: string }[];
  }[];
  queries: { q: string; meeting: string; contains: string; group: string }[];
  noAnswer: string[];
}

export const golden: Golden = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/search/golden.json"), "utf8"));

export interface LoadedGolden {
  meetings: Record<string, string>;
  items: Record<string, string>;
}

/** Cria as reuniões do golden set para o dono, já concluídas, com segmentos, itens, ADR e narrativa. */
export async function loadGolden(h: SearchHarness, owner: string): Promise<LoadedGolden> {
  const loaded: LoadedGolden = { meetings: {}, items: {} };
  for (const m of golden.meetings) {
    let projectId: string | null = null;
    if (m.project) {
      const { rows } = await h.pool.query(
        `INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [m.project],
      );
      projectId = rows[0].id;
    }
    const meetingId = await h.seedMeeting(owner, { title: m.title, scheduledStart: new Date(m.date), projectId });
    loaded.meetings[m.key] = meetingId;
    await h.seedSegments(meetingId, m.segments);
    for (const item of m.items) {
      loaded.items[item.id] = await h.seedItem(meetingId, { type: item.type, description: item.description, status: item.status });
    }
    if (m.adr) {
      const firstItem = loaded.items[m.items[0].id];
      loaded.items[m.adr.id] = await h.seedAdr(meetingId, firstItem, { title: m.adr.title, decision: m.adr.text, status: m.adr.status });
    }
    const analysis = Object.fromEntries(m.analysis.map((a) => [a.section, a.text]));
    await h.setAnalysis(meetingId, { ...analysis, assuntos: [], observacoes_arquiteto: [] });
  }
  return loaded;
}
