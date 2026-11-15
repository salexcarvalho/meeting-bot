import type { UsagePurposeValue } from "@meeting-bot/contracts";
import type { z } from "zod";
import { OllamaProvider, OllamaSettings } from "./ollama";

export type LlmPriority = "live" | "post";

export interface GenerateRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  numCtx: number;
  label: string;
  /** finalidade declarada pelo chamador (registro de uso); nunca deduzida de texto */
  purpose: UsagePurposeValue;
  /** só para auditoria e registro de uso (nunca o conteúdo) */
  meetingId?: string;
}

/** Uso medido numa geração, somado entre as tentativas; nulo = o provedor não informou. */
export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** exatamente o custo informado pelo provedor; nunca calculado */
  costUsd: number | null;
  /** tempo de inferência local (Ollama); nulo quando não mensurável */
  computeMs: number | null;
  attempts: number;
  /** modelo efetivo, quando o provedor devolve */
  model: string | null;
}

export interface Generation<T> {
  data: T;
  usage: LlmUsage;
}

/** Falha que leva o uso parcial já gasto, para o funil registrar a linha de erro. */
export class UsageCarryingError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly usage: LlmUsage,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = causeError instanceof Error ? causeError.name : "UsageCarryingError";
  }
}

/** Soma de uso entre tentativas; um campo nulo em todas continua nulo. */
export class UsageMeter {
  private input: number | null = null;
  private output: number | null = null;
  private cost: number | null = null;
  private compute: number | null = null;
  private attempts = 0;
  private model: string | null = null;

  constructor(model: string | null = null) {
    this.model = model;
  }

  add(part: { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown; computeMs?: unknown; model?: unknown }): void {
    this.attempts++;
    this.input = sum(this.input, part.inputTokens);
    this.output = sum(this.output, part.outputTokens);
    this.cost = sum(this.cost, part.costUsd);
    this.compute = sum(this.compute, part.computeMs);
    if (typeof part.model === "string" && part.model) this.model = part.model;
  }

  snapshot(): LlmUsage {
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      costUsd: this.cost,
      computeMs: this.compute,
      attempts: Math.max(this.attempts, 1),
      model: this.model,
    };
  }

  /** Executa o corpo da geração; qualquer falha leva o uso parcial. */
  async run<T>(body: () => Promise<T>): Promise<Generation<T>> {
    try {
      return { data: await body(), usage: this.snapshot() };
    } catch (err) {
      throw err instanceof UsageCarryingError ? err : new UsageCarryingError(err, this.snapshot());
    }
  }
}

function sum(acc: number | null, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return acc;
  return (acc ?? 0) + value;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(req: GenerateRequest<T>): Promise<Generation<T>>;
  unload(): Promise<void>;
  health(): Promise<{ ok: boolean; model: string; error?: string }>;
}

// LLM_PROVIDER só aceita adaptadores que rodam na máquina; outro nome é recusado e auditado.
// O OpenRouter entra por outro caminho (llm/openrouter.ts), só com ALLOW_EXTERNAL_LLM=true e
// nunca no ao vivo (Constituição 1.3.0, princípio I).
const LOCAL_PROVIDERS = new Set(["ollama"]);

export class ProviderBlockedError extends Error {
  constructor(name: string) {
    super(`Provedor de LLM "${name}" bloqueado (LOCAL_ONLY): apenas modelos locais são permitidos.`);
    this.name = "ProviderBlockedError";
  }
}

export function createProvider(
  name: string,
  deps: { localOnly: boolean; onBlocked: (name: string) => void; ollama: OllamaSettings },
): LLMProvider {
  const normalized = name.toLowerCase();
  if (!LOCAL_PROVIDERS.has(normalized)) {
    deps.onBlocked(normalized);
    throw new ProviderBlockedError(normalized);
  }
  return new OllamaProvider(deps.ollama);
}

// A GPU comporta uma inferência de LLM por vez. O ao vivo passa na frente do pós-reunião.
export class LlmQueue {
  private running = false;
  private readonly waiting: Record<LlmPriority, (() => void)[]> = { live: [], post: [] };

  get pending(): number {
    return this.waiting.live.length + this.waiting.post.length;
  }

  get busy(): boolean {
    return this.running;
  }

  async run<T>(priority: LlmPriority, task: () => Promise<T>): Promise<T> {
    if (this.running) {
      await new Promise<void>((resolve) => this.waiting[priority].push(resolve));
    }
    this.running = true;
    try {
      return await task();
    } finally {
      const next = this.waiting.live.shift() ?? this.waiting.post.shift();
      if (next) next();
      else this.running = false;
    }
  }
}
