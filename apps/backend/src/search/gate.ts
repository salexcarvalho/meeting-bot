import type { SearchSemanticReason } from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";
import { getEmbedder } from "./embedder";

// Quando os embeddings podem rodar e se a busca semântica está disponível.

/** Estados em que há gravação ou chamada em curso (FR-016): os embeddings esperam. */
export const LIVE_STATUSES = ["recording", "stopping", "joining", "waiting_admission", "in_call"] as const;

export async function liveBusy(): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM meetings WHERE status = ANY($1::text[]) LIMIT 1`, [LIVE_STATUSES]);
  return (rowCount ?? 0) > 0;
}

const COLUMN_TTL_MS = 30_000;
let columnCache: { at: number; value: boolean } | null = null;

/** A coluna `embedding` existe (a extensão vector foi instalada pela migração)? */
export async function vectorInstalled(): Promise<boolean> {
  const now = Date.now();
  if (columnCache && now - columnCache.at < COLUMN_TTL_MS) return columnCache.value;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('search_chunks') AND attname = 'embedding' AND NOT attisdropped`,
  );
  columnCache = { at: now, value: (rowCount ?? 0) > 0 };
  return columnCache.value;
}

export function resetGateCache(): void {
  columnCache = null;
}

export interface SemanticState {
  available: boolean;
  reason: SearchSemanticReason | null;
}

/** Semântica disponível = ligada, pgvector instalado e modelo de embedding presente no Ollama. */
export async function semanticState(): Promise<SemanticState> {
  if (!config.search.enabled || config.search.semantic === "off") return { available: false, reason: "desligada" };
  if (!(await vectorInstalled())) return { available: false, reason: "sem_pgvector" };
  const health = await getEmbedder().health();
  return { available: health.available, reason: health.reason };
}

/** O chat precisa do LLM local e da semântica não desligada de propósito (no VPS de teste fica desligado, Q3-A). */
export function chatEnabled(): boolean {
  return config.search.enabled && config.search.semantic !== "off";
}
