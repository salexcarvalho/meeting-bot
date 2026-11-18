import {
  SUBSCRIPTION_LLMS,
  type LlmChoice,
  type LlmOptions,
  type SubscriptionLlm,
  type UsageProviderValue,
} from "@meeting-bot/contracts";
import { config } from "../config";
import { hostAgentCli } from "../recording/hostAgentState";
import { hostAgentOwner } from "../recording/owner";
import { classifyError } from "../usage/errorCode";
import { recordUsage } from "../usage/recorder";
import { HostCliLlm } from "./hostCli";
import { hostJobs } from "./hostJobs";
import { OpenRouterLlm } from "./openrouter";
import { UsageCarryingError, type Generation, type GenerateRequest, type LlmPriority, type LlmUsage, LlmQueue } from "./provider";

// Só as assinaturas (host-agent) passam pela fila; o OpenRouter atende em paralelo.
export const llmQueue = new LlmQueue();

let external: OpenRouterLlm | null = null;

function getExternalLlm(): OpenRouterLlm {
  if (!config.externalLlm.allowed) throw new ExternalLlmDisabledError();
  external ??= new OpenRouterLlm(config.externalLlm);
  return external;
}

export const EXTERNAL_LLM_DISABLED = "LLM externo desabilitado: ative ALLOW_EXTERNAL_LLM=true no .env.";

export class ExternalLlmDisabledError extends Error {
  constructor() {
    super(EXTERNAL_LLM_DISABLED);
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

function usageIdentity(choice: LlmChoice): { provider: UsageProviderValue; model: string } {
  if (isSubscription(choice)) return { provider: choice, model: subscriptionModel(choice) };
  return { provider: "openrouter", model: config.externalLlm.model };
}

const EMPTY_USAGE: LlmUsage = { inputTokens: null, outputTokens: null, costUsd: null, computeMs: null, attempts: 1, model: null };

type Outcome<T> = { ok: true; generation: Generation<T>; ms: number } | { ok: false; error: unknown; usage: LlmUsage; ms: number };

/** Mede só a chamada ao provedor (sem a espera na fila da GPU). */
async function timedCall<T>(call: () => Promise<Generation<T>>): Promise<Outcome<T>> {
  const started = Date.now();
  try {
    return { ok: true, generation: await call(), ms: Date.now() - started };
  } catch (err) {
    const usage = err instanceof UsageCarryingError ? err.usage : EMPTY_USAGE;
    return { ok: false, error: err instanceof UsageCarryingError ? err.causeError : err, usage, ms: Date.now() - started };
  }
}

/** Uma linha por chamada concluída (sucesso ou erro); nunca lança. */
function recordGeneration<T>(req: GenerateRequest<T>, choice: LlmChoice, outcome: Outcome<T>): void {
  const identity = usageIdentity(choice);
  const usage = outcome.ok ? outcome.generation.usage : outcome.usage;
  recordUsage({
    category: "llm",
    purpose: req.purpose,
    provider: identity.provider,
    model: usage.model ?? identity.model,
    meetingId: req.meetingId ?? null,
    userId: req.meetingId ? null : (req.userId ?? null),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    audioSeconds: null,
    costUsd: usage.costUsd,
    durationMs: outcome.ms,
    computeMs: usage.computeMs,
    attempts: usage.attempts,
    success: outcome.ok,
    errorCode: outcome.ok ? null : classifyError(outcome.error),
    label: req.label,
  });
}

function invokeExternal<T>(req: GenerateRequest<T>, provider: LlmChoice): Promise<Generation<T>> {
  const llm = provider === "openrouter" ? getExternalLlm() : getSubscriptionLlm(provider);
  return llm.generate(req);
}

/**
 * Gera com o OpenRouter ou com a assinatura do dono via host-agent. Não há modelo local: sem
 * ALLOW_EXTERNAL_LLM=true a geração (ao vivo, pós-reunião ou chat) é recusada com erro claro.
 * Só as assinaturas passam pela fila (um CLI por vez no host-agent). Cada chamada concluída vira
 * uma linha de uso (specs/004-uso-custo).
 */
export async function generate<T>(priority: LlmPriority, req: GenerateRequest<T>, provider: LlmChoice): Promise<T> {
  const call = () => timedCall(() => invokeExternal(req, provider));
  const outcome = isSubscription(provider) ? await llmQueue.run(priority, call) : await call();
  try {
    recordGeneration(req, provider, outcome);
  } catch (err) {
    // o registro de uso nunca pode mudar o resultado da geração (FR-006)
    console.error("[uso] falha ao registrar a geração:", err);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.generation.data;
}

/** Rótulo gravado em itens, ADRs e análises: "<provedor>:<modelo>". */
export function generationLabel(provider: LlmChoice): string {
  if (provider === "openrouter") return `openrouter:${config.externalLlm.model}`;
  return `${provider}:${subscriptionModel(provider)}`;
}

export interface SubscriptionBlock {
  reason: string;
  /** passa sozinho (host-agent reiniciando, CLI se preparando): vale esperar */
  transient: boolean;
}

/**
 * Por que a assinatura não pode gerar para uma reunião deste dono agora (null = pode).
 * A assinatura é pessoal: só vale para as reuniões do dono do host-agent.
 */
export async function subscriptionBlock(choice: SubscriptionLlm, meetingOwnerId: string | null): Promise<SubscriptionBlock | null> {
  if (!config.externalLlm.allowed || !config.subscriptionLlm[choice].enabled) {
    return { reason: `${choice} desabilitado no .env.`, transient: false };
  }
  const owner = await hostAgentOwner();
  if (!owner || owner.id !== meetingOwnerId) {
    return { reason: "A assinatura é pessoal do dono do host-agent: vale só para as reuniões dele.", transient: false };
  }
  const status = hostAgentCli(choice);
  if (!status) return { reason: "O host-agent está desligado nesta máquina.", transient: true };
  if (!status.available) return { reason: status.reason ?? "CLI indisponível no host-agent.", transient: true };
  return null;
}

export async function subscriptionUnavailable(choice: SubscriptionLlm, meetingOwnerId: string | null): Promise<string | null> {
  return (await subscriptionBlock(choice, meetingOwnerId))?.reason ?? null;
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
    external: ext.allowed ? { model: ext.model, available: Boolean(ext.apiKey) } : null,
    subscriptions,
  };
}

/** Escolha vinda da interface: vazio = padrão do .env; o externo exige a flag e a configuração. */
export function parseLlmChoice(value: unknown): { ok: true; value: LlmChoice } | { ok: false; error: string } {
  const empty = value === undefined || value === null || value === "" || value === "default";
  const choice = empty ? config.generationProvider : value;
  if (choice !== "openrouter" && choice !== "claude" && choice !== "codex") {
    return { ok: false, error: "Opção de modelo inválida." };
  }
  const ext = config.externalLlm;
  if (!ext.allowed) return { ok: false, error: EXTERNAL_LLM_DISABLED };
  if (choice === "openrouter") {
    if (!ext.apiKey) return { ok: false, error: "Configure OPENROUTER_API_KEY no .env para gerar com o OpenRouter." };
    return { ok: true, value: choice };
  }
  if (!config.subscriptionLlm[choice].enabled) {
    return { ok: false, error: `Assinatura ${choice} desabilitada (${choice.toUpperCase()}_CLI_ENABLED=false).` };
  }
  return { ok: true, value: choice };
}

/** Estado do LLM padrão (LLM_GENERATION_PROVIDER), para o log de subida e o status do sistema. */
export function llmSummary(): { ok: boolean; model: string; error: string | null } {
  const choice = parseLlmChoice("default");
  return { ok: choice.ok, model: generationLabel(config.generationProvider), error: choice.ok ? null : choice.error };
}

/** Por que este provedor não gera para uma reunião deste dono agora (null = pode). */
export async function generationBlock(choice: LlmChoice, meetingOwnerId: string | null): Promise<string | null> {
  if (!config.externalLlm.allowed) return EXTERNAL_LLM_DISABLED;
  if (choice === "openrouter") return config.externalLlm.apiKey ? null : "OPENROUTER_API_KEY não configurada no .env.";
  return (await subscriptionBlock(choice, meetingOwnerId))?.reason ?? null;
}

export class LlmUnavailableError extends Error {}

export interface AutomaticProviderOptions {
  /** quanto esperar a assinatura voltar (host-agent reiniciando); 0 = não espera */
  waitMs?: number;
  pollMs?: number;
  /** chamado uma vez, quando a espera começa */
  onWait?: (reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Provedor da geração automática (sem escolha na interface): LLM_GENERATION_PROVIDER.
 * Não há modelo local para cair de volta, então quando o provedor não serve a geração falha com
 * erro claro (a transcrição já está salva):
 * - LLM externo desabilitado (ALLOW_EXTERNAL_LLM=false): falha na hora;
 * - assinatura indisponível por um tempo (host-agent reiniciando, CLI se preparando): espera e,
 *   se não voltar, falha;
 * - assinatura que não serve para esta reunião (reunião de outra pessoa, CLI desligado no .env):
 *   falha, porque a assinatura é pessoal.
 */
export async function automaticProvider(meetingOwnerId: string | null, opts: AutomaticProviderOptions = {}): Promise<LlmChoice> {
  const preferred = config.generationProvider;
  if (!config.externalLlm.allowed) throw new LlmUnavailableError(`${EXTERNAL_LLM_DISABLED} A transcrição está salva.`);
  if (!isSubscription(preferred)) return preferred;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.waitMs ?? 0);
  let block = await subscriptionBlock(preferred, meetingOwnerId);
  if (block?.transient && now() < deadline) opts.onWait?.(block.reason);
  while (block?.transient && now() < deadline) {
    await sleep(opts.pollMs ?? 5000);
    block = await subscriptionBlock(preferred, meetingOwnerId);
  }
  if (!block) return preferred;
  const minutes = Math.round((opts.waitMs ?? 0) / 60_000);
  const since = block.transient && minutes ? ` há ${minutes} min` : "";
  const next = block.transient ? 'use "Gerar ata" quando ele voltar' : 'use "Gerar ata" e escolha outro modelo';
  throw new LlmUnavailableError(`${preferred} indisponível${since} (${block.reason}). A transcrição está salva: ${next}.`);
}
