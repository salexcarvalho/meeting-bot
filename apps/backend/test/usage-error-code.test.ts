import { describe, expect, it } from "vitest";
import { UsageErrorCode } from "@meeting-bot/contracts";
import { ExternalAsrError } from "../src/asr/openrouter";
import { WorkerUnavailableError } from "../src/asr/workerClient";
import { SubscriptionLlmError } from "../src/llm/hostCli";
import { HostJobError } from "../src/llm/hostJobs";
import { ExternalLlmError } from "../src/llm/openrouter";
import { UsageCarryingError, UsageMeter } from "../src/llm/provider";
import { classifyError } from "../src/usage/errorCode";

// A classificação é função pura e fechada: a mensagem do provedor nunca vira dado gravado.
describe("classifyError", () => {
  it("status HTTP vira http_<status>", () => {
    expect(classifyError(new ExternalLlmError("OpenRouter recusou a geração (402: sem créditos)", 402))).toBe("http_402");
    expect(classifyError(new ExternalAsrError("OpenRouter recusou a transcrição (413: grande)", 413))).toBe("http_413");
    expect(classifyError(new ExternalLlmError("x", 99))).toBe("other");
    expect(classifyError(new ExternalLlmError("x", 600))).toBe("other");
  });

  it("timeout e cancelamento pelo nome do erro", () => {
    expect(classifyError(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("cancelled");
    expect(classifyError(new HostJobError("O CLI não respondeu a tempo."))).toBe("timeout");
  });

  it("resposta fora do schema, cortada e recusada", () => {
    expect(classifyError(new Error("Resposta do LLM inválida (ata): JSON inválido"))).toBe("schema_invalid");
    expect(classifyError(new Error("Resposta do LLM inválida (x): resposta cortada pelo limite de tokens"))).toBe("truncated");
    expect(classifyError(new ExternalLlmError("O modelo recusou a tarefa: não posso"))).toBe("refused");
  });

  it("serviço fora e recurso desligado", () => {
    expect(classifyError(new HostJobError("O host-agent não pegou o pedido (está ligado nesta máquina?)."))).toBe("unavailable");
    expect(classifyError(new SubscriptionLlmError("Claude: Not logged in"))).toBe("unavailable");
    expect(classifyError(new WorkerUnavailableError("worker-gpu carregando o modelo"))).toBe("unavailable");
    expect(classifyError(new Error("LLM externo desabilitado (ALLOW_EXTERNAL_LLM=false)."))).toBe("disabled");
    expect(classifyError(new ExternalLlmError("OPENROUTER_API_KEY não configurada no .env."))).toBe("disabled");
  });

  it("desembrulha o erro que carrega uso e cai em other quando não reconhece", () => {
    const wrapped = new UsageCarryingError(new ExternalLlmError("x", 429), new UsageMeter().snapshot());
    expect(classifyError(wrapped)).toBe("http_429");
    expect(classifyError(new Error("algo inesperado com dados da reunião"))).toBe("other");
    expect(classifyError(null)).toBe("other");
    expect(classifyError("texto")).toBe("other");
  });

  it("todo código devolvido cabe no contrato (enum ou http_NNN) e nunca contém a mensagem", () => {
    const samples = [
      new ExternalLlmError("segredo da reunião", 500),
      new Error("segredo da reunião"),
      new HostJobError("segredo da reunião"),
    ];
    for (const err of samples) {
      const code = classifyError(err);
      expect(UsageErrorCode.safeParse(code).success).toBe(true);
      expect(code).not.toContain("segredo");
    }
  });
});

describe("UsageMeter", () => {
  it("soma as tentativas e mantém nulo o que o provedor nunca informou", () => {
    const meter = new UsageMeter("m");
    meter.add({ inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
    meter.add({ inputTokens: 5, outputTokens: undefined, costUsd: undefined, computeMs: undefined });
    expect(meter.snapshot()).toEqual({
      inputTokens: 15,
      outputTokens: 2,
      costUsd: 0.01,
      computeMs: null,
      attempts: 2,
      model: "m",
    });
  });

  it("ignora valores inválidos (negativo, NaN, texto) em vez de somar lixo", () => {
    const meter = new UsageMeter();
    meter.add({ inputTokens: -3, outputTokens: Number.NaN, costUsd: "0.5" });
    expect(meter.snapshot()).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, attempts: 1 });
  });
});
