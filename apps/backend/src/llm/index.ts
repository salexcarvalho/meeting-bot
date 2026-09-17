import type { LlmChoice, LlmOptions } from "@meeting-bot/contracts";
import { config } from "../config";
import { audit } from "../security/audit";
import { OpenRouterLlm } from "./openrouter";
import { createProvider, GenerateRequest, LLMProvider, LlmPriority, LlmQueue } from "./provider";

export const llmQueue = new LlmQueue();
let provider: LLMProvider | null = null;

export function getLlm(): LLMProvider {
  provider ??= createProvider(config.llmProvider, {
    localOnly: config.localOnly,
    onBlocked: (name) => audit("llm_provider_blocked", { provider: name }),
    ollama: { url: config.ollamaUrl, model: config.ollamaModel, keepAlive: config.ollamaKeepAlive },
  });
  return provider;
}

let external: OpenRouterLlm | null = null;

function getExternalLlm(): OpenRouterLlm {
  if (!config.externalLlm.allowed) throw new ExternalLlmDisabledError();
  external ??= new OpenRouterLlm(config.externalLlm);
  return external;
}

export class ExternalLlmDisabledError extends Error {
  constructor() {
    super("LLM externo desabilitado (ALLOW_EXTERNAL_LLM=false).");
  }
}

/**
 * Gera com o LLM local (fila única da GPU) ou, só em gerações pós-reunião/sob demanda, com o
 * OpenRouter (fora da fila: não usa a GPU). O ao vivo é sempre local.
 */
export function generate<T>(priority: LlmPriority, req: GenerateRequest<T>, provider: LlmChoice = "local"): Promise<T> {
  if (provider === "openrouter") {
    if (priority === "live") return Promise.reject(new Error("A análise ao vivo é sempre local."));
    try {
      return getExternalLlm().generate(req);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return llmQueue.run(priority, () => getLlm().generate(req));
}

/** Rótulo gravado em itens, ADRs e análises: "local:<modelo>" ou "openrouter:<modelo>". */
export function generationLabel(provider: LlmChoice): string {
  return provider === "openrouter" ? `openrouter:${config.externalLlm.model}` : `local:${config.ollamaModel}`;
}

export function llmOptions(): LlmOptions {
  const ext = config.externalLlm;
  return {
    default: config.generationProvider,
    local: { model: config.ollamaModel },
    external: ext.allowed ? { model: ext.model, available: Boolean(ext.apiKey) } : null,
  };
}

/** Escolha vinda da interface: vazio = padrão do .env; o externo exige a flag e a chave. */
export function parseLlmChoice(value: unknown): { ok: true; value: LlmChoice } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "" || value === "default") {
    return { ok: true, value: config.generationProvider };
  }
  if (value === "local") return { ok: true, value: "local" };
  if (value === "openrouter") {
    const ext = config.externalLlm;
    if (!ext.allowed) return { ok: false, error: "LLM externo desabilitado (ALLOW_EXTERNAL_LLM=false)." };
    if (!ext.apiKey) return { ok: false, error: "Configure OPENROUTER_API_KEY no .env para gerar com o OpenRouter." };
    return { ok: true, value: "openrouter" };
  }
  return { ok: false, error: "Opção de modelo inválida." };
}

// Libera a VRAM antes de cargas pesadas (diarização). Entra na fila para não
// descarregar no meio de uma inferência.
export function unloadLlm(): Promise<void> {
  return llmQueue.run("post", () => getLlm().unload());
}
