import { SUBSCRIPTION_LLMS, type LlmChoice, type LlmOptions, type SubscriptionLlm } from "@meeting-bot/contracts";
import { config } from "../config";
import { hostAgentCli } from "../recording/hostAgentState";
import { hostAgentOwner } from "../recording/owner";
import { audit } from "../security/audit";
import { HostCliLlm } from "./hostCli";
import { hostJobs } from "./hostJobs";
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

const subscriptionLlms: Partial<Record<SubscriptionLlm, HostCliLlm>> = {};

export function isSubscription(choice: LlmChoice): choice is SubscriptionLlm {
  return (SUBSCRIPTION_LLMS as readonly string[]).includes(choice);
}

function subscriptionModel(choice: SubscriptionLlm): string {
  return config.subscriptionLlm[choice].model || "padrão";
}

function getSubscriptionLlm(choice: SubscriptionLlm): HostCliLlm {
  const settings = config.subscriptionLlm[choice];
  if (!config.externalLlm.allowed) throw new ExternalLlmDisabledError();
  if (!settings.enabled) throw new Error(`${choice} desabilitado no .env (${choice.toUpperCase()}_CLI_ENABLED=false).`);
  subscriptionLlms[choice] ??= new HostCliLlm(
    { provider: choice, model: settings.model, timeoutSeconds: config.subscriptionLlm.timeoutSeconds },
    hostJobs,
  );
  return subscriptionLlms[choice];
}

/**
 * Gera com o LLM local (fila única da GPU) ou, só em gerações pós-reunião/sob demanda, fora da
 * máquina: OpenRouter ou a assinatura do dono via host-agent (fora da fila: não usam a GPU).
 * O ao vivo é sempre local.
 */
export function generate<T>(priority: LlmPriority, req: GenerateRequest<T>, provider: LlmChoice = "local"): Promise<T> {
  if (provider !== "local") {
    if (priority === "live") return Promise.reject(new Error("A análise ao vivo é sempre local."));
    try {
      const llm = provider === "openrouter" ? getExternalLlm() : getSubscriptionLlm(provider);
      return llm.generate(req);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return llmQueue.run(priority, () => getLlm().generate(req));
}

/** Rótulo gravado em itens, ADRs e análises: "<provedor>:<modelo>". */
export function generationLabel(provider: LlmChoice): string {
  if (provider === "openrouter") return `openrouter:${config.externalLlm.model}`;
  if (isSubscription(provider)) return `${provider}:${subscriptionModel(provider)}`;
  return `local:${config.ollamaModel}`;
}

/**
 * Por que a assinatura não pode gerar para uma reunião deste dono agora (null = pode).
 * A assinatura é pessoal: só vale para as reuniões do dono do host-agent.
 */
export async function subscriptionUnavailable(choice: SubscriptionLlm, meetingOwnerId: string | null): Promise<string | null> {
  if (!config.externalLlm.allowed || !config.subscriptionLlm[choice].enabled) {
    return `${choice} desabilitado no .env.`;
  }
  const owner = await hostAgentOwner();
  if (!owner || owner.id !== meetingOwnerId) {
    return "A assinatura é pessoal do dono do host-agent: vale só para as reuniões dele.";
  }
  const status = hostAgentCli(choice);
  if (!status) return "O host-agent está desligado nesta máquina.";
  if (!status.available) return status.reason ?? "CLI indisponível no host-agent.";
  return null;
}

/** Opções para a interface; `ownerId` = dono da reunião (ou quem pergunta, na sessão). */
export async function llmOptions(ownerId: string | null): Promise<LlmOptions> {
  const ext = config.externalLlm;
  const subscriptions = [];
  for (const id of SUBSCRIPTION_LLMS) {
    if (!ext.allowed || !config.subscriptionLlm[id].enabled) continue;
    const reason = await subscriptionUnavailable(id, ownerId);
    subscriptions.push({ id, model: subscriptionModel(id), available: reason === null, reason });
  }
  return {
    default: config.generationProvider,
    local: { model: config.ollamaModel },
    external: ext.allowed ? { model: ext.model, available: Boolean(ext.apiKey) } : null,
    subscriptions,
  };
}

/** Escolha vinda da interface: vazio = padrão do .env; o externo exige a flag e a configuração. */
export function parseLlmChoice(value: unknown): { ok: true; value: LlmChoice } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "" || value === "default") {
    return { ok: true, value: config.generationProvider };
  }
  if (value === "local") return { ok: true, value: "local" };
  if (value === "openrouter" || value === "claude" || value === "codex") {
    const ext = config.externalLlm;
    if (!ext.allowed) return { ok: false, error: "LLM externo desabilitado (ALLOW_EXTERNAL_LLM=false)." };
    if (value === "openrouter") {
      if (!ext.apiKey) return { ok: false, error: "Configure OPENROUTER_API_KEY no .env para gerar com o OpenRouter." };
      return { ok: true, value };
    }
    if (!config.subscriptionLlm[value].enabled) {
      return { ok: false, error: `Assinatura ${value} desabilitada (${value.toUpperCase()}_CLI_ENABLED=false).` };
    }
    return { ok: true, value };
  }
  return { ok: false, error: "Opção de modelo inválida." };
}

/**
 * Provedor da geração automática (sem escolha na interface). Se o padrão é uma assinatura que não
 * serve para esta reunião (host-agent desligado, reunião de outra pessoa), gera no modelo local:
 * nunca manda para fora sem a condição atendida.
 */
export async function automaticProvider(meetingOwnerId: string | null): Promise<{ provider: LlmChoice; note: string | null }> {
  const preferred = config.generationProvider;
  if (!isSubscription(preferred)) return { provider: preferred, note: null };
  const reason = await subscriptionUnavailable(preferred, meetingOwnerId);
  if (!reason) return { provider: preferred, note: null };
  return { provider: "local", note: `gerado no modelo local (${preferred} indisponível: ${reason})` };
}

// Libera a VRAM antes de cargas pesadas (diarização). Entra na fila para não
// descarregar no meio de uma inferência.
export function unloadLlm(): Promise<void> {
  return llmQueue.run("post", () => getLlm().unload());
}
