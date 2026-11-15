import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { recorded, recorder } = vi.hoisted(() => ({
  recorded: [] as Record<string, unknown>[],
  recorder: { throwOnRecord: false },
}));
vi.mock("../src/usage/recorder", () => ({
  recordUsage: (sample: Record<string, unknown>) => {
    if (recorder.throwOnRecord) throw new Error("registro quebrado");
    recorded.push(sample);
  },
  ownerOfMeeting: async () => null,
}));
vi.mock("../src/security/audit", () => ({ audit: vi.fn() }));

import { generate } from "../src/llm";

const Schema = z.object({ ok: z.boolean() });
const SECRET = "trecho confidencial da reunião";
const request = {
  system: "s",
  user: SECRET,
  schema: Schema,
  numCtx: 4096,
  label: "extração final abc 1/2",
  purpose: "itens" as const,
  meetingId: "11111111-1111-1111-1111-111111111111",
};

function ollamaReply(content: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ message: { content }, prompt_eval_count: 300, eval_count: 40, prompt_eval_duration: 1e9, eval_duration: 4e9, ...extra }),
    { status: 200 },
  );
}

// Funil único de geração: uma chamada = uma linha de uso, com ou sem nova tentativa interna.
describe("generate registra uso", () => {
  beforeEach(() => {
    recorded.length = 0;
    recorder.throwOnRecord = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uma chamada local = uma linha, com os números do Ollama e a finalidade declarada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ollamaReply('{"ok":true}')));
    await expect(generate("post", request)).resolves.toEqual({ ok: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      category: "llm",
      purpose: "itens",
      provider: "ollama",
      meetingId: request.meetingId,
      inputTokens: 300,
      outputTokens: 40,
      costUsd: null,
      computeMs: 5000,
      attempts: 1,
      success: true,
      errorCode: null,
      label: "extração final abc 1/2",
    });
    expect(typeof recorded[0].durationMs).toBe("number");
    // nenhum campo da amostra carrega o texto da reunião
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
  });

  it("nova tentativa por JSON inválido soma numa linha só", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(ollamaReply("não é json")).mockResolvedValueOnce(ollamaReply('{"ok":false}')),
    );
    await expect(generate("post", request)).resolves.toEqual({ ok: false });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ inputTokens: 600, outputTokens: 80, attempts: 2, success: true });
  });

  it("falha grava success=false com código curto e uso parcial, e o chamador recebe o erro original", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ollamaReply("sempre inválido")));
    await expect(generate("post", request)).rejects.toThrow(/Resposta do LLM inválida/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ success: false, errorCode: "schema_invalid", inputTokens: 600, attempts: 2 });
    expect(JSON.stringify(recorded)).not.toContain("sempre inválido");
  });

  it("registro quebrado não altera o retorno nem a falha da geração", async () => {
    recorder.throwOnRecord = true;
    vi.stubGlobal("fetch", vi.fn(async () => ollamaReply('{"ok":true}')));
    await expect(generate("post", request)).resolves.toEqual({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => ollamaReply("lixo")));
    await expect(generate("post", request)).rejects.toThrow(/inválida/);
  });

  it("externo desabilitado: a tentativa fica registrada como 'disabled' sem sair da máquina", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate("post", request, "openrouter")).rejects.toThrow(/desabilitado/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "openrouter", success: false, errorCode: "disabled" });
  });

  it("ao vivo com provedor externo é recusado e não grava nada", async () => {
    await expect(generate("live", request, "openrouter")).rejects.toThrow(/ao vivo é sempre local/);
    expect(recorded).toHaveLength(0);
  });
});
