import { z } from "zod";
import { audit } from "../security/audit";
import { toOllamaSchema } from "./ollama";
import type { GenerateRequest, LLMProvider } from "./provider";

// LLM externo opcional via OpenRouter /chat/completions (Constituição 1.3.0, princípio I).
// Saída estruturada por JSON Schema estrito, validada de novo com zod; auditoria só com metadados.

export interface OpenRouterLlmSettings {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export class ExternalLlmError extends Error {}

const RETRY_DELAYS_MS = [3_000, 10_000];
const FATAL_STATUS = new Set([400, 401, 402, 403, 404, 413]);

interface ChatCompletion {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
  error?: { message?: string; code?: number | string } | string;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorText(data: ChatCompletion, status: number): string {
  const message = typeof data.error === "string" ? data.error : (data.error?.message ?? `HTTP ${status}`);
  return `${status}: ${message}`.slice(0, 300);
}

function retryNote(problem: string): string {
  return `A resposta anterior não seguiu o schema (${problem}). Responda de novo apenas com o JSON válido.`;
}

export class OpenRouterLlm implements LLMProvider {
  readonly name = "openrouter";

  constructor(
    private readonly settings: OpenRouterLlmSettings,
    private readonly sleep: Sleep = realSleep,
  ) {}

  get model(): string {
    return this.settings.model;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (!this.settings.apiKey) throw new ExternalLlmError("OPENROUTER_API_KEY não configurada no .env.");
    const schema = toOllamaSchema(req.schema);
    const messages: { role: string; content: string }[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const data = await this.post({
        model: this.settings.model,
        messages,
        max_tokens: this.settings.maxTokens,
        response_format: { type: "json_schema", json_schema: { name: "resposta", strict: true, schema } },
        // Só provedores que respeitam o schema. Sem `temperature`: com require_parameters, um modelo
        // que não a aceita (ex.: anthropic/claude-sonnet-5) ficaria sem nenhum provedor (404).
        provider: { require_parameters: true },
      });
      const usage = data.usage ?? {};
      audit("external_llm", {
        meetingId: req.meetingId ?? null,
        label: req.label,
        model: data.model ?? this.settings.model,
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        cost: usage.cost ?? null,
        durationMs: Date.now() - started,
      });
      console.log(
        `[llm-externo] ${req.label}: ${usage.prompt_tokens ?? "?"}+${usage.completion_tokens ?? "?"} tokens em ${((Date.now() - started) / 1000).toFixed(1)}s` +
          (usage.cost !== undefined ? `, US$ ${usage.cost}` : ""),
      );
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";
      if (choice?.message?.refusal) throw new ExternalLlmError(`O modelo recusou a tarefa: ${choice.message.refusal.slice(0, 200)}`);
      if (choice?.finish_reason === "length") {
        lastError = "resposta cortada pelo limite de tokens (OPENROUTER_LLM_MAX_TOKENS)";
        break;
      }
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
    // nada a liberar: roda fora da máquina
  }

  async health(): Promise<{ ok: boolean; model: string; error?: string }> {
    return this.settings.apiKey
      ? { ok: true, model: this.model }
      : { ok: false, model: this.model, error: "OPENROUTER_API_KEY não configurada" };
  }

  private async post(body: Record<string, unknown>): Promise<ChatCompletion> {
    let lastError = "";
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.settings.url}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.settings.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.settings.timeoutMs),
        });
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt < RETRY_DELAYS_MS.length) {
          await this.sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        break;
      }
      const text = await res.text();
      let data: ChatCompletion = {};
      try {
        data = text ? (JSON.parse(text) as ChatCompletion) : {};
      } catch {
        data = { error: text.slice(0, 200) };
      }
      // O OpenRouter pode responder 200 com erro do provedor no corpo.
      if (res.ok && !data.error) return data;
      lastError = errorText(data, res.status);
      if (FATAL_STATUS.has(res.status)) break;
      if (attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
    }
    throw new ExternalLlmError(`OpenRouter recusou a geração (${lastError})`);
  }
}
