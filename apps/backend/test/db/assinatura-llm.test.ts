import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const PASSWORD = "senha-forte-123";
const AGENT = { authorization: `Bearer ${"teste-".repeat(8)}` };

// Assinatura pessoal (claude/codex) com um host-agent falso falando HTTP com o backend real.
describe.skipIf(!enabled)("geração com a assinatura via host-agent (HTTP + Postgres)", async () => {
  vi.stubEnv("ALLOW_EXTERNAL_LLM", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("CLAUDE_CLI_ENABLED", "true");
  vi.stubEnv("CODEX_CLI_ENABLED", "true");
  vi.stubEnv("CLAUDE_CLI_MODEL", "sonnet");
  vi.stubEnv("LLM_GENERATION_PROVIDER", "local");
  vi.stubEnv("AGENT_OWNER", "as-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { isProcessing } = await import("../../src/pipeline");
  const { invalidateHostOwner } = await import("../../src/recording/owner");

  let server: Server;
  let base = "";
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const meetings: Record<string, { id: string; item: string }> = {};

  async function call(who: string, method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: { cookie: cookies[who], ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function agent(method: string, url: string, body?: unknown, headers: Record<string, string> = AGENT) {
    const res = await fetch(`${base}/api/agent${url}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const heartbeat = (llm: unknown) => agent("POST", "/heartbeat", { version: "teste", capture: null, llm });

  async function doneMeeting(who: string, title: string) {
    const start = new Date(Date.now() - 3600_000).toISOString();
    const created = await call(who, "POST", "/meetings/scheduled", { title, start, durationMinutes: 30 });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    await pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [id]);
    await pool.query(
      `INSERT INTO transcript_segments (meeting_id, speaker, text, start_seconds, end_seconds, channel, pass)
       VALUES ($1, 'Sérgio', 'Vamos usar fila de mensagens entre os serviços.', 0, 5, 'mic', 'final')`,
      [id],
    );
    const item = await call(who, "POST", `/meetings/${id}/items`, {
      type: "decisao_arquitetural",
      description: "Usar fila de mensagens entre os serviços",
    });
    expect(item.status).toBe(201);
    return { id, item: item.json.id as string };
  }

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword(PASSWORD);
    ids["as-dono"] = (await createUser("as-dono", hash, { role: "SUPER_ADMIN" })).id;
    ids["as-outra"] = (await createUser("as-outra", hash, { role: "USER" })).id;
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const name of Object.keys(ids)) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name, password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      cookies[name] = res.headers.get("set-cookie")!.split(";")[0];
    }
    meetings.dono = await doneMeeting("as-dono", "Arquitetura do dono");
    meetings.outra = await doneMeeting("as-outra", "Arquitetura da outra pessoa");
  });

  afterAll(async () => {
    server?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("sem host-agent a assinatura aparece indisponível e é recusada", async () => {
    const options = await call("as-dono", "GET", `/meetings/${meetings.dono.id}/llm-options`);
    expect(options.status).toBe(200);
    expect(options.json.subscriptions).toEqual([
      { id: "claude", model: "sonnet", available: false, reason: "O host-agent está desligado nesta máquina." },
      { id: "codex", model: "padrão", available: false, reason: "O host-agent está desligado nesta máquina." },
    ]);
    const me = await call("as-dono", "GET", "/auth/me");
    expect(me.json.llm.subscriptions.map((s: { id: string }) => s.id)).toEqual(["claude", "codex"]);
    const res = await call("as-dono", "POST", `/meetings/${meetings.dono.id}/adrs/generate`, { llm: "claude" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/host-agent está desligado/);
    expect((await call("as-dono", "POST", `/meetings/${meetings.dono.id}/adrs/generate`, { llm: "gemini" })).status).toBe(400);
  });

  it("rotas do host-agent exigem o token e validam o resultado", async () => {
    expect((await agent("GET", "/llm/next?wait=0", undefined, {})).status).toBe(401);
    expect((await agent("GET", "/llm/next?wait=0")).status).toBe(204);
    const unknown = await agent("POST", "/llm/00000000-0000-4000-8000-000000000000/result", { ok: true, output: {} });
    expect(unknown.status).toBe(404);
    expect((await agent("POST", "/llm/x/result", { ok: "sim" })).status).toBe(400);
  });

  it("com o host-agent pronto, só o dono gera; CLI sem login é explicado", async () => {
    expect(
      (
        await heartbeat({
          claude: { available: true, reason: null, version: "2.1" },
          codex: { available: false, reason: "Codex sem login na pasta do agente", version: "0.1" },
        })
      ).status,
    ).toBe(200);
    const options = await call("as-dono", "GET", `/meetings/${meetings.dono.id}/llm-options`);
    expect(options.json.subscriptions).toEqual([
      { id: "claude", model: "sonnet", available: true, reason: null },
      { id: "codex", model: "padrão", available: false, reason: "Codex sem login na pasta do agente" },
    ]);
    const codex = await call("as-dono", "POST", `/meetings/${meetings.dono.id}/adrs/generate`, { llm: "codex" });
    expect(codex.status).toBe(409);
    expect(codex.json.error).toBe("Codex sem login na pasta do agente");

    const other = await call("as-outra", "POST", `/meetings/${meetings.outra.id}/adrs/generate`, { llm: "claude" });
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/só para as reuniões dele/);
    const otherAta = await call("as-outra", "POST", `/meetings/${meetings.outra.id}/reprocess`, { step: "analysis", llm: "claude" });
    expect(otherAta.status).toBe(409);
    const otherOptions = await call("as-outra", "GET", `/meetings/${meetings.outra.id}/llm-options`);
    expect(otherOptions.json.subscriptions[0]).toMatchObject({ available: false, reason: expect.stringMatching(/dono do host-agent/) });
  });

  it("gera o ADR pelo host-agent e grava quem gerou", async () => {
    await heartbeat({ claude: { available: true, reason: null, version: "2.1" } });
    const jobs: Record<string, unknown>[] = [];
    let stop = false;
    const fakeAgent = (async () => {
      while (!stop) {
        const next = await agent("GET", "/llm/next?wait=1");
        if (next.status !== 200) continue;
        jobs.push(next.json);
        const done = await agent("POST", `/llm/${next.json.id}/result`, {
          ok: true,
          output: {
            titulo: "Fila de mensagens entre os serviços",
            contexto: "Serviços acoplados de forma síncrona.",
            problema: "Falhas em cascata.",
            alternativas: [{ opcao: "Chamada síncrona", pros: "simples", contras: "acoplamento" }],
            decisao: "Usar fila de mensagens.",
            consequencias: "Processamento assíncrono.",
            riscos: ["Perda de mensagens sem fila durável"],
          },
          usage: { inputTokens: 1200, outputTokens: 300, model: "claude-sonnet-5" },
          durationMs: 4000,
        });
        expect(done.status).toBe(200);
      }
    })();
    try {
      const res = await call("as-dono", "POST", `/meetings/${meetings.dono.id}/adrs/generate`, {
        llm: "claude",
        itemId: meetings.dono.item,
      });
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ status: "queued", provider: "claude:sonnet" });
      await expect.poll(() => isProcessing(meetings.dono.id), { timeout: 15_000 }).toBe(false);
    } finally {
      stop = true;
      await fakeAgent;
    }
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ provider: "claude", model: "sonnet", timeoutSeconds: 600 });
    expect(jobs[0].user).toContain("Usar fila de mensagens entre os serviços");
    expect((jobs[0].schema as { required: string[] }).required).toContain("decisao");

    const { rows } = await pool.query(`SELECT title, generated_by, status FROM adrs WHERE item_id = $1`, [meetings.dono.item]);
    expect(rows).toEqual([{ title: "Fila de mensagens entre os serviços", generated_by: "claude:sonnet", status: "proposto" }]);
    const calls = await pool.query(
      `SELECT detail FROM audit_log WHERE kind = 'external_llm' AND detail->>'meetingId' = $1`,
      [meetings.dono.id],
    );
    expect(calls.rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({ provider: "claude", model: "claude-sonnet-5", promptTokens: 1200, cost: null }),
    ]);
  });
});
