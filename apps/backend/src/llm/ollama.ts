import { z } from "zod";
import type { GenerateRequest, LLMProvider } from "./provider";

export interface OllamaSettings {
  url: string;
  model: string;
  keepAlive: string;
}

// Limites de tamanho viram repetições enormes na gramática do llama.cpp e deixam a
// geração lenta; a validação completa acontece depois, com zod.
const SIZE_KEYS = ["maxLength", "minLength", "maxItems"];

function strip(node: unknown, drop: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n, drop));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!drop.has(k)) out[k] = strip(v, drop);
    }
    return out;
  }
  return node;
}

/** JSON Schema do zod para o LLM. `limits` mantém os tamanhos máximos (só onde o modelo os respeita). */
export function toJsonSchema(schema: z.ZodType, opts: { limits?: boolean } = {}): unknown {
  const drop = new Set(opts.limits ? ["$schema"] : ["$schema", ...SIZE_KEYS]);
  return strip(z.toJSONSchema(schema, { target: "draft-07" }), drop);
}

export function toOllamaSchema(schema: z.ZodType): unknown {
  return toJsonSchema(schema);
}

interface ChatResponse {
  message?: { content?: string };
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 10 * 60_000;

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  constructor(private readonly settings: OllamaSettings) {}

  get model(): string {
    return this.settings.model;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const format = toOllamaSchema(req.schema);
    const messages: { role: string; content: string }[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const data = await this.chat({
        model: this.settings.model,
        stream: false,
        think: false,
        format,
        keep_alive: this.settings.keepAlive,
        options: { temperature: 0, num_ctx: req.numCtx },
        messages,
      });
      const content = data.message?.content ?? "";
      const tokS = data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : 0;
      console.log(
        `[llm] ${req.label}: ${data.eval_count ?? 0} tokens em ${((Date.now() - started) / 1000).toFixed(1)}s (${tokS.toFixed(1)} tok/s)`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        lastError = "JSON inválido";
        messages.push({ role: "assistant", content }, { role: "user", content: retryNote(lastError) });
        continue;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = z.prettifyError(result.error).slice(0, 800);
      messages.push({ role: "assistant", content }, { role: "user", content: retryNote(lastError) });
    }
    throw new Error(`Resposta do LLM inválida (${req.label}): ${lastError}`);
  }

  async unload(): Promise<void> {
    await fetch(`${this.settings.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.settings.model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => console.warn(`[llm] falha ao descarregar modelo: ${(err as Error).message}`));
  }

  async health(): Promise<{ ok: boolean; model: string; error?: string }> {
    try {
      const res = await fetch(`${this.settings.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, model: this.model, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      const found = (data.models ?? []).some((m) => m.name === this.model);
      return found
        ? { ok: true, model: this.model }
        : { ok: false, model: this.model, error: `modelo não baixado (docker compose exec ollama ollama pull ${this.model})` };
    } catch (err) {
      return { ok: false, model: this.model, error: (err as Error).message };
    }
  }

  private async chat(body: Record<string, unknown>): Promise<ChatResponse> {
    const res = await fetch(`${this.settings.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${data.error ?? "erro desconhecido"}`);
    return data;
  }
}

function retryNote(problem: string): string {
  return `A resposta anterior não seguiu o schema (${problem}). Responda de novo apenas com o JSON válido.`;
}
