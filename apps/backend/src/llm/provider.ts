import type { z } from "zod";

export type LlmPriority = "live" | "post";

export interface GenerateRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  numCtx: number;
  label: string;
  /** só para auditoria de chamadas externas (nunca o conteúdo) */
  meetingId?: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(req: GenerateRequest<T>): Promise<T>;
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
