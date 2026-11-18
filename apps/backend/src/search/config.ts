// Configuração da busca e do chat (specs/003-busca-chat/contracts/embeddings.md).
// Lê só do ambiente; não importa ../config para poder ser usado por ele sem ciclo.

export type SemanticMode = "auto" | "off" | "on";

export interface SearchConfig {
  enabled: boolean;
  semantic: SemanticMode;
  embedModel: string;
  embedDim: number;
  embedKeepAlive: string;
  embedBatch: number;
  embedDocPrefix: string;
  embedQueryPrefix: string;
  indexDebounceSeconds: number;
  chatMinSimilarity: number;
  /** orçamento de tokens de contexto do chat: com num_ctx 8192 e com 4096 (reunião ao vivo) */
  chatContextTokens: number;
  chatContextTokensLive: number;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "sim"].includes(raw);
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) throw new Error(`${name} precisa ser inteiro entre ${min} e ${max}`);
  return n;
}

function ratio(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} precisa ser número entre 0 e 1`);
  return n;
}

function semanticMode(env: NodeJS.ProcessEnv): SemanticMode {
  const raw = (env.SEARCH_SEMANTIC || "auto").trim().toLowerCase();
  if (raw === "auto" || raw === "off" || raw === "on") return raw;
  throw new Error(`SEARCH_SEMANTIC inválido: ${raw} (use auto, off ou on)`);
}

export function loadSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    enabled: flag(env, "SEARCH_ENABLED", true),
    semantic: semanticMode(env),
    embedModel: env.EMBED_MODEL?.trim() || "bge-m3",
    embedDim: integer(env, "EMBED_DIM", 1024, 8, 4096),
    embedKeepAlive: env.EMBED_KEEP_ALIVE?.trim() || "10m",
    embedBatch: integer(env, "EMBED_BATCH", 16, 1, 64),
    embedDocPrefix: env.EMBED_DOC_PREFIX ?? "",
    embedQueryPrefix: env.EMBED_QUERY_PREFIX ?? "",
    indexDebounceSeconds: integer(env, "SEARCH_INDEX_DEBOUNCE_SECONDS", 20, 0, 3600),
    chatMinSimilarity: ratio(env, "CHAT_MIN_SIMILARITY", 0.45),
    chatContextTokens: integer(env, "CHAT_MAX_CONTEXT_TOKENS", 3500, 500, 16000),
    chatContextTokensLive: integer(env, "CHAT_MAX_CONTEXT_TOKENS_LIVE", 2000, 500, 8000),
  };
}
