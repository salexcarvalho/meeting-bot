import type { SearchSemanticReason, UsageErrorCodeValue } from "@meeting-bot/contracts";
import { config } from "../config";
import type { SearchConfig } from "./config";

// Cliente do Ollama para embeddings (specs/003-busca-chat/contracts/embeddings.md).
// Sempre em CPU (`num_gpu: 0`, 0 MiB de VRAM) e só no host do Ollama configurado.

export class EmbedError extends Error {
  constructor(
    message: string,
    readonly usageCode: UsageErrorCodeValue,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

export class EmbedUnavailableError extends EmbedError {
  constructor(message = "Ollama indisponível para embeddings.") {
    super(message, "unavailable");
    this.name = "EmbedUnavailableError";
  }
}

export class EmbedModelMissingError extends EmbedError {
  constructor(model: string) {
    super(`Modelo de embedding não baixado (docker compose exec ollama ollama pull ${model}).`, "unavailable");
    this.name = "EmbedModelMissingError";
  }
}

export class EmbedDimensionError extends EmbedError {
  constructor(message: string) {
    super(message, "schema_invalid");
    this.name = "EmbedDimensionError";
  }
}

export interface EmbedResult {
  vectors: number[][];
  /** tokens de entrada informados pelo Ollama; nulo quando não vieram */
  inputTokens: number | null;
  computeMs: number | null;
}

export interface EmbedHealth {
  available: boolean;
  reason: SearchSemanticReason | null;
}

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** trechos para indexar (em lotes de até `EMBED_BATCH`) */
  embedDocuments(texts: string[]): Promise<EmbedResult>;
  /** uma busca ou pergunta */
  embedQuery(text: string): Promise<EmbedResult>;
  health(): Promise<EmbedHealth>;
}

const BATCH_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 8_000;
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000];

/** Opções constantes em toda chamada: o Ollama não recarrega o runner e a GPU nunca é usada. */
export const EMBED_OPTIONS = { num_gpu: 0 } as const;

export function l2normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new EmbedDimensionError("Vetor de embedding nulo ou não finito.");
  return Math.abs(norm - 1) < 1e-4 ? vector : vector.map((x) => x / norm);
}

/** Valida a dimensão e os valores e devolve o vetor normalizado (norma 1). */
export function checkVector(value: unknown, dim: number): number[] {
  if (!Array.isArray(value) || value.length !== dim) {
    throw new EmbedDimensionError(`Embedding com dimensão ${Array.isArray(value) ? value.length : "inválida"}; esperado ${dim} (EMBED_DIM).`);
  }
  if (!value.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new EmbedDimensionError("Embedding com valores não numéricos ou não finitos.");
  }
  return l2normalize(value as number[]);
}

interface EmbedResponse {
  embeddings?: unknown;
  prompt_eval_count?: number;
  total_duration?: number;
  error?: string;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OllamaEmbedder implements Embedder {
  private healthCache: { at: number; value: EmbedHealth } | null = null;

  constructor(
    private readonly settings: Pick<SearchConfig, "embedModel" | "embedDim" | "embedKeepAlive" | "embedBatch" | "embedDocPrefix" | "embedQueryPrefix">,
    private readonly url: string,
    private readonly sleep: Sleep = realSleep,
  ) {}

  get model(): string {
    return this.settings.embedModel;
  }

  get dim(): number {
    return this.settings.embedDim;
  }

  async embedDocuments(texts: string[]): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let tokens: number | null = null;
    let compute: number | null = null;
    for (let i = 0; i < texts.length; i += this.settings.embedBatch) {
      const batch = texts.slice(i, i + this.settings.embedBatch).map((t) => this.settings.embedDocPrefix + t);
      const part = await this.request(batch, BATCH_TIMEOUT_MS);
      vectors.push(...part.vectors);
      tokens = addNullable(tokens, part.inputTokens);
      compute = addNullable(compute, part.computeMs);
    }
    return { vectors, inputTokens: tokens, computeMs: compute };
  }

  embedQuery(text: string): Promise<EmbedResult> {
    return this.request([this.settings.embedQueryPrefix + text], QUERY_TIMEOUT_MS);
  }

  private async request(input: string[], timeoutMs: number): Promise<EmbedResult> {
    let last: unknown = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 0);
      try {
        return await this.once(input, timeoutMs);
      } catch (err) {
        // erros de dados (dimensão, modelo ausente) não melhoram repetindo
        if (err instanceof EmbedDimensionError || err instanceof EmbedModelMissingError) throw err;
        last = err;
      }
    }
    throw last instanceof EmbedError ? last : new EmbedUnavailableError();
  }

  private async once(input: string[], timeoutMs: number): Promise<EmbedResult> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.settings.embedModel,
          input,
          truncate: true,
          keep_alive: this.settings.embedKeepAlive,
          options: EMBED_OPTIONS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error).name === "TimeoutError";
      throw timeout ? new EmbedError("Ollama não respondeu a tempo (embeddings).", "timeout") : new EmbedUnavailableError();
    }
    const data = (await res.json().catch(() => ({}))) as EmbedResponse;
    if (res.status === 404) throw new EmbedModelMissingError(this.settings.embedModel);
    if (!res.ok) throw new EmbedError(`Ollama respondeu ${res.status} nos embeddings.`, `http_${res.status}`);
    return this.parse(data, input.length);
  }

  private parse(data: EmbedResponse, expected: number): EmbedResult {
    const list = data.embeddings;
    if (!Array.isArray(list) || list.length !== expected) {
      throw new EmbedDimensionError(`Ollama devolveu ${Array.isArray(list) ? list.length : 0} embeddings para ${expected} textos.`);
    }
    return {
      vectors: list.map((v) => checkVector(v, this.settings.embedDim)),
      inputTokens: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
      computeMs: typeof data.total_duration === "number" ? Math.round(data.total_duration / 1e6) : null,
    };
  }

  /** Modelo baixado? Resultado guardado por 30 s. */
  async health(): Promise<EmbedHealth> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < HEALTH_TTL_MS) return this.healthCache.value;
    const value = await this.probe();
    this.healthCache = { at: now, value };
    return value;
  }

  private async probe(): Promise<EmbedHealth> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) return { available: false, reason: "ollama_indisponivel" };
      const data = (await res.json()) as { models?: { name: string }[] };
      const wanted = this.settings.embedModel;
      const found = (data.models ?? []).some((m) => m.name === wanted || m.name === `${wanted}:latest`);
      return found ? { available: true, reason: null } : { available: false, reason: "modelo_ausente" };
    } catch {
      return { available: false, reason: "ollama_indisponivel" };
    }
  }
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : a + b;
}

/** Texto de um vetor para o SQL (`$n::vector`): só números formatados, nunca texto do usuário. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.map((x) => (Number.isFinite(x) ? x.toString() : "0")).join(",")}]`;
}

let current: Embedder | null = null;

export function getEmbedder(): Embedder {
  current ??= new OllamaEmbedder(config.search, config.ollamaUrl);
  return current;
}

/** Só para testes: troca o embedder (Ollama simulado, sem rede). */
export function setEmbedder(embedder: Embedder | null): void {
  current = embedder;
}
