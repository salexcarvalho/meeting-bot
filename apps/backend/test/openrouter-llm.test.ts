import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Narrativa } from "@meeting-bot/contracts";
import { ExternalLlmError, OpenRouterLlm } from "../src/llm/openrouter";
import { UsageCarryingError } from "../src/llm/provider";
import { classifyError } from "../src/usage/errorCode";

const { audits } = vi.hoisted(() => ({
  audits: [] as { kind: string; detail: Record<string, unknown>; userId: string | null }[],
}));
vi.mock("../src/security/audit", () => ({
  audit: (kind: string, detail: Record<string, unknown>, userId: string | null = null) =>
    audits.push({ kind, detail, userId }),
}));
vi.mock("../src/usage/recorder", () => ({
  ownerOfMeeting: async () => "dono-1",
  recordUsage: vi.fn(),
}));

const settings = {
  url: "https://openrouter.ai/api/v1",
  apiKey: "sk-teste",
  model: "anthropic/claude-sonnet-5",
  timeoutMs: 5_000,
  maxTokens: 4096,
};
const VALID = { objetivo: "o", resumo_executivo: "r", assuntos: [{ titulo: "t", resumo: "r" }], observacoes_arquiteto: [] };
const SECRET_TEXT = "trecho confidencial da reunião";

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      model: settings.model,
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.0006 },
      ...extra,
    }),
    { status: 200 },
  );
}

const request = {
  system: "sistema",
  user: SECRET_TEXT,
  schema: Narrativa,
  numCtx: 8192,
  label: "narrativa abc",
  purpose: "ata" as const,
  meetingId: "11111111-1111-1111-1111-111111111111",
};

describe("OpenRouterLlm", () => {
  const fetchMock = vi.fn();
  const sleep = vi.fn(async () => {});

  beforeEach(() => {
    audits.length = 0;
    fetchMock.mockReset();
    sleep.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pede saída estruturada estrita, só a provedores que a suportam, e valida", async () => {
    fetchMock.mockResolvedValueOnce(completion(VALID));
    const llm = new OpenRouterLlm(settings, sleep);
    await expect(llm.generate(request)).resolves.toMatchObject({ data: VALID });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-teste");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(settings.model);
    // parâmetro opcional derrubaria modelos que não o aceitam (require_parameters)
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_tokens).toBe(4096);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toContain("resumo_executivo");
    expect(JSON.stringify(body.response_format)).not.toContain("maxLength");
    expect(body.messages).toEqual([
      { role: "system", content: "sistema" },
      { role: "user", content: SECRET_TEXT },
    ]);
  });

  it("audita uso e custo sem o conteúdo", async () => {
    fetchMock.mockResolvedValueOnce(completion(VALID));
    await new OpenRouterLlm(settings, sleep).generate(request);
    // a duração varia por execução: confere o tipo e tira do comparado
    expect(typeof audits[0]?.detail.durationMs).toBe("number");
    audits.forEach((a) => delete (a.detail as Record<string, unknown>).durationMs);
    expect(audits).toEqual([
      {
        kind: "external_llm",
        userId: "dono-1",
        detail: {
          meetingId: request.meetingId,
          label: "narrativa abc",
          provider: "openrouter",
          purpose: "ata",
          model: settings.model,
          promptTokens: 120,
          completionTokens: 40,
          cost: 0.0006,
          success: true,
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);
  });

  it("devolve o uso somado das tentativas (tokens e custo informados, nada calculado)", async () => {
    fetchMock.mockResolvedValueOnce(completion({ objetivo: "o" })).mockResolvedValueOnce(completion(VALID));
    const out = await new OpenRouterLlm(settings, sleep).generate(request);
    expect(out.usage).toEqual({
      inputTokens: 240,
      outputTokens: 80,
      costUsd: 0.0012,
      computeMs: null,
      attempts: 2,
      model: settings.model,
    });
  });

  it("sem custo na resposta, o custo fica nulo", async () => {
    fetchMock.mockResolvedValueOnce(completion(VALID, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const out = await new OpenRouterLlm(settings, sleep).generate(request);
    expect(out.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: null });
  });

  it("falha por HTTP leva o código do status e audita a recusa sem conteúdo", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 }));
    const err = await new OpenRouterLlm(settings, sleep).generate(request).catch((e) => e);
    expect(err).toBeInstanceOf(UsageCarryingError);
    expect(classifyError(err)).toBe("http_402");
    expect(audits.at(-1)).toMatchObject({
      kind: "external_llm",
      userId: "dono-1",
      detail: { success: false, errorCode: "http_402", purpose: "ata" },
    });
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);
  });

  it("tenta de novo uma vez quando a saída não valida", async () => {
    fetchMock.mockResolvedValueOnce(completion({ objetivo: "o" })).mockResolvedValueOnce(completion(VALID));
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).resolves.toMatchObject({ data: VALID });
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retry.messages).toHaveLength(4);
    expect(retry.messages[3].content).toMatch(/não seguiu o schema/);
  });

  it("falha como resposta inválida após duas saídas ruins ou resposta cortada", async () => {
    fetchMock.mockResolvedValueOnce(completion("não é json")).mockResolvedValueOnce(completion({}));
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).rejects.toThrow(/Resposta do LLM inválida/);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"objetivo\"" }, finish_reason: "length" }], usage: {} }),
        { status: 200 },
      ),
    );
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).rejects.toThrow(/limite de tokens/);
  });

  it("não repete em erro de autenticação e repete em limite de taxa", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "No auth" } }), { status: 401 }));
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).rejects.toMatchObject({ causeError: expect.any(ExternalLlmError) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429 }))
      .mockResolvedValueOnce(completion(VALID));
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).resolves.toMatchObject({ data: VALID });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("trata erro do provedor com status 200 como falha temporária", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "upstream", code: 502 } }), { status: 200 }))
      .mockResolvedValueOnce(completion(VALID));
    await expect(new OpenRouterLlm(settings, sleep).generate(request)).resolves.toMatchObject({ data: VALID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recusa sem chave e sem chamar a rede", async () => {
    await expect(new OpenRouterLlm({ ...settings, apiKey: "" }, sleep).generate(request)).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("escolha do provedor de geração", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadLlm(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("../src/llm");
  }

  it("sem a flag, não há LLM: tudo é recusado com o aviso claro", async () => {
    const llm = await loadLlm({ ALLOW_EXTERNAL_LLM: "false", OPENROUTER_API_KEY: "sk" });
    expect(llm.parseLlmChoice(undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/ative ALLOW_EXTERNAL_LLM/) });
    expect(llm.llmSummary()).toMatchObject({ ok: false, model: "claude:sonnet" });
    await expect(llm.automaticProvider("dono")).rejects.toThrow(/ative ALLOW_EXTERNAL_LLM.*transcrição está salva/);
    expect(await llm.generationBlock("claude", "dono")).toMatch(/ALLOW_EXTERNAL_LLM/);
    expect(llm.parseLlmChoice("openrouter")).toMatchObject({ ok: false, error: expect.stringMatching(/ALLOW_EXTERNAL_LLM/) });
    expect(llm.parseLlmChoice("gpt")).toMatchObject({ ok: false });
    expect((await llm.llmOptions(null)).external).toBeNull();
    await expect(llm.generate("post", request, "openrouter")).rejects.toThrow(/desabilitado/);
  });

  it("com a flag: padrão do .env, chave obrigatória e ao vivo no mesmo provedor", async () => {
    const llm = await loadLlm({
      ALLOW_EXTERNAL_LLM: "true",
      LLM_GENERATION_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "",
      OPENROUTER_LLM_MODEL: "google/gemini-3.7-flash",
    });
    expect(llm.parseLlmChoice("default")).toMatchObject({ ok: false, error: expect.stringMatching(/OPENROUTER_API_KEY/) });
    expect(llm.parseLlmChoice("openrouter")).toMatchObject({ ok: false, error: expect.stringMatching(/OPENROUTER_API_KEY/) });
    expect(await llm.generationBlock("openrouter", null)).toMatch(/OPENROUTER_API_KEY/);
    expect(await llm.llmOptions(null)).toMatchObject({
      default: "openrouter",
      external: { model: "google/gemini-3.7-flash", available: false },
    });
    expect(llm.generationLabel("openrouter")).toBe("openrouter:google/gemini-3.7-flash");
    await expect(llm.generate("live", request, "openrouter")).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("LLM_GENERATION_PROVIDER: sem a flag a app sobe (só a geração fica desligada); 'local' não existe mais", async () => {
    const llm = await loadLlm({ ALLOW_EXTERNAL_LLM: "false", LLM_GENERATION_PROVIDER: "openrouter" });
    expect(llm.llmSummary().ok).toBe(false);
    await expect(loadLlm({ LLM_GENERATION_PROVIDER: "local" })).rejects.toThrow(/LLM_GENERATION_PROVIDER inválido/);
  });
});
