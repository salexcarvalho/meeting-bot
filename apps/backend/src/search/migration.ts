import type { PoolClient } from "pg";
import { SEARCH_KINDS } from "@meeting-bot/contracts";
import { loadSearchConfig, type SearchConfig } from "./config";

// Migração aditiva e idempotente da busca (specs/003-busca-chat/data-model.md). Roda dentro do
// advisory lock de `migrate`. Nenhuma tabela ou coluna existente muda.

export class PgvectorMissingError extends Error {
  constructor() {
    super(
      "A extensão pgvector não está disponível neste Postgres. Reconstrua a imagem " +
        "(docker --context default compose build postgres; docker/postgres/Dockerfile) e recrie o serviço postgres, " +
        "ou defina SEARCH_SEMANTIC=off (ou SEARCH_ENABLED=false) para rodar só com busca de texto.",
    );
    this.name = "PgvectorMissingError";
  }
}

export class EmbedDimensionMismatchError extends Error {
  constructor(column: number, configured: number) {
    super(
      `search_chunks.embedding tem ${column} dimensões, mas EMBED_DIM=${configured}. ` +
        "Trocar a dimensão exige recriar a coluna (os vetores são reconstruíveis): DROP TABLE search_chunks, search_index_state.",
    );
    this.name = "EmbedDimensionMismatchError";
  }
}

const TEXT_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  // unaccent dentro da configuração: unaccent() é STABLE e não serve em coluna gerada.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
       CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
       ALTER TEXT SEARCH CONFIGURATION pt_unaccent
         ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS search_chunks (
     id BIGSERIAL PRIMARY KEY,
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN (${SEARCH_KINDS.map((k) => `'${k}'`).join(", ")})),
     source_id TEXT NOT NULL DEFAULT '',
     seq INT NOT NULL DEFAULT 0,
     content TEXT NOT NULL CHECK (char_length(content) <= 4000),
     start_seconds NUMERIC,
     end_seconds NUMERIC,
     first_segment_id BIGINT,
     last_segment_id BIGINT,
     speakers TEXT[] NOT NULL DEFAULT '{}',
     content_hash TEXT NOT NULL,
     tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('pt_unaccent', content)) STORED,
     embed_model TEXT,
     embedded_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (meeting_id, kind, source_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_search_chunks_tsv ON search_chunks USING gin (tsv)`,
  `CREATE INDEX IF NOT EXISTS idx_search_chunks_meeting_kind ON search_chunks (meeting_id, kind)`,
  `CREATE TABLE IF NOT EXISTS search_index_state (
     meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
     status TEXT NOT NULL CHECK (status IN ('pending', 'indexing', 'text_ready', 'indexed', 'failed')),
     dirty_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     text_indexed_at TIMESTAMPTZ,
     indexed_at TIMESTAMPTZ,
     chunk_count INT NOT NULL DEFAULT 0,
     embedded_count INT NOT NULL DEFAULT 0,
     attempts INT NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ,
     last_error TEXT CHECK (char_length(last_error) <= 300),
     embed_model TEXT,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_search_state_queue ON search_index_state (status, dirty_at) WHERE status IN ('pending', 'text_ready')`,
];

// Backfill: toda reunião concluída entra na fila; as que concluírem depois entram pelo gatilho.
const SEED = `INSERT INTO search_index_state (meeting_id, status)
              SELECT m.id, 'pending' FROM meetings m WHERE m.status = 'done'
              ON CONFLICT (meeting_id) DO NOTHING`;

async function vectorAvailable(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
  return rows.length > 0;
}

async function embeddingColumnDim(client: PoolClient): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'search_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`,
  );
  return rows.length ? Number(rows[0].atttypmod) : null;
}

/** Parte vetorial: extensão, coluna `embedding` e índice HNSW parcial. Falha clara se a extensão não existir. */
async function migrateVector(client: PoolClient, cfg: SearchConfig): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  const dim = Math.trunc(cfg.embedDim);
  const existing = await embeddingColumnDim(client);
  if (existing === null) await client.query(`ALTER TABLE search_chunks ADD COLUMN embedding vector(${dim})`);
  else if (existing !== dim) throw new EmbedDimensionMismatchError(existing, dim);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_search_chunks_hnsw ON search_chunks USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64) WHERE embedding IS NOT NULL`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_search_chunks_model ON search_chunks (embed_model) WHERE embedding IS NOT NULL`,
  );
}

/** `probe` existe para o teste simular um Postgres sem a extensão. */
export async function migrateSearch(
  client: PoolClient,
  cfg: SearchConfig = loadSearchConfig(),
  probe: (client: PoolClient) => Promise<boolean> = vectorAvailable,
): Promise<void> {
  if (!cfg.enabled) return;
  // A verificação vem primeiro: sem a extensão (e sem SEARCH_SEMANTIC=off) o boot falha antes de criar tabelas.
  if (cfg.semantic !== "off" && !(await probe(client))) throw new PgvectorMissingError();
  for (const sql of TEXT_STATEMENTS) await client.query(sql);
  if (cfg.semantic !== "off") await migrateVector(client, cfg);
  await client.query(SEED);
}
