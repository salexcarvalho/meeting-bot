import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Narrativa, type AgentLlmJob } from "@meeting-bot/contracts";
import { HostCliLlm, SubscriptionLlmError } from "../src/llm/hostCli";
import { HostJobError, HostJobQueue } from "../src/llm/hostJobs";

const { audits, owner } = vi.hoisted(() => ({
  audits: [] as { kind: string; detail: Record<string, unknown> }[],
  owner: { current: { id: "dono", name: "Sérgio" } as { id: string; name: string } | null },
}));
vi.mock("../src/security/audit", () => ({
  audit: (kind: string, detail: Record<string, unknown>) => audits.push({ kind, detail }),
}));
vi.mock("../src/recording/owner", () => ({
  hostAgentOwner: async () => owner.current,
  invalidateHostOwner: () => {},
}));

const VALID = { objetivo: "o", resumo_executivo: "r", assuntos: [{ titulo: "t", resumo: "r" }], observacoes_arquiteto: [] };
const SECRET_TEXT = "trecho confidencial da reunião";
const request = {
  system: "sistema",
  user: SECRET_TEXT,
  schema: Narrativa,
  numCtx: 8192,
  label: "narrativa abc",
  meetingId: "11111111-1111-1111-1111-111111111111",
};

describe("HostJobQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("entrega o pedido a quem espera e resolve com o resultado", async () => {
    const q = new HostJobQueue({ claimTimeoutMs: 1000, graceMs: 1000 });
    const waiting = q.next(5000);
    const result = q.submit({ provider: "claude", model: "sonnet", system: "s", user: "u", schema: {}, timeoutSeconds: 10 });
    const job = (await waiting) as AgentLlmJob;
    expect(job).toMatchObject({ provider: "claude", model: "sonnet", user: "u" });
    expect(await q.next(0)).toBeNull();
    expect(q.complete(job.id, { ok: true, output: { a: 1 } })).toBe(true);
    await expect(result).resolves.toEqual({ ok: true, output: { a: 1 } });
    expect(q.complete(job.id, { ok: true, output: {} })).toBe(false);
    expect(q.size).toBe(0);
  });

  it("desiste quando ninguém pega e quando o CLI passa do tempo", async () => {
    const q = new HostJobQueue({ claimTimeoutMs: 1000, graceMs: 500 });
    const unclaimed = q.submit({ provider: "codex", model: "", system: "s", user: "u", schema: {}, timeoutSeconds: 2 });
    const check1 = expect(unclaimed).rejects.toThrow(/não pegou o pedido/);
    await vi.advanceTimersByTimeAsync(1001);
    await check1;

    const slow = q.submit({ provider: "codex", model: "", system: "s", user: "u", schema: {}, timeoutSeconds: 2 });
    const check2 = expect(slow).rejects.toThrow(HostJobError);
    const job = (await q.next(0))!;
    await vi.advanceTimersByTimeAsync(2400);
    expect(q.size).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await check2;
    expect(q.complete(job.id, { ok: true, output: {} })).toBe(false);
  });

  it("pedido de conexão que caiu volta para a fila", async () => {
    const q = new HostJobQueue({ claimTimeoutMs: 1000, graceMs: 500 });
    void q.submit({ provider: "claude", model: "", system: "s", user: "u", schema: {}, timeoutSeconds: 2 }).catch(() => {});
    const first = (await q.next(0))!;
    q.release(first.id);
    const again = (await q.next(0))!;
    expect(again.id).toBe(first.id);
    q.failAll("encerrando");
    expect(q.size).toBe(0);
  });

  it("espera abortada devolve nulo", async () => {
    const q = new HostJobQueue();
    const abort = new AbortController();
    const waiting = q.next(10_000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeNull();
  });
});

describe("HostCliLlm", () => {
  beforeEach(() => {
    audits.length = 0;
  });

  function withAgent(outputs: unknown[]) {
    const q = new HostJobQueue({ claimTimeoutMs: 5000, graceMs: 1000 });
    const jobs: AgentLlmJob[] = [];
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const job = await q.next(50);
        if (!job) continue;
        jobs.push(job);
        const out = outputs.shift();
        q.complete(
          job.id,
          out instanceof Error
            ? { ok: false, error: out.message }
            : { ok: true, output: out, usage: { inputTokens: 100, outputTokens: 20, model: "claude-sonnet-5" }, durationMs: 1500 },
        );
      }
    })();
    return { q, jobs, done: async () => ((stop = true), await loop) };
  }

  it("manda sistema, texto e schema; valida e audita sem conteúdo", async () => {
    const agent = withAgent([VALID]);
    const llm = new HostCliLlm({ provider: "claude", model: "sonnet", timeoutSeconds: 600 }, agent.q);
    await expect(llm.generate(request)).resolves.toEqual(VALID);
    await agent.done();
    expect(agent.jobs).toHaveLength(1);
    expect(agent.jobs[0]).toMatchObject({ provider: "claude", model: "sonnet", system: "sistema", user: SECRET_TEXT, timeoutSeconds: 600 });
    expect((agent.jobs[0].schema as { required: string[] }).required).toContain("resumo_executivo");
    expect(audits).toEqual([
      {
        kind: "external_llm",
        detail: {
          meetingId: request.meetingId,
          label: "narrativa abc",
          provider: "claude",
          model: "claude-sonnet-5",
          promptTokens: 100,
          completionTokens: 20,
          cost: null,
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);
  });

  it("só o Claude recebe os limites de tamanho (o Codex corta a frase no meio)", async () => {
    const claude = withAgent([VALID]);
    await new HostCliLlm({ provider: "claude", model: "sonnet", timeoutSeconds: 60 }, claude.q).generate(request);
    await claude.done();
    const codex = withAgent([VALID]);
    await new HostCliLlm({ provider: "codex", model: "", timeoutSeconds: 60 }, codex.q).generate(request);
    await codex.done();

    const limit = (job: AgentLlmJob) =>
      (job.schema as { properties: { resumo_executivo: { maxLength?: number } } }).properties.resumo_executivo.maxLength;
    expect(limit(claude.jobs[0])).toBe(1200);
    expect(limit(codex.jobs[0])).toBeUndefined();
  });

  it("CLI que desiste do schema vira resposta inválida, com nova tentativa", async () => {
    const agent = withAgent([new Error("error_max_structured_output_retries"), VALID]);
    const llm = new HostCliLlm({ provider: "claude", model: "sonnet", timeoutSeconds: 60 }, agent.q);
    await expect(llm.generate(request)).resolves.toEqual(VALID);
    await agent.done();
    expect(agent.jobs[1].user).toMatch(/não seguiu o schema \(Claude não conseguiu seguir o schema\)/);

    const twice = withAgent([
      new Error("error_max_structured_output_retries"),
      new Error("error_max_structured_output_retries"),
    ]);
    const other = new HostCliLlm({ provider: "claude", model: "sonnet", timeoutSeconds: 60 }, twice.q);
    // resposta inválida não derruba o passo (a ata segue sem aquele trecho); erro do CLI derruba
    await expect(other.generate(request)).rejects.toThrow(/Resposta do LLM inválida \(narrativa abc\)/);
    await twice.done();
  });

  it("aceita JSON em texto, tenta de novo com a resposta anterior e falha como resposta inválida", async () => {
    const agent = withAgent([JSON.stringify(VALID)]);
    const llm = new HostCliLlm({ provider: "codex", model: "", timeoutSeconds: 60 }, agent.q);
    await expect(llm.generate(request)).resolves.toEqual(VALID);
    await agent.done();

    const bad = withAgent([{ objetivo: "o" }, "não é json"]);
    const llm2 = new HostCliLlm({ provider: "codex", model: "", timeoutSeconds: 60 }, bad.q);
    await expect(llm2.generate(request)).rejects.toThrow(/Resposta do LLM inválida \(narrativa abc\): JSON inválido/);
    await bad.done();
    expect(bad.jobs[1].user).toContain(SECRET_TEXT);
    expect(bad.jobs[1].user).toMatch(/não seguiu o schema/);
    expect(bad.jobs[1].user).toContain('"objetivo":"o"');
  });

  it("erro do CLI vira falha com o nome da assinatura", async () => {
    const agent = withAgent([new Error("Not logged in")]);
    const llm = new HostCliLlm({ provider: "codex", model: "", timeoutSeconds: 60 }, agent.q);
    await expect(llm.generate(request)).rejects.toThrow(new SubscriptionLlmError("Codex: Not logged in"));
    await agent.done();
  });
});

describe("escolha da assinatura", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    owner.current = { id: "dono", name: "Sérgio" };
  });

  async function load(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const llm = await import("../src/llm");
    const state = await import("../src/recording/hostAgentState");
    return { llm, state };
  }

  const ON = { ALLOW_EXTERNAL_LLM: "true", CLAUDE_CLI_ENABLED: "true", CODEX_CLI_ENABLED: "true", CODEX_CLI_MODEL: "" };

  it("sem a flag de LLM externo a assinatura impede a subida", async () => {
    await expect(load({ ALLOW_EXTERNAL_LLM: "false", CLAUDE_CLI_ENABLED: "true" })).rejects.toThrow(/exigem ALLOW_EXTERNAL_LLM/);
    await expect(load({ ALLOW_EXTERNAL_LLM: "true", LLM_GENERATION_PROVIDER: "codex" })).rejects.toThrow(
      /exige CODEX_CLI_ENABLED/,
    );
    await expect(load({ ...ON, CLAUDE_CLI_MODEL: "sonnet; rm -rf" })).rejects.toThrow(/CLAUDE_CLI_MODEL inválido/);
  });

  it("vale só para o dono do host-agent, com o host-agent ligado e o CLI pronto", async () => {
    const { llm, state } = await load(ON);
    expect(llm.parseLlmChoice("claude")).toEqual({ ok: true, value: "claude" });
    expect(llm.generationLabel("claude")).toBe("claude:sonnet");
    expect(llm.generationLabel("codex")).toBe("codex:padrão");
    expect(await llm.subscriptionUnavailable("claude", "dono")).toMatch(/desligado/);

    state.recordHeartbeat({
      version: "t",
      capture: null,
      llm: {
        claude: { available: true, reason: null, version: "2.1" },
        codex: { available: false, reason: "faça login", version: "0.1" },
      },
    });
    expect(await llm.subscriptionUnavailable("claude", "dono")).toBeNull();
    expect(await llm.subscriptionUnavailable("claude", "outra-pessoa")).toMatch(/só para as reuniões dele/);
    expect(await llm.subscriptionUnavailable("codex", "dono")).toBe("faça login");
    expect((await llm.llmOptions("dono")).subscriptions).toEqual([
      { id: "claude", model: "sonnet", available: true, reason: null },
      { id: "codex", model: "padrão", available: false, reason: "faça login" },
    ]);
    owner.current = null;
    expect(await llm.subscriptionUnavailable("claude", "dono")).toMatch(/só para as reuniões dele/);
    await expect(llm.generate("live", request, "claude")).rejects.toThrow(/ao vivo é sempre local/);
  });

  it("geração automática: espera a assinatura voltar e nunca cai no local por falha passageira", async () => {
    const { llm, state } = await load({ ...ON, LLM_GENERATION_PROVIDER: "claude" });
    const heartbeat = () =>
      state.recordHeartbeat({ version: "t", capture: null, llm: { claude: { available: true, reason: null, version: null } } });

    // host-agent desligado e sem espera: erro claro, não gera no local
    await expect(llm.automaticProvider("dono")).rejects.toThrow(/claude indisponível .*host-agent está desligado.*Gerar ata/);

    // host-agent volta durante a espera (reinício do PC): usa o Claude
    let t = 0;
    const waits: string[] = [];
    const chosen = await llm.automaticProvider("dono", {
      waitMs: 60_000,
      pollMs: 5000,
      now: () => t,
      onWait: (reason) => waits.push(reason),
      sleep: async (ms) => {
        t += ms;
        if (t === 15_000) heartbeat();
      },
    });
    expect(chosen).toEqual({ provider: "claude", note: null });
    expect(waits).toEqual([expect.stringMatching(/desligado/)]);
    expect(t).toBe(15_000);

    // pronto de cara: sem espera
    expect(await llm.automaticProvider("dono")).toEqual({ provider: "claude", note: null });

    // CLI sem login não volta dentro do prazo: desiste com erro
    state.recordHeartbeat({ version: "t", capture: null, llm: { claude: { available: false, reason: "faça login", version: null } } });
    let u = 0;
    await expect(
      llm.automaticProvider("dono", { waitMs: 120_000, now: () => u, sleep: async (ms) => void (u += ms) }),
    ).rejects.toThrow(/claude indisponível há 2 min \(faça login\)/);
    expect(u).toBe(120_000);

    // reunião de outra pessoa: a assinatura é pessoal, então vai para o local (sem esperar)
    heartbeat();
    expect(await llm.automaticProvider("socio", { waitMs: 60_000 })).toEqual({
      provider: "local",
      note: expect.stringMatching(/só para as reuniões dele/),
    });
  });

  it("desligada no .env não aparece e é recusada", async () => {
    const { llm } = await load({ ALLOW_EXTERNAL_LLM: "true", CLAUDE_CLI_ENABLED: "false", OPENROUTER_API_KEY: "sk" });
    expect((await llm.llmOptions("dono")).subscriptions).toEqual([]);
    expect(llm.parseLlmChoice("claude")).toMatchObject({ ok: false, error: expect.stringMatching(/CLAUDE_CLI_ENABLED/) });
    await expect(llm.generate("post", request, "claude")).rejects.toThrow(/desabilitado/);
  });
});
