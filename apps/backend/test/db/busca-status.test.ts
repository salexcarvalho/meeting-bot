import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchHarness } from "./busca-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// Acompanhar e reconstruir o índice (US5): contadores por estado, pausa, motivo das falhas, evento
// de estado para a página da reunião e resumo em /system/status.
describe.skipIf(!enabled)("busca: estado do índice (Postgres + HTTP)", async () => {
  const { startSearchHarness } = await import("./busca-harness");
  let h: SearchHarness;

  async function meeting(title: string, text = "assunto qualquer da reunião") {
    const id = await h.seedMeeting("bs-ana", { title });
    await h.seedSegments(id, [{ speaker: "Ana", text, start: 0 }]);
    return id;
  }

  beforeAll(async () => {
    h = await startSearchHarness([["bs-ana", "USER", "Ana Lima"]]);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("contadores por estado, modelo e dimensão da coluna", async () => {
    const indexed = await meeting("Indexada");
    const textOnly = await meeting("Só texto");
    const pending = await meeting("Pendente");
    const failed = await meeting("Com falha");
    await h.index(indexed);
    h.embedder.available = false;
    await h.index(textOnly);
    h.embedder.available = true;
    await h.enqueue(pending);
    await h.enqueue(failed);
    await h.pool.query(`UPDATE search_index_state SET status = 'failed', attempts = 5, last_error = 'Ollama não respondeu a tempo (embeddings).' WHERE meeting_id = $1`, [failed]);

    const res = await h.call("bs-ana", "GET", "/search/status");
    expect(res.status).toBe(200);
    expect(res.json.enabled).toBe(true);
    expect(res.json.semantic).toMatchObject({ available: true, model: "bge-m3", dim: 1024, reason: null });
    expect(res.json.chat).toEqual({ available: true, reason: null });
    expect(res.json.totals).toMatchObject({ meetings: 4, indexed: 1, textReady: 1, pending: 1, failed: 1 });
    expect(res.json.totals.chunks).toBeGreaterThanOrEqual(4);
    expect(res.json.paused).toBeNull();
    expect(res.json.failures).toEqual([{ meetingId: failed, title: "Com falha", error: "Ollama não respondeu a tempo (embeddings).", attempts: 5 }]);

    const one = await h.call("bs-ana", "GET", `/search/status?meetingId=${indexed}`);
    expect(one.json).toMatchObject({ meetingId: indexed, status: "indexed" });
    expect(one.json.embeddedCount).toBe(one.json.chunkCount);
    expect(one.json.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const partial = await h.call("bs-ana", "GET", `/search/status?meetingId=${textOnly}`);
    expect(partial.json).toMatchObject({ status: "text_ready", embeddedCount: 0, indexedAt: null });
  });

  it("Ollama fora aparece como indisponível, com o motivo, e o chat acompanha", async () => {
    h.embedder.available = false;
    const res = await h.call("bs-ana", "GET", "/search/status");
    h.embedder.available = true;
    expect(res.json.semantic).toMatchObject({ available: false, reason: "ollama_indisponivel" });
    expect(res.json.chat).toEqual({ available: false, reason: "ollama_indisponivel" });
  });

  it("reindexar recoloca as reuniões do usuário na fila e o worker conclui", async () => {
    const res = await h.call("bs-ana", "POST", "/search/reindex", {});
    expect(res.status).toBe(202);
    expect(res.json.queued).toBeGreaterThanOrEqual(4);
    const status = await h.call("bs-ana", "GET", "/search/status");
    expect(status.json.totals.failed).toBe(0);
    expect(status.json.failures).toEqual([]);
    await h.drain();
    const after = await h.call("bs-ana", "GET", "/search/status");
    expect(after.json.totals).toMatchObject({ pending: 0, textReady: 0, failed: 0 });
  });

  it("o worker publica o estado da reunião (sem conteúdo) para a página atualizar sozinha", async () => {
    const { hub } = await import("../../src/live/hub");
    const spy = vi.spyOn(hub, "publishToMeeting");
    try {
      const id = await meeting("Evento de estado", "texto que não pode ir no evento");
      await h.index(id);
      const events = spy.mock.calls.map(([meetingId, message]) => ({ meetingId, message })).filter((e) => e.meetingId === id && e.message.type === "search_index");
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.message).toEqual({ type: "search_index", meetingId: id, status: "indexed" });
      expect(JSON.stringify(events)).not.toContain("não pode ir");
    } finally {
      spy.mockRestore();
    }
  });

  it("o resumo do /system/status traz habilitada, semântica e pausa", async () => {
    const res = await h.call("bs-ana", "GET", "/system/status");
    expect(res.status).toBe(200);
    expect(res.json.search).toEqual({ enabled: true, semantic: true, paused: false });
  });

  it("CLI search:reindex enfileira por reunião ou todas e só imprime a contagem", async () => {
    const id = await meeting("Via CLI");
    const run = (...args: string[]) =>
      spawnSync("npx", ["tsx", "src/cli/reindex.ts", ...args], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, AGENT_TOKEN: "teste-".repeat(8), DATA_DIR: "/tmp/agente-reunioes-teste" },
        encoding: "utf8",
      });
    const one = run(id);
    expect(one.status).toBe(0);
    expect(one.stdout.trim()).toBe("1 reunião(ões) na fila de indexação.");
    expect((await h.pool.query(`SELECT status FROM search_index_state WHERE meeting_id = $1`, [id])).rows[0].status).toBe("pending");
    const all = run();
    expect(all.status).toBe(0);
    expect(Number(all.stdout.split(" ")[0])).toBeGreaterThanOrEqual(5);
    expect(run("nao-e-uuid").status).toBe(1);
    await h.drain();
  });
});
