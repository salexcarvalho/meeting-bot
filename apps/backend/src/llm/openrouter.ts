import { z } from "zod";
import { audit } from "../security/audit";
import { classifyError } from "../usage/errorCode";
import { ownerOfMeeting } from "../usage/recorder";
import { toJsonSchema } from "./schema";
import { UsageMeter, type Generation, type GenerateRequest, type LLMProvider } from "./provider";

// LLM externo opcional via OpenRouter /chat/completions (Constituição 1.3.0, princípio I).
// Saída estruturada por JSON Schema estrito, validada de novo com zod; auditoria só com metadados.

export interface OpenRouterLlmSettings {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export class ExternalLlmError extends Error {
  /** status HTTP da recusa, quando houve resposta; alimenta o código de erro do registro de uso */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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

/** Valida o texto devolvido contra o schema (JSON inválido e schema violado viram o motivo da nova tentativa). */
function checkContent<T>(schema: z.ZodType<T>, content: string): { ok: true; data: T } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, problem: "JSON inválido" };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { ok: true, data: result.data } : { ok: false, problem: z.prettifyError(result.error).slice(0, 800) };
}

type AttemptResult =
  | { ok: true; data: ChatCompletion }
  | { ok: false; error: string; status?: number; timedOut: boolean; fatal: boolean };

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

  async generate<T>(req: GenerateRequest<T>): Promise<Generation<T>> {
    const meter = new UsageMeter(this.settings.model);
    return meter.run(() => this.attempts(req, meter));
  }

  /** Rastro de saída (princípio I): só metadados, com o dono da reunião; nunca o conteúdo. */
  private async auditSent<T>(req: GenerateRequest<T>, detail: Record<string, unknown>): Promise<void> {
    const owner = req.meetingId ? await ownerOfMeeting(req.meetingId).catch(() => null) : null;
    audit(
      "external_llm",
      { meetingId: req.meetingId ?? null, label: req.label, provider: "openrouter", purpose: req.purpose, ...detail },
      owner,
    );
  }

  private async attempts<T>(req: GenerateRequest<T>, meter: UsageMeter): Promise<T> {
    if (!this.settings.apiKey) throw new ExternalLlmError("OPENROUTER_API_KEY não configurada no .env.");
    const schema = toJsonSchema(req.schema);
    const messages: { role: string; content: string }[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const data = await this.send(req, meter, started, {
        model: this.settings.model,
        messages,
        max_tokens: this.settings.maxTokens,
        response_format: { type: "json_schema", json_schema: { name: "resposta", strict: true, schema } },
        // Só provedores que respeitam o schema. Sem `temperature`: com require_parameters, um modelo
        // que não a aceita (ex.: anthropic/claude-sonnet-5) ficaria sem nenhum provedor (404).
        provider: { require_parameters: true },
      });
      const usage = data.usage ?? {};
      console.log(
        `[llm-externo] ${req.label}: ${usage.prompt_tokens ?? "?"}+${usage.completion_tokens ?? "?"} tokens em ${((Date.now() - started) / 1000).toFixed(1)}s` +
          (usage.cost !== undefined ? `, US$ ${usage.cost}` : ""),
      );
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new ExternalLlmError(`O modelo recusou a tarefa: ${choice.message.refusal.slice(0, 200)}`);
      if (choice?.finish_reason === "length") {
        lastError = "resposta cortada pelo limite de tokens (OPENROUTER_LLM_MAX_TOKENS)";
        break;
      }
      const content = choice?.message?.content ?? "";
      const checked = checkContent(req.schema, content);
      if (checked.ok) return checked.data;
      lastError = checked.problem;
      messages.push({ role: "assistant", content }, { role: "user", content: retryNote(lastError) });
    }
    throw new Error(`Resposta do LLM inválida (${req.label}): ${lastError}`);
  }

  /** Uma ida ao provedor: soma o uso e audita a saída (com sucesso ou com o código da recusa). */
  private async send<T>(
    req: GenerateRequest<T>,
    meter: UsageMeter,
    started: number,
    body: Record<string, unknown>,
  ): Promise<ChatCompletion> {
    let data: ChatCompletion;
    try {
      data = await this.post(body);
    } catch (err) {
      await this.auditSent(req, { model: this.settings.model, success: false, errorCode: classifyError(err), durationMs: Date.now() - started });
      throw err;
    }
    const usage = data.usage ?? {};
    meter.add({ inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, costUsd: usage.cost, model: data.model });
    await this.auditSent(req, {
      model: data.model ?? this.settings.model,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      cost: usage.cost ?? null,
      durationMs: Date.now() - started,
      success: true,
    });
    return data;
  }

  /** Uma ida ao OpenRouter: devolve a resposta ou o motivo da falha (com status HTTP e se foi timeout). */
  private async attemptOnce(body: Record<string, unknown>): Promise<AttemptResult> {
    let res: Response;
    try {
      res = await fetch(`${this.settings.url}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (err) {
      const error = err as Error;
      return { ok: false, error: error.message, timedOut: error.name === "TimeoutError", fatal: false };
    }
    const text = await res.text();
    let data: ChatCompletion = {};
    try {
      data = text ? (JSON.parse(text) as ChatCompletion) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    // O OpenRouter pode responder 200 com erro do provedor no corpo.
    if (res.ok && !data.error) return { ok: true, data };
    return { ok: false, error: errorText(data, res.status), status: res.status, timedOut: false, fatal: FATAL_STATUS.has(res.status) };
  }

  private async post(body: Record<string, unknown>): Promise<ChatCompletion> {
    let last: Extract<AttemptResult, { ok: false }> = { ok: false, error: "", timedOut: false, fatal: false };
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const result = await this.attemptOnce(body);
      if (result.ok) return result.data;
      last = result;
      if (result.fatal || attempt >= RETRY_DELAYS_MS.length) break;
      await this.sleep(RETRY_DELAYS_MS[attempt]);
    }
    const failure = new ExternalLlmError(`OpenRouter recusou a geração (${last.error})`, last.status);
    if (last.timedOut) failure.name = "TimeoutError";
    throw failure;
  }
}
