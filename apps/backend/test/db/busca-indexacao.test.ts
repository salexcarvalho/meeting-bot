import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SearchHarness } from "./busca-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

// Indexação (US2): gatilhos, debounce, hash, gate da reunião ao vivo, falhas com espera e recuperação.
describe.skipIf(!enabled)("busca: índice sempre atual, sem atrapalhar a reunião (Postgres)", async () => {
  const { startSearchHarness } = await import("./busca-harness");
  let h: SearchHarness;
  let config: typeof import("../../src/config").config;
  let worker: typeof import("../../src/search/worker");
  let indexer: typeof import("../../src/search/indexer");
  let dirty: typeof import("../../src/search/dirty");
  let items: typeof import("../../src/items/service");
  let transcripts: typeof import("../../src/repo/transcripts");

  const state = async (id: string) => (await h.pool.query(`SELECT * FROM search_index_state WHERE meeting_id = $1`, [id])).rows[0];
  const chunks = async (id: string, kind?: string) =>
    (await h.pool.query(`SELECT * FROM search_chunks WHERE meeting_id = $1 ${kind ? "AND kind = $2" : ""} ORDER BY kind, source_id, seq`, kind ? [id, kind] : [id])).rows;

  async function newMeeting(title: string, text = "conteúdo de teste da reunião"): Promise<string> {
    const id = await h.seedMeeting("bx-ana", { title });
    await h.seedSegments(id, [{ speaker: "Ana", text, start: 0 }]);
    return id;
  }

  beforeAll(async () => {
    h = await startSearchHarness([["bx-ana", "USER", "Ana Lima"]]);
    ({ config } = await import("../../src/config"));
    worker = await import("../../src/search/worker");
    indexer = await import("../../src/search/indexer");
    dirty = await import("../../src/search/dirty");
    items = await import("../../src/items/service");
    transcripts = await import("../../src/repo/transcripts");
  });

  afterEach(() => {
    h.embedder.available = true;
    h.embedder.failAlways = false;
    h.embedder.failOnCall = null;
    h.embedder.model = "bge-m3";
    config.search.embedModel = "bge-m3";
    config.search.embedBatch = 16;
    config.search.indexDebounceSeconds = 0;
  });

  afterAll(async () => {
    await h.stop();
  });

  describe("fila e debounce", () => {
    it("markDirty só enfileira reunião concluída e agrupa edições numa única linha", async () => {
      const id = await newMeeting("Fila simples");
      const running = (await h.pool.query(`INSERT INTO meetings (title, platform, status, source, created_by) VALUES ('em curso', 'none', 'transcribing', 'manual', $1) RETURNING id`, [h.ids["bx-ana"]])).rows[0].id;
      await dirty.markDirty(running);
      expect(await state(running)).toBeUndefined();
      await dirty.markDirty(id);
      await dirty.markDirty(id);
      await dirty.markDirty(id);
      expect((await h.pool.query(`SELECT count(*)::int AS n FROM search_index_state WHERE meeting_id = $1`, [id])).rows[0].n).toBe(1);
      expect((await state(id)).status).toBe("pending");
    });

    it("o worker espera o debounce: alteração recente não é pega, a antiga é", async () => {
      const id = await newMeeting("Debounce");
      config.search.indexDebounceSeconds = 3600;
      await dirty.markDirty(id);
      expect(await worker.tick()).toBe(false);
      expect((await state(id)).status).toBe("pending");
      config.search.indexDebounceSeconds = 0;
      expect(await worker.tick()).toBe(true);
      expect((await state(id)).status).toBe("indexed");
    });

    it("reunião nova passa na frente do backfill; no empate, a mais recente primeiro", async () => {
      await h.drain();
      const old = await h.seedMeeting("bx-ana", { title: "Backfill antigo", scheduledStart: new Date("2026-01-01T10:00:00Z") });
      const recent = await h.seedMeeting("bx-ana", { title: "Backfill recente", scheduledStart: new Date("2026-06-01T10:00:00Z") });
      for (const id of [old, recent]) await h.seedSegments(id, [{ speaker: "Ana", text: "texto do backfill", start: 0 }]);
      await h.pool.query(
        `INSERT INTO search_index_state (meeting_id, status, dirty_at) VALUES ($1, 'pending', '2026-07-01T00:00:00Z'), ($2, 'pending', '2026-07-01T00:00:00Z')
         ON CONFLICT (meeting_id) DO UPDATE SET status = 'pending', dirty_at = EXCLUDED.dirty_at`,
        [old, recent],
      );
      const fresh = await newMeeting("Reunião nova");
      await dirty.markDirty(fresh);
      expect(await worker.tick()).toBe(true);
      expect((await state(fresh)).status).toBe("indexed");
      expect((await state(recent)).status).toBe("pending");
      expect(await worker.tick()).toBe(true);
      expect((await state(recent)).status).toBe("indexed");
      expect((await state(old)).status).toBe("pending");
      await h.drain();
      expect((await state(old)).status).toBe("indexed");
    });
  });

  describe("gatilhos", () => {
    it("substituir a transcrição apaga os trechos de transcrição na mesma transação", async () => {
      const id = await newMeeting("Passe final", "primeira versão da fala");
      await h.index(id);
      expect((await chunks(id, "transcript")).length).toBe(1);
      await transcripts.replaceWithFinal(id, [{ channel: "remote", speaker: "Ana", text: "segunda versão da fala", start: 0, end: 5 }]);
      expect(await chunks(id, "transcript")).toEqual([]);
      expect((await state(id)).status).toBe("pending");
      await h.drain();
      const [chunk] = await chunks(id, "transcript");
      expect(chunk.content).toContain("segunda versão");
      expect(chunk.embedding).not.toBeNull();
    });

    it("se a troca falha (rollback), os trechos antigos continuam e o estado não muda", async () => {
      const id = await newMeeting("Passe final com erro", "fala que deve sobreviver");
      await h.index(id);
      const failing = async () => {
        throw new Error("falha no remapeamento");
      };
      await expect(
        transcripts.replaceWithFinal(id, [{ channel: "remote", speaker: "Ana", text: "nova", start: 0, end: 5 }], failing),
      ).rejects.toThrow("falha no remapeamento");
      expect((await chunks(id, "transcript")).length).toBe(1);
      expect((await state(id)).status).toBe("indexed");
    });

    it("editar, aprovar, rejeitar e reabrir item atualiza ou remove o trecho", async () => {
      const id = await newMeeting("Itens");
      const item = await h.seedItem(id, { type: "pendencia", description: "Descrição inicial do item", status: "proposto" });
      await h.index(id);
      const itemChunk = async () => (await chunks(id, "item"))[0];
      expect((await itemChunk()).content).toContain("Descrição inicial");

      await items.editItem(item, { description: "Descrição revisada do item" }, h.ids["bx-ana"]);
      await settle();
      await h.drain();
      expect((await itemChunk()).content).toContain("revisada");

      await items.reviewItem(item, "reject", h.ids["bx-ana"]);
      await settle();
      await h.drain();
      expect(await itemChunk()).toBeUndefined();

      await items.reviewItem(item, "reopen", h.ids["bx-ana"]);
      await settle();
      await h.drain();
      expect((await itemChunk()).content).toContain("revisada");
    });

    it("item mesclado some do índice e ADR editado atualiza o trecho", async () => {
      const id = await newMeeting("Mescla e ADR");
      const keep = await h.seedItem(id, { type: "decisao", description: "Adotar fila durável", status: "proposto" });
      const dup = await h.seedItem(id, { type: "decisao", description: "Usar fila durável", status: "proposto" });
      const adr = await h.seedAdr(id, keep, { title: "Fila durável", decision: "Decisão original" });
      await h.index(id);
      expect((await chunks(id, "item")).length).toBe(2);

      await items.mergeInto(id, keep, [dup]);
      await items.editAdr(adr, { decision: "Decisão atualizada pelo time" }, h.ids["bx-ana"]);
      await settle();
      await h.drain();
      expect((await chunks(id, "item")).length).toBe(1);
      expect((await chunks(id, "adr"))[0].content).toContain("atualizada pelo time");
      await items.reviewAdr(adr, "reject", h.ids["bx-ana"]);
      await settle();
      await h.drain();
      expect(await chunks(id, "adr")).toEqual([]);
    });

    it("renomear falante e mudar título reindexam e refazem os vetores só do que mudou", async () => {
      const id = await newMeeting("Título original", "fala da pessoa");
      await h.index(id);
      const before = (await chunks(id, "transcript"))[0];
      await h.pool.query(`UPDATE meeting_speakers SET display_name = 'Nome Novo' WHERE meeting_id = $1`, [id]);
      await h.pool.query(`INSERT INTO meeting_speakers (meeting_id, label, display_name) VALUES ($1, 'Ana', 'Nome Novo') ON CONFLICT (meeting_id, label) DO UPDATE SET display_name = 'Nome Novo'`, [id]);
      await dirty.markDirty(id);
      await h.drain();
      const after = (await chunks(id, "transcript"))[0];
      expect(after.content).toContain("Nome Novo");
      expect(after.content_hash).not.toBe(before.content_hash);

      h.embedder.resetCounters();
      await h.pool.query(`UPDATE meetings SET title = 'Título trocado' WHERE id = $1`, [id]);
      await dirty.markDirty(id);
      await h.drain();
      // o título entra no texto do embedding: todos os trechos da reunião são recalculados
      expect(h.embedder.embeddedTexts).toBe((await chunks(id)).length);
    });
  });

  describe("hash e modelo", () => {
    it("conteúdo igual: nenhum embedding novo", async () => {
      const id = await newMeeting("Hash estável");
      await h.index(id);
      h.embedder.resetCounters();
      await dirty.markDirty(id);
      await h.drain();
      expect(h.embedder.embeddedTexts).toBe(0);
      expect((await state(id)).status).toBe("indexed");
    });

    it("modelo diferente: recalcula todos os vetores", async () => {
      const id = await newMeeting("Troca de modelo");
      await h.index(id);
      const total = (await chunks(id)).length;
      h.embedder.resetCounters();
      h.embedder.model = "bge-m3-v2";
      config.search.embedModel = "bge-m3-v2";
      await dirty.markDirty(id);
      await h.drain();
      expect(h.embedder.embeddedTexts).toBe(total);
      expect((await chunks(id)).every((c) => c.embed_model === "bge-m3-v2")).toBe(true);
    });
  });

  describe("gate da reunião ao vivo e Ollama", () => {
    it("com reunião gravando só roda o texto e não chama o embedder; ao terminar, embeda", async () => {
      const live = (await h.pool.query(`INSERT INTO meetings (title, platform, status, source, created_by) VALUES ('ao vivo', 'none', 'recording', 'manual', $1) RETURNING id`, [h.ids["bx-ana"]])).rows[0].id;
      try {
        const id = await newMeeting("Durante a gravação", "busca pelo texto mesmo ao vivo");
        h.embedder.resetCounters();
        await h.index(id);
        expect(h.embedder.embeddedTexts).toBe(0);
        expect(h.embedder.documentCalls).toEqual([]);
        expect((await state(id)).status).toBe("text_ready");
        expect((await chunks(id)).every((c) => c.embedding === null)).toBe(true);
        const found = await h.search("bx-ana", "mesmo ao vivo", "&mode=text");
        expect(found.json.hits.length).toBeGreaterThan(0);
        expect((await h.call("bx-ana", "GET", "/search/status")).json.paused).toBe("reuniao_ao_vivo");

        await h.pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [live]);
        await h.drain();
        expect((await state(id)).status).toBe("indexed");
        expect(h.embedder.embeddedTexts).toBeGreaterThan(0);
        expect((await h.call("bx-ana", "GET", "/search/status")).json.paused).toBeNull();
      } finally {
        await h.pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [live]);
      }
    });

    it("a gravação que começa no meio do trabalho interrompe entre lotes: o lote em curso termina e o resto espera", async () => {
      const id = await newMeeting("Interrompida", "trecho um");
      await h.seedSegments(id, Array.from({ length: 6 }, (_, i) => ({ speaker: "Ana", text: `fala longa número ${i} `.repeat(60), start: 100 + i * 200 })));
      config.search.embedBatch = 2;
      await dirty.markDirty(id);
      await indexer.indexMeetingText(id);
      let checks = 0;
      const progress = await indexer.embedPending(id, { paused: async () => checks++ >= 1 });
      expect(progress.paused).toBe(true);
      expect(progress.embedded).toBe(2);
      expect(progress.remaining).toBeGreaterThan(0);
      expect(h.embedder.documentCalls.at(-1)).toHaveLength(2);
      const resumed = await indexer.embedPending(id, { paused: async () => false });
      expect(resumed.paused).toBe(false);
      expect(resumed.remaining).toBe(0);
    });

    it("Ollama fora: fica text_ready (pesquisável por texto) e conclui quando volta", async () => {
      const id = await newMeeting("Ollama fora", "assunto pesquisável sem vetores");
      h.embedder.available = false;
      await h.index(id);
      expect((await state(id)).status).toBe("text_ready");
      expect((await state(id)).embedded_count).toBe(0);
      const found = await h.search("bx-ana", "pesquisável sem vetores", "&mode=text");
      expect(found.json.hits.length).toBeGreaterThan(0);
      h.embedder.available = true;
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
      expect((await state(id)).embedded_count).toBeGreaterThan(0);
    });

    it("SEARCH_SEMANTIC=off: termina em text_ready sem tocar no Ollama", async () => {
      const id = await newMeeting("Somente texto");
      config.search.semantic = "off";
      try {
        h.embedder.resetCounters();
        await h.index(id);
        expect((await state(id)).status).toBe("text_ready");
        expect(h.embedder.embeddedTexts).toBe(0);
      } finally {
        config.search.semantic = "auto";
      }
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
    });
  });

  describe("falhas e recuperação", () => {
    it("falha parcial preserva o que já foi gravado e a nova tentativa só embeda o restante", async () => {
      const id = await newMeeting("Falha parcial");
      await h.seedSegments(id, Array.from({ length: 5 }, (_, i) => ({ speaker: "Ana", text: `pedaço ${i} do assunto `.repeat(40), start: 100 + i * 200 })));
      config.search.embedBatch = 2;
      h.embedder.failOnCall = 2;
      await h.index(id);
      const afterFailure = await state(id);
      expect(afterFailure.status).toBe("text_ready");
      expect(afterFailure.attempts).toBe(1);
      expect(afterFailure.last_error).toBeTruthy();
      const stored = (await chunks(id)).filter((c) => c.embedding !== null).length;
      expect(stored).toBeGreaterThan(0);
      expect(stored).toBeLessThan((await chunks(id)).length);

      const embeddedBefore = h.embedder.embeddedTexts;
      await h.pool.query(`UPDATE search_index_state SET next_attempt_at = now() WHERE meeting_id = $1`, [id]);
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
      expect(h.embedder.embeddedTexts - embeddedBefore).toBe((await chunks(id)).length - stored);
    });

    it("espera crescente e 'failed' na quinta falha; Reindexar recoloca na fila", async () => {
      const id = await newMeeting("Falha total");
      h.embedder.failAlways = true;
      await h.index(id);
      const waits: number[] = [];
      for (let attempt = 1; attempt < 5; attempt++) {
        const row = await state(id);
        expect(row.attempts).toBe(attempt);
        waits.push(Math.round((new Date(row.next_attempt_at).getTime() - Date.now()) / 1000));
        await h.pool.query(`UPDATE search_index_state SET next_attempt_at = now() WHERE meeting_id = $1`, [id]);
        await h.drain();
      }
      expect(waits[0]).toBeGreaterThan(0);
      expect(waits[0]).toBeLessThanOrEqual(30);
      expect(waits[1]).toBeGreaterThan(30);
      expect(waits[3]).toBeGreaterThan(waits[2]);
      const failed = await state(id);
      expect(failed.status).toBe("failed");
      expect(failed.attempts).toBe(5);
      expect(failed.last_error).not.toMatch(/conteúdo de teste/);
      // reunião com falha continua pesquisável por texto e fora da fila
      expect(await worker.tick()).toBe(false);
      expect((await h.search("bx-ana", "conteúdo de teste", "&mode=text")).json.hits.length).toBeGreaterThan(0);

      h.embedder.failAlways = false;
      const reindex = await h.call("bx-ana", "POST", "/search/reindex", { meetingId: id });
      expect(reindex.status).toBe(202);
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
      expect((await state(id)).attempts).toBe(0);
    });

    it("no boot, 'indexing' volta para 'pending' e o trabalho retoma sem duplicar trechos", async () => {
      const id = await newMeeting("Reinício");
      await h.index(id);
      const total = (await chunks(id)).length;
      await h.pool.query(`UPDATE search_index_state SET status = 'indexing' WHERE meeting_id = $1`, [id]);
      expect(await worker.recoverInterrupted()).toBeGreaterThanOrEqual(1);
      expect((await state(id)).status).toBe("pending");
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
      expect((await chunks(id)).length).toBe(total);
    });

    it("alteração durante a indexação: o fim da fase não sobrescreve o estado 'pending'", async () => {
      const id = await newMeeting("Alterada no meio");
      await dirty.markDirty(id);
      await h.pool.query(`UPDATE search_index_state SET status = 'indexing' WHERE meeting_id = $1`, [id]);
      const text = await indexer.indexMeetingText(id);
      expect(text).not.toBeNull();
      await dirty.markDirty(id);
      expect(await indexer.finishText(id, text!.dirtyAt, text!.chunks)).toBe(false);
      expect((await state(id)).status).toBe("pending");
    });

    it("erro do banco na fase de texto vira falha da reunião, sem derrubar o worker", async () => {
      const id = await newMeeting("Texto com erro");
      await dirty.markDirty(id);
      await h.pool.query(`ALTER TABLE search_chunks ADD CONSTRAINT tmp_bloqueio CHECK (content NOT LIKE '%de teste da reunião%') NOT VALID`);
      try {
        expect(await worker.tick()).toBe(true);
      } finally {
        await h.pool.query(`ALTER TABLE search_chunks DROP CONSTRAINT tmp_bloqueio`);
      }
      const row = await state(id);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/falha na indexação/);
      await h.pool.query(`UPDATE search_index_state SET next_attempt_at = now() WHERE meeting_id = $1`, [id]);
      await h.drain();
      expect((await state(id)).status).toBe("indexed");
    });
  });

  describe("uso de IA da busca (painel da 004)", () => {
    it("embeddings de indexação e de consulta viram linhas 'busca', sem texto", async () => {
      const id = await newMeeting("Uso", "assunto do consumo registrado");
      await h.pool.query(`DELETE FROM ai_usage_logs WHERE purpose = 'busca'`);
      await h.index(id);
      await h.search("bx-ana", "consumo registrado");
      await settle();
      const rows = (await h.pool.query(`SELECT * FROM ai_usage_logs WHERE purpose = 'busca' ORDER BY id`)).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const indexing = rows.find((r) => r.label === "indexação");
      const query = rows.find((r) => r.label === "consulta");
      expect(indexing).toMatchObject({ category: "llm", provider: "ollama", model: "bge-m3", success: true, user_id: h.ids["bx-ana"], meeting_id: id });
      expect(query).toMatchObject({ user_id: h.ids["bx-ana"], meeting_id: null });
      expect(JSON.stringify(rows)).not.toContain("consumo registrado");
    });

    it("falha de embedding é registrada com código de erro", async () => {
      const id = await newMeeting("Uso com falha", "outro assunto qualquer");
      await h.pool.query(`DELETE FROM ai_usage_logs WHERE purpose = 'busca'`);
      h.embedder.failAlways = true;
      await h.index(id);
      await settle();
      const failed = (await h.pool.query(`SELECT success, error_code FROM ai_usage_logs WHERE purpose = 'busca' AND NOT success`)).rows;
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0].error_code).toBeTruthy();
    });
  });
});
