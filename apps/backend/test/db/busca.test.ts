import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoadedGolden, SearchHarness } from "./busca-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

type Hit = { id: number; kind: string; meeting: { id: string; title: string; project: { name: string } | null }; snippet: { text: string; match: boolean }[]; matchedBy: string[]; reviewStatus: string | null; target: Record<string, unknown> };

const snippetText = (hit: Hit) => hit.snippet.map((p) => p.text).join("");

// Migração, consulta híbrida e filtros sobre o golden set sintético (nenhum dado real, nenhum Ollama).
describe.skipIf(!enabled)("busca: migração e consulta (Postgres com pgvector)", async () => {
  const { startSearchHarness, loadGolden, golden } = await import("./busca-harness");
  let h: SearchHarness;
  let loaded: LoadedGolden;

  beforeAll(async () => {
    h = await startSearchHarness([
      ["bq-ana", "USER", "Ana Lima"],
      ["bq-bia", "USER", "Bia Souza"],
      ["bq-viewer", "VIEWER", "Leitor"],
    ]);
    loaded = await loadGolden(h, "bq-ana");
    await h.index(...Object.values(loaded.meetings));
  });

  afterAll(async () => {
    await h.stop();
  });

  describe("migração", () => {
    it("é idempotente (rodar de novo não falha nem duplica)", async () => {
      const { migrate } = await import("../../src/schema");
      const before = await h.pool.query(`SELECT count(*)::int AS n FROM search_chunks`);
      await migrate(h.pool);
      await migrate(h.pool);
      const after = await h.pool.query(`SELECT count(*)::int AS n FROM search_chunks`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("cria a coluna vector(1024) e o índice HNSW parcial", async () => {
      const col = await h.pool.query(
        `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'search_chunks'::regclass AND attname = 'embedding'`,
      );
      expect(col.rows[0].atttypmod).toBe(1024);
      const idx = await h.pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_search_chunks_hnsw'`);
      expect(idx.rows[0].indexdef).toMatch(/USING hnsw .*vector_cosine_ops.*WHERE \(embedding IS NOT NULL\)/);
    });

    it("sem a extensão: falha com mensagem clara; com SEMANTIC=off passa só com texto", async () => {
      const { migrateSearch, PgvectorMissingError } = await import("../../src/search/migration");
      const { loadSearchConfig } = await import("../../src/search/config");
      const client = await h.pool.connect();
      try {
        const absent = async () => false;
        await expect(migrateSearch(client, loadSearchConfig({ SEARCH_SEMANTIC: "auto" }), absent)).rejects.toBeInstanceOf(PgvectorMissingError);
        await expect(migrateSearch(client, loadSearchConfig({ SEARCH_SEMANTIC: "on" }), absent)).rejects.toThrow(/docker.*compose build postgres/);
        await expect(migrateSearch(client, loadSearchConfig({ SEARCH_SEMANTIC: "off" }), absent)).resolves.toBeUndefined();
        await expect(migrateSearch(client, loadSearchConfig({ SEARCH_ENABLED: "false" }), absent)).resolves.toBeUndefined();
      } finally {
        client.release();
      }
    });

    it("dimensão diferente da coluna: erro claro, nada é alterado", async () => {
      const { migrateSearch, EmbedDimensionMismatchError } = await import("../../src/search/migration");
      const { loadSearchConfig } = await import("../../src/search/config");
      const client = await h.pool.connect();
      try {
        await expect(migrateSearch(client, loadSearchConfig({ EMBED_DIM: "768" }))).rejects.toBeInstanceOf(EmbedDimensionMismatchError);
      } finally {
        client.release();
      }
    });

    it("pt_unaccent casa flexão e acento", async () => {
      const match = async (doc: string, query: string) =>
        (await h.pool.query(`SELECT to_tsvector('pt_unaccent', $1) @@ websearch_to_tsquery('pt_unaccent', $2) AS ok`, [doc, query])).rows[0].ok;
      expect(await match("renovar os certificados", "certificado")).toBe(true);
      expect(await match("fluxo de autenticação", "autenticacao")).toBe(true);
      expect(await match("fluxo de autenticacao", "autenticação")).toBe(true);
      expect(await match("fluxo de login", "certificado")).toBe(false);
    });

    it("excluir a reunião apaga trechos e estado em cascata", async () => {
      const id = await h.seedMeeting("bq-ana", { title: "Reunião descartável" });
      await h.seedSegments(id, [{ speaker: "Ana", text: "conteúdo temporário", start: 0 }]);
      await h.index(id);
      expect((await h.pool.query(`SELECT count(*)::int AS n FROM search_chunks WHERE meeting_id = $1`, [id])).rows[0].n).toBeGreaterThan(0);
      await h.pool.query(`DELETE FROM meetings WHERE id = $1`, [id]);
      expect((await h.pool.query(`SELECT count(*)::int AS n FROM search_chunks WHERE meeting_id = $1`, [id])).rows[0].n).toBe(0);
      expect((await h.pool.query(`SELECT count(*)::int AS n FROM search_index_state WHERE meeting_id = $1`, [id])).rows[0].n).toBe(0);
    });

    it("o seed enfileira só reuniões concluídas", async () => {
      const { migrate } = await import("../../src/schema");
      const insert = async (status: string) =>
        (
          await h.pool.query(
            `INSERT INTO meetings (title, platform, status, source, created_by) VALUES ('seed ' || $1, 'none', $1, 'manual', $2) RETURNING id`,
            [status, h.ids["bq-ana"]],
          )
        ).rows[0].id as string;
      const [done, error, scheduled] = [await insert("done"), await insert("error"), await insert("scheduled")];
      await migrate(h.pool);
      const rows = await h.pool.query(`SELECT meeting_id FROM search_index_state WHERE meeting_id = ANY($1::uuid[])`, [[done, error, scheduled]]);
      expect(rows.rows.map((r) => r.meeting_id)).toEqual([done]);
    });
  });

  describe("índice do golden set", () => {
    it("todas as reuniões chegam a 'indexed' com vetor em todos os trechos", async () => {
      const state = await h.pool.query(`SELECT status, chunk_count, embedded_count FROM search_index_state WHERE meeting_id = ANY($1::uuid[])`, [Object.values(loaded.meetings)]);
      expect(state.rows).toHaveLength(golden.meetings.length);
      for (const row of state.rows) {
        expect(row.status).toBe("indexed");
        expect(row.chunk_count).toBeGreaterThan(0);
        expect(row.embedded_count).toBe(row.chunk_count);
      }
    });

    it("item rejeitado não vira trecho; itens e ADR têm o próprio trecho", async () => {
      const kinds = await h.pool.query(
        `SELECT kind, count(*)::int AS n FROM search_chunks WHERE meeting_id = $1 GROUP BY kind`,
        [loaded.meetings.auth],
      );
      const by = Object.fromEntries(kinds.rows.map((r) => [r.kind, r.n]));
      expect(by.item).toBe(2);
      expect(by.adr).toBe(1);
      expect(by.meeting).toBe(1);
      expect(by.analysis).toBe(1);
      expect(by.transcript).toBeGreaterThan(0);
    });
  });

  describe("consulta híbrida", () => {
    it("recall@5 do golden set (híbrido) >= 0,85 e 100% nas consultas literais", async () => {
      let found = 0;
      const literal = { total: 0, found: 0 };
      for (const query of golden.queries) {
        const res = await h.search("bq-ana", query.q, "&limit=5");
        expect(res.status).toBe(200);
        const ok = (res.json.hits as Hit[]).some((hit) => hit.meeting.id === loaded.meetings[query.meeting]);
        if (ok) found++;
        if (query.group === "literal") {
          literal.total++;
          if (ok) literal.found++;
        }
      }
      expect(found / golden.queries.length).toBeGreaterThanOrEqual(0.85);
      expect(literal.found).toBe(literal.total);
    });

    it("sem a palavra literal, a semântica encontra pelo sentido e marca 'semantic'", async () => {
      const res = await h.search("bq-ana", "como as pessoas entram no sistema sem decorar outra senha", "&mode=semantic");
      expect(res.json.modeUsed).toBe("semantic");
      const top = res.json.hits[0] as Hit;
      expect(top.meeting.id).toBe(loaded.meetings.auth);
      expect(top.matchedBy).toEqual(["semantic"]);
    });

    it("acento e flexão: 'certificado' acha 'certificados' e destaca o termo", async () => {
      const res = await h.search("bq-ana", "certificado", "&mode=text");
      const hit = (res.json.hits as Hit[]).find((x) => x.kind === "transcript")!;
      expect(hit.meeting.id).toBe(loaded.meetings.auth);
      expect(hit.snippet.some((p) => p.match && /certificados/i.test(p.text))).toBe(true);
      expect(hit.matchedBy).toEqual(["text"]);
    });

    it("frase entre aspas e exclusão com '-'", async () => {
      const phrase = await h.search("bq-ana", '"código de seis dígitos"', "&mode=text");
      expect((phrase.json.hits as Hit[]).map((x) => x.meeting.id)).toEqual([loaded.meetings.auth]);
      const without = await h.search("bq-ana", "tabela -pedidos", "&mode=text&kind=transcript");
      for (const hit of without.json.hits as Hit[]) expect(snippetText(hit)).not.toMatch(/pedidos/i);
    });

    it("AND sem resultado cai para OR", async () => {
      const res = await h.search("bq-ana", "certificados paleontologia", "&mode=text");
      expect(res.json.hits.length).toBeGreaterThan(0);
      expect((res.json.hits as Hit[])[0].meeting.id).toBe(loaded.meetings.auth);
    });

    it("trechos vizinhos da mesma reunião não se repetem", async () => {
      const res = await h.search("bq-ana", "senha", "&kind=transcript");
      const ids = (res.json.hits as Hit[]).map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("filtros", () => {
    it("projeto, período, tipo e reunião", async () => {
      const project = await h.projectId("Plataforma de Dados");
      const byProject = await h.search("bq-ana", "backup", `&projectId=${project}`);
      expect((byProject.json.hits as Hit[]).every((x) => x.meeting.project?.name === "Plataforma de Dados")).toBe(true);
      expect(byProject.json.hits.length).toBeGreaterThan(0);

      const byDate = await h.search("bq-ana", "contrato", "&from=2026-10-25&to=2026-10-27");
      expect((byDate.json.hits as Hit[]).every((x) => x.meeting.id === loaded.meetings.orcamento)).toBe(true);
      expect(byDate.json.hits.length).toBeGreaterThan(0);
      const outside = await h.search("bq-ana", "contrato", "&from=2026-11-01");
      expect(outside.json.hits).toEqual([]);

      const adrOnly = await h.search("bq-ana", "autenticação única", "&kind=adr");
      expect((adrOnly.json.hits as Hit[]).map((x) => x.kind)).toEqual(["adr"]);

      const one = await h.search("bq-ana", "testes", `&meetingId=${loaded.meetings.retro}`);
      expect((one.json.hits as Hit[]).every((x) => x.meeting.id === loaded.meetings.retro)).toBe(true);
    });

    it("item rejeitado fica fora; proposto e aprovado trazem o selo atual", async () => {
      // o vetor sempre devolve vizinhos: o item rejeitado não pode estar entre eles, em nenhum modo
      const rejected = await h.search("bq-ana", "cor do botão de entrada azul escuro", "&kind=item");
      expect((rejected.json.hits as Hit[]).some((x) => snippetText(x).includes("azul escuro"))).toBe(false);
      expect((rejected.json.hits as Hit[]).some((x) => x.target.itemId === loaded.items["auth-rej-1"])).toBe(false);
      const proposed = await h.search("bq-ana", "renova os certificados digitais do provedor", "&kind=item");
      expect(proposed.json.hits[0].reviewStatus).toBe("proposto");
      expect(proposed.json.hits[0].target.itemId).toBe(loaded.items["auth-pen-1"]);
      await h.pool.query(`UPDATE meeting_items SET review_status = 'aprovado' WHERE id = $1`, [loaded.items["auth-pen-1"]]);
      const approved = await h.search("bq-ana", "renova os certificados digitais do provedor", "&kind=item");
      expect(approved.json.hits[0].reviewStatus).toBe("aprovado");
      // rejeitar tira da busca na hora, sem esperar a reindexação
      await h.pool.query(`UPDATE meeting_items SET review_status = 'rejeitado' WHERE id = $1`, [loaded.items["auth-pen-1"]]);
      const gone = await h.search("bq-ana", "renova os certificados digitais do provedor", "&kind=item");
      expect((gone.json.hits as Hit[]).some((x) => x.target.itemId === loaded.items["auth-pen-1"])).toBe(false);
      await h.pool.query(`UPDATE meeting_items SET review_status = 'proposto' WHERE id = $1`, [loaded.items["auth-pen-1"]]);
    });

    it("trecho de item cujo registro foi removido não aparece", async () => {
      const { seedChunks } = await import("../helpers/fakeEmbed");
      await seedChunks(h.pool, loaded.meetings.auth, [
        { kind: "item", sourceId: "00000000-0000-4000-8000-000000000000", content: "fantasma unicórnio órfão" },
      ]);
      const res = await h.search("bq-ana", "unicórnio órfão", "&kind=item");
      expect((res.json.hits as Hit[]).some((x) => snippetText(x).includes("unicórnio"))).toBe(false);
      const textOnly = await h.search("bq-ana", "unicórnio órfão", "&kind=item&mode=text");
      expect(textOnly.json.hits).toEqual([]);
      await h.pool.query(`DELETE FROM search_chunks WHERE content = 'fantasma unicórnio órfão'`);
    });

    it("alvo da transcrição leva o segmento existente e os tempos", async () => {
      const res = await h.search("bq-ana", "renovar os certificados", "&mode=text&kind=transcript");
      const target = res.json.hits[0].target as Record<string, number | string | null>;
      expect(target.kind).toBe("transcript");
      expect(typeof target.segmentId).toBe("number");
      expect(target.start).not.toBeNull();
    });

    it("paginação por limit e offset", async () => {
      const all = await h.search("bq-ana", "reunião", "&mode=text&limit=50");
      const total = all.json.total as number;
      const first = await h.search("bq-ana", "reunião", "&mode=text&limit=2&offset=0");
      const second = await h.search("bq-ana", "reunião", "&mode=text&limit=2&offset=2");
      expect(first.json.total).toBe(total);
      expect(first.json.hits).toHaveLength(Math.min(2, total));
      const ids = [...first.json.hits, ...second.json.hits].map((x: Hit) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("degradação para texto", () => {
    it("Ollama fora: modo texto, motivo informado e a busca continua", async () => {
      h.embedder.available = false;
      const res = await h.search("bq-ana", "certificados");
      h.embedder.available = true;
      expect(res.status).toBe(200);
      expect(res.json.modeUsed).toBe("text");
      expect(res.json.semantic).toEqual({ available: false, reason: "ollama_indisponivel" });
      expect(res.json.hits.length).toBeGreaterThan(0);
    });

    it("semântica pedida mas indisponível: 200 com lista vazia", async () => {
      h.embedder.available = false;
      const res = await h.search("bq-ana", "certificados", "&mode=semantic");
      h.embedder.available = true;
      expect(res.status).toBe(200);
      expect(res.json.hits).toEqual([]);
      expect(res.json.semantic.available).toBe(false);
    });

    it("SEARCH_SEMANTIC=off: 'desligada' e nenhuma chamada de embedding da consulta", async () => {
      const { config } = await import("../../src/config");
      const calls = h.embedder.queryCalls.length;
      config.search.semantic = "off";
      const res = await h.search("bq-ana", "certificados");
      config.search.semantic = "auto";
      expect(res.json.semantic).toEqual({ available: false, reason: "desligada" });
      expect(h.embedder.queryCalls.length).toBe(calls);
    });
  });

  describe("validação da rota", () => {
    it("recusa consulta vazia, só pontuação, longa demais e parâmetros inválidos", async () => {
      expect((await h.call("bq-ana", "GET", "/search")).status).toBe(400);
      expect((await h.search("bq-ana", "")).status).toBe(400);
      expect((await h.search("bq-ana", "?!...")).status).toBe(400);
      expect((await h.search("bq-ana", "a".repeat(501))).status).toBe(400);
      expect((await h.search("bq-ana", "x", "&kind=podcast")).status).toBe(400);
      expect((await h.search("bq-ana", "x", "&from=ontem")).status).toBe(400);
      expect((await h.search("bq-ana", "x", "&limit=51")).status).toBe(400);
      expect((await h.search("bq-ana", "x", "&offset=101")).status).toBe(400);
      expect((await h.search("bq-ana", "x", "&meetingId=nao-uuid")).status).toBe(400);
    });

    it("exige sessão", async () => {
      expect((await h.call(null, "GET", "/search?q=x")).status).toBe(401);
    });

    it("leitor busca (meetings.read) mas não reindexa", async () => {
      expect((await h.search("bq-viewer", "certificados")).status).toBe(200);
      expect((await h.call("bq-viewer", "POST", "/search/reindex", {})).status).toBe(403);
    });
  });
});
