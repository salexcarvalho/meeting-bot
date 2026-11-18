import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SECRET = "trecho-confidencial-da-reuniao-xyz";
const TITLE = "titulo-secreto-da-reuniao-xyz";
const Schema = z.object({ ok: z.boolean() });

type Loaded = {
  llm: typeof import("../../src/llm");
  pool: import("pg").Pool;
  recorder: typeof import("../../src/usage/recorder");
  jobs: typeof import("../../src/llm/hostJobs");
  liveAsr: typeof import("../../src/usage/liveAsr");
};

// Um registro por chamada, em todos os provedores, sem texto de reunião (specs/004-uso-custo, US1/US2).
describe.skipIf(!enabled)("registro de uso de LLM e ASR (Postgres)", () => {
  let m: Loaded;
  let ownerId: string;
  let meetingId: string;

  async function load(): Promise<Loaded> {
    vi.resetModules();
    vi.stubEnv("ALLOW_EXTERNAL_LLM", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-teste");
    vi.stubEnv("CLAUDE_CLI_ENABLED", "true");
    vi.stubEnv("CODEX_CLI_ENABLED", "false");
    const db = await import("../../src/db");
    const { migrate } = await import("../../src/schema");
    await migrate(db.pool);
    return {
      llm: await import("../../src/llm"),
      pool: db.pool,
      recorder: await import("../../src/usage/recorder"),
      jobs: await import("../../src/llm/hostJobs"),
      liveAsr: await import("../../src/usage/liveAsr"),
    };
  }

  const request = () => ({
    system: "s",
    user: SECRET,
    schema: Schema,
    numCtx: 4096,
    label: "narrativa abc",
    purpose: "ata" as const,
    meetingId,
  });

  const rows = async (): Promise<Record<string, any>[]> =>
    (await m.pool.query(`SELECT * FROM ai_usage_logs WHERE meeting_id = $1 ORDER BY id`, [meetingId])).rows;

  async function waitFor(count: number): Promise<Record<string, any>[]> {
    for (let i = 0; i < 60; i++) {
      const found = await rows();
      if (found.length >= count) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    return rows();
  }

  const openrouterReply = (extra: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0421 },
        ...extra,
      }),
      { status: 200 },
    );

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m = await load();
    const { createUser } = await import("../../src/db");
    ownerId = (await createUser("uso-dono", "hash", { role: "USER", realName: "Dono" })).id;
    meetingId = (
      await m.pool.query(
        `INSERT INTO meetings (title, platform, status, source, created_by, extract_items) VALUES ($1, 'none', 'done', 'manual', $2, true) RETURNING id`,
        [TITLE, ownerId],
      )
    ).rows[0].id;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await m.pool.query(`DELETE FROM ai_usage_logs WHERE meeting_id = $1`, [meetingId]);
  });

  afterAll(async () => {
    await m.pool.end();
    vi.unstubAllEnvs();
  });

  it("OpenRouter: custo informado pelo provedor e modelo efetivo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openrouterReply()));
    await m.llm.generate("post", request(), "openrouter");
    const [row] = await waitFor(1);
    expect(row).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5", input_tokens: "1200", output_tokens: "300", success: true });
    expect(Number(row.cost_usd)).toBeCloseTo(0.0421, 6);
  });

  it("OpenRouter sem custo na resposta: custo nulo, não zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openrouterReply({ usage: { prompt_tokens: 7, completion_tokens: 3 } })));
    await m.llm.generate("post", request(), "openrouter");
    const [row] = await waitFor(1);
    expect(row.cost_usd).toBeNull();
    expect(row.input_tokens).toBe("7");
  });

  it("assinatura: tokens e tempo do host-agent, sem custo por chamada", async () => {
    let stop = false;
    const agent = (async () => {
      while (!stop) {
        const job = await m.jobs.hostJobs.next(50);
        if (job) {
          m.jobs.hostJobs.complete(job.id, {
            ok: true,
            output: { ok: true },
            usage: { inputTokens: 900, outputTokens: 80, model: "claude-sonnet-5" },
            durationMs: 4200,
          });
        }
      }
    })();
    await m.llm.generate("post", request(), "claude");
    stop = true;
    await agent;
    const [row] = await waitFor(1);
    expect(row).toMatchObject({ provider: "claude", model: "claude-sonnet-5", input_tokens: "900", output_tokens: "80", cost_usd: null, success: true });
  });

  it("falha forçada (chave recusada): success=false com código curto, sem mensagem do provedor nem texto da reunião", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: `chave inválida para ${SECRET}` } }), { status: 401 })),
    );
    await expect(m.llm.generate("post", request(), "openrouter")).rejects.toThrow();
    const [row] = await waitFor(1);
    expect(row).toMatchObject({ provider: "openrouter", success: false, error_code: "http_401" });
    expect(await rows()).toHaveLength(1);
  });

  it("chamada sem reunião fica sem dono (grupo instância)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openrouterReply()));
    const before = Number((await m.pool.query(`SELECT count(*) FROM ai_usage_logs WHERE user_id IS NULL AND meeting_id IS NULL`)).rows[0].count);
    await m.llm.generate("post", { ...request(), meetingId: undefined, label: "teste avulso" }, "openrouter");
    for (let i = 0; i < 60; i++) {
      const n = Number((await m.pool.query(`SELECT count(*) FROM ai_usage_logs WHERE user_id IS NULL AND meeting_id IS NULL`)).rows[0].count);
      if (n > before) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const { rows: found } = await m.pool.query(`SELECT user_id, meeting_id FROM ai_usage_logs WHERE label = 'teste avulso'`);
    expect(found).toEqual([{ user_id: null, meeting_id: null }]);
    await m.pool.query(`DELETE FROM ai_usage_logs WHERE label = 'teste avulso'`);
  });

  it("contrato 'sem conteúdo': nenhuma coluna de texto contém a transcrição nem o título da reunião (SC-007)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openrouterReply()));
    await m.llm.generate("post", request(), "openrouter");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 402 })));
    await expect(m.llm.generate("post", request(), "openrouter")).rejects.toThrow();
    await waitFor(2);
    const { rows: columns } = await m.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ai_usage_logs' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(["category", "channel", "error_code", "label", "model", "provider", "purpose", "source"]);
    for (const { column_name: column } of columns) {
      const { rows: hit } = await m.pool.query(
        `SELECT count(*)::int AS n FROM ai_usage_logs WHERE ${column}::text ILIKE $1 OR ${column}::text ILIKE $2`,
        [`%${SECRET}%`, `%${TITLE}%`],
      );
      expect(hit[0].n, `coluna ${column}`).toBe(0);
    }
    const audits = await m.pool.query(`SELECT detail::text AS d FROM audit_log WHERE kind = 'external_llm' AND detail->>'meetingId' = $1`, [meetingId]);
    for (const { d } of audits.rows) expect(d).not.toContain(SECRET);
    // o rastro de saída agora carrega o dono da reunião
    const { rows: owners } = await m.pool.query(`SELECT DISTINCT user_id FROM audit_log WHERE kind = 'external_llm' AND detail->>'meetingId' = $1`, [meetingId]);
    expect(owners).toEqual([{ user_id: ownerId }]);
  });

  it("ASR: Whisper final, ao vivo agregado e externo gravam minutos (só o externo tem custo)", async () => {
    m.recorder.recordUsage({
      category: "asr", purpose: "asr_final", provider: "whisper", model: null, meetingId, inputTokens: null, outputTokens: null,
      audioSeconds: 1800, costUsd: null, durationMs: 90_000, computeMs: null, attempts: 1, success: true, errorCode: null, label: "2 canal(is)",
    });
    m.recorder.recordUsage({
      category: "asr", purpose: "asr_final", provider: "deepgram", model: "deepgram/nova-3", meetingId, channel: "remote", inputTokens: 83,
      outputTokens: 30, audioSeconds: 9.2, costUsd: 0.000508, durationMs: 2000, computeMs: null, attempts: 1, success: true, errorCode: null, label: null,
    });
    for (let i = 0; i < 200; i++) m.liveAsr.liveAsrUsage.add(meetingId, "mixed", { duration: 15, elapsed: 1 });
    m.liveAsr.liveAsrUsage.flush(meetingId, "mixed");
    const found = await waitFor(3);
    expect(found).toHaveLength(3);
    const by = Object.fromEntries(found.map((r) => [r.provider === "whisper" ? r.purpose : "deepgram", r]));
    expect(Number(by.asr_final.audio_seconds)).toBe(1800);
    expect(by.asr_final.cost_usd).toBeNull();
    expect(Number(by.asr_ao_vivo.audio_seconds)).toBe(3000);
    expect(by.asr_ao_vivo.compute_ms).toBe(200_000);
    expect(by.asr_ao_vivo.channel).toBe("mixed");
    expect(Number(by.deepgram.audio_seconds)).toBeCloseTo(9.2, 2);
    expect(Number(by.deepgram.cost_usd)).toBeCloseTo(0.000508, 6);
    expect(by.deepgram.channel).toBe("remote");
  });

  it("ASR externo com erro: linha de falha com código e os minutos já feitos não contam como erro de texto", async () => {
    m.recorder.recordUsage({
      category: "asr", purpose: "asr_final", provider: "deepgram", model: "deepgram/nova-3", meetingId, channel: "mic", inputTokens: null,
      outputTokens: null, audioSeconds: 0, costUsd: null, durationMs: 500, computeMs: null, attempts: 1, success: false, errorCode: "http_402", label: null,
    });
    const [row] = await waitFor(1);
    expect(row).toMatchObject({ success: false, error_code: "http_402", provider: "deepgram" });
  });
});
