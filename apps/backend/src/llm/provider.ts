import type { z } from "zod";
import { OllamaProvider, OllamaSettings } from "./ollama";

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
