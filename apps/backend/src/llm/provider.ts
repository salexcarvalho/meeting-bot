import type { UsagePurposeValue } from "@meeting-bot/contracts";
import type { z } from "zod";

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
  /** usuário de quem partiu a chamada, quando não há reunião de origem (ex.: chat sobre várias reuniões) */
  userId?: string;
}

/** Uso medido numa geração, somado entre as tentativas; nulo = o provedor não informou. */
export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** exatamente o custo informado pelo provedor; nunca calculado */
  costUsd: number | null;
  /** tempo de inferência local; nulo quando não mensurável (sem LLM local, sempre nulo) */
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
}

// O host-agent roda uma CLI de assinatura por vez e cada pedido expira se ele não o pegar em
// poucos segundos (hostJobs): sem esta fila, um pedido ao vivo esperaria atrás de uma geração
// longa e falharia. O ao vivo passa na frente do pós-reunião. O OpenRouter não passa por ela.
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
