import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoadedGolden, SearchHarness } from "./busca-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

type Hit = { kind: string; meeting: { id: string; title: string }; snippet: { text: string }[]; target: Record<string, unknown> };

const SECRET = "ultrassecreto zebrafish";
const ids = (res: { json: { hits: Hit[] } }) => res.json.hits.map((h) => h.meeting.id);

// Isolamento (US4, SC-007): a busca é uma superfície nova de leitura; nada de uma reunião alheia pode
// aparecer em resultado, título, projeto, contagem ou estado do índice. Vale em todos os modos.
describe.skipIf(!enabled)("busca: só enxergo o que posso ler (Postgres + HTTP)", async () => {
  const { startSearchHarness, loadGolden } = await import("./busca-harness");
  const { seedChunks } = await import("../helpers/fakeEmbed");
  let h: SearchHarness;
  let golden: LoadedGolden;
  let secret: string;
  let bMeeting: string;

  async function setRolePermission(role: string, permission: string, granted: boolean): Promise<void> {
    if (granted) {
      await h.pool.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT id, $2 FROM roles WHERE key = $1 ON CONFLICT DO NOTHING`, [role, permission]);
    } else {
      await h.pool.query(`DELETE FROM role_permissions WHERE permission_key = $2 AND role_id = (SELECT id FROM roles WHERE key = $1)`, [role, permission]);
    }
  }

  beforeAll(async () => {
    h = await startSearchHarness([
      ["bi-ana", "USER", "Ana Lima"],
      ["bi-bia", "USER", "Bia Souza"],
      ["bi-admin", "ADMIN", "Admin Geral"],
      ["bi-super", "SUPER_ADMIN", "Super Admin"],
      ["bi-viewer", "VIEWER", "Leitor"],
    ]);
    golden = await loadGolden(h, "bi-ana");
    secret = await h.seedMeeting("bi-ana", { title: "Reunião confidencial da Ana" });
    await h.seedSegments(secret, [{ speaker: "Ana", text: `O código ${SECRET} não pode vazar para ninguém.`, start: 0 }]);
    bMeeting = await h.seedMeeting("bi-bia", { title: "Reunião da Bia" });
    await h.seedSegments(bMeeting, [{ speaker: "Bia", text: "A Bia fala sobre o planejamento trimestral e os orçamentos.", start: 0 }]);
    await h.index(secret, bMeeting, ...Object.values(golden.meetings));
  });

  afterAll(async () => {
    await h.stop();
  });

  it("o dono acha o próprio conteúdo", async () => {
    const res = await h.search("bi-ana", SECRET, "&mode=text");
    expect(ids(res)).toContain(secret);
  });

  it("B sem compartilhamento: nenhum trecho, título ou id de A, em nenhum modo", async () => {
    for (const mode of ["hybrid", "text", "semantic"]) {
      const res = await h.search("bi-bia", SECRET, `&mode=${mode}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.json)).not.toContain(secret);
      expect(JSON.stringify(res.json)).not.toContain("confidencial da Ana");
      for (const hit of res.json.hits as Hit[]) expect([bMeeting]).toContain(hit.meeting.id);
    }
    // a semântica também filtra na consulta: a pergunta com o mesmo teor das reuniões de A não traz nada delas
    const semantic = await h.search("bi-bia", "como as pessoas entram no sistema sem decorar outra senha", "&mode=semantic");
    expect(ids(semantic).filter((id) => Object.values(golden.meetings).includes(id))).toEqual([]);
  });

  it("filtro meetingId apontando para reunião alheia não é bypass", async () => {
    const res = await h.search("bi-bia", SECRET, `&meetingId=${secret}`);
    expect(res.status).toBe(200);
    expect(res.json.hits).toEqual([]);
    expect(res.json.total).toBe(0);
  });

  it("ADMIN e SUPER_ADMIN sem relação com o dono também não veem (sem meetings.read_all)", async () => {
    for (const who of ["bi-admin", "bi-super"]) {
      for (const mode of ["text", "semantic"]) {
        const res = await h.search(who, SECRET, `&mode=${mode}`);
        expect(res.status).toBe(200);
        expect(ids(res)).not.toContain(secret);
        expect(JSON.stringify(res.json)).not.toContain("confidencial da Ana");
      }
    }
  });

  it("compartilhar dá acesso; revogar tira do resultado na hora, sem reindexar", async () => {
    await h.share(secret, "bi-bia", "read");
    const granted = await h.search("bi-bia", SECRET, "&mode=text");
    expect(ids(granted)).toContain(secret);
    const grantedSemantic = await h.search("bi-bia", `O código ${SECRET} não pode vazar`, "&mode=semantic");
    expect(ids(grantedSemantic)).toContain(secret);

    const revoked = await h.call("bi-ana", "DELETE", `/meetings/${secret}/shares/${h.ids["bi-bia"]}`);
    expect([200, 204]).toContain(revoked.status);
    for (const mode of ["hybrid", "text", "semantic"]) {
      const after = await h.search("bi-bia", SECRET, `&mode=${mode}`);
      expect(ids(after)).not.toContain(secret);
      expect(JSON.stringify(after.json)).not.toContain("confidencial da Ana");
    }
  });

  it("leitor com compartilhamento lê, mas não reindexa", async () => {
    await h.share(secret, "bi-viewer", "read");
    expect(ids(await h.search("bi-viewer", SECRET, "&mode=text"))).toContain(secret);
    expect((await h.call("bi-viewer", "POST", "/search/reindex", {})).status).toBe(403);
    await h.pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1 AND user_id = $2`, [secret, h.ids["bi-viewer"]]);
    expect(ids(await h.search("bi-viewer", SECRET, "&mode=text"))).not.toContain(secret);
  });

  it("papel sem transcripts.read não recebe transcrição; sem documents.read não recebe o restante", async () => {
    await h.share(golden.meetings.auth, "bi-viewer", "read");
    try {
      await setRolePermission("VIEWER", "transcripts.read", false);
      const noTranscript = await h.search("bi-viewer", "certificados", "&mode=text");
      expect(noTranscript.json.hits.length).toBeGreaterThan(0);
      expect((noTranscript.json.hits as Hit[]).some((x) => x.kind === "transcript")).toBe(false);
      const forced = await h.search("bi-viewer", "certificados", "&mode=text&kind=transcript");
      expect(forced.json.hits).toEqual([]);
      await setRolePermission("VIEWER", "transcripts.read", true);

      await setRolePermission("VIEWER", "documents.read", false);
      const noDocs = await h.search("bi-viewer", "certificados", "&mode=text");
      expect((noDocs.json.hits as Hit[]).every((x) => x.kind === "transcript")).toBe(true);
      const docsForced = await h.search("bi-viewer", "certificados", "&mode=text&kind=item,adr,analysis,meeting");
      expect(docsForced.json.hits).toEqual([]);
    } finally {
      await setRolePermission("VIEWER", "transcripts.read", true);
      await setRolePermission("VIEWER", "documents.read", true);
      await h.pool.query(`DELETE FROM meeting_shares WHERE user_id = $1`, [h.ids["bi-viewer"]]);
    }
  });

  it("reunião excluída some do resultado", async () => {
    const gone = await h.seedMeeting("bi-ana", { title: "Reunião a excluir" });
    await h.seedSegments(gone, [{ speaker: "Ana", text: "palavraexclusiva unicornio", start: 0 }]);
    await h.index(gone);
    expect(ids(await h.search("bi-ana", "palavraexclusiva", "&mode=text"))).toContain(gone);
    await h.pool.query(`DELETE FROM meetings WHERE id = $1`, [gone]);
    expect(ids(await h.search("bi-ana", "palavraexclusiva", "&mode=text"))).not.toContain(gone);
  });

  it("trecho semeado direto para a reunião de A continua invisível para B (vetor idêntico)", async () => {
    await seedChunks(h.pool, secret, [{ content: "texto sintético idêntico alvo", kind: "analysis", sourceId: "resumo_executivo" }]);
    const res = await h.search("bi-bia", "texto sintético idêntico alvo", "&mode=semantic");
    expect(JSON.stringify(res.json.hits)).not.toContain("sintético idêntico");
    const own = await h.search("bi-ana", "texto sintético idêntico alvo", "&mode=semantic");
    expect(own.json.hits[0]).toMatchObject({ kind: "analysis", meeting: { id: secret } });
  });

  describe("estado do índice e reindexação", () => {
    it("GET /search/status conta e lista só as reuniões visíveis", async () => {
      const mine = await h.call("bi-bia", "GET", "/search/status");
      expect(mine.status).toBe(200);
      expect(mine.json.totals.meetings).toBe(1);
      expect(mine.json.totals.chunks).toBeGreaterThan(0);
      const admin = await h.call("bi-admin", "GET", "/search/status");
      expect(admin.json.totals).toMatchObject({ meetings: 0, chunks: 0, failed: 0 });
      expect(admin.json.failures).toEqual([]);
    });

    it("falhas de reunião alheia não aparecem em failures[]", async () => {
      await h.pool.query(`UPDATE search_index_state SET status = 'failed', attempts = 5, last_error = 'erro de teste' WHERE meeting_id = $1`, [secret]);
      try {
        const other = await h.call("bi-bia", "GET", "/search/status");
        expect(JSON.stringify(other.json)).not.toContain("confidencial da Ana");
        expect(other.json.failures).toEqual([]);
        const owner = await h.call("bi-ana", "GET", "/search/status");
        expect(owner.json.failures.map((f: { meetingId: string }) => f.meetingId)).toEqual([secret]);
      } finally {
        await h.pool.query(`UPDATE search_index_state SET status = 'indexed', attempts = 0, last_error = NULL WHERE meeting_id = $1`, [secret]);
      }
    });

    it("estado por reunião: 404 igual para alheia e inexistente", async () => {
      const alien = await h.call("bi-bia", "GET", `/search/status?meetingId=${secret}`);
      const missing = await h.call("bi-bia", "GET", "/search/status?meetingId=00000000-0000-4000-8000-0000000000aa");
      expect(alien.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(alien.json).toEqual(missing.json);
      expect((await h.call("bi-ana", "GET", `/search/status?meetingId=${secret}`)).status).toBe(200);
    });

    it("reindex: só reuniões do próprio usuário; alheia = 404; destinatário com edição também", async () => {
      expect((await h.call("bi-bia", "POST", "/search/reindex", { meetingId: secret })).status).toBe(404);
      await h.pool.query(`INSERT INTO meeting_shares (meeting_id, user_id, access) VALUES ($1, $2, 'edit')`, [secret, h.ids["bi-bia"]]);
      expect((await h.call("bi-bia", "POST", "/search/reindex", { meetingId: secret })).status).toBe(404);
      await h.pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1`, [secret]);
      const own = await h.call("bi-bia", "POST", "/search/reindex", {});
      expect(own.status).toBe(202);
      expect(own.json.queued).toBe(1);
      const pending = await h.pool.query(`SELECT status FROM search_index_state WHERE meeting_id = $1`, [secret]);
      expect(pending.rows[0].status).not.toBe("pending");
      await h.drain();
    });

    it("corpo de reindex com campo desconhecido é recusado", async () => {
      expect((await h.call("bi-ana", "POST", "/search/reindex", { todos: true })).status).toBe(400);
      expect((await h.call("bi-ana", "POST", "/search/reindex", { meetingId: "nao-uuid" })).status).toBe(400);
    });
  });
});
