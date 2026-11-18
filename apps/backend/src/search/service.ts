import type {
  SearchMeetingStatusValue,
  SearchQueryInput,
  SearchResponseValue,
  SearchStatusValue,
  SearchSystemInfoValue,
} from "@meeting-bot/contracts";
import { visibleMeetingsSql } from "../authz";
import { config } from "../config";
import { pool } from "../db";
import type { User } from "../types";
import { chatEnabled, liveBusy, semanticState } from "./gate";
import { fuseRetrieval, hydrate, retrieve, type ScopeFilters } from "./query";
import { getEmbedder } from "./embedder";

export function filtersOf(input: SearchQueryInput): ScopeFilters {
  return { kinds: input.kind, projectId: input.projectId, from: input.from, to: input.to, meetingIds: input.meetingId };
}

/** Busca híbrida (ou só texto/semântica) com a permissão aplicada na própria consulta. */
export async function runSearch(user: User, input: SearchQueryInput): Promise<SearchResponseValue> {
  const started = Date.now();
  const filters = filtersOf(input);
  const retrieval = await retrieve(user, input.q, filters, { mode: input.mode, orFallback: true });
  const ordered = fuseRetrieval(retrieval, true);
  const page = ordered.slice(input.offset, input.offset + input.limit);
  const hydrated = await hydrate(user, page, input.q, filters);
  return {
    query: input.q,
    mode: input.mode,
    modeUsed: retrieval.modeUsed,
    semantic: retrieval.semanticInfo,
    hits: hydrated.map((h) => h.hit),
    total: ordered.length,
    tookMs: Date.now() - started,
  };
}

// ---------- estado do índice ----------

const TOTALS_SQL = (visible: string) => `
  SELECT count(*)::int AS meetings,
         count(*) FILTER (WHERE s.status = 'indexed')::int AS indexed,
         count(*) FILTER (WHERE s.status = 'text_ready')::int AS text_ready,
         count(*) FILTER (WHERE s.status IN ('pending', 'indexing'))::int AS pending,
         count(*) FILTER (WHERE s.status = 'failed')::int AS failed,
         COALESCE(sum(s.chunk_count), 0)::int AS chunks
    FROM search_index_state s JOIN meetings m ON m.id = s.meeting_id
   WHERE ${visible}`;

const FAILURES_SQL = (visible: string) => `
  SELECT s.meeting_id, m.title, COALESCE(s.last_error, '') AS error, s.attempts
    FROM search_index_state s JOIN meetings m ON m.id = s.meeting_id
   WHERE s.status = 'failed' AND ${visible}
   ORDER BY s.updated_at DESC LIMIT 20`;

/** Estado do índice só das reuniões que o usuário pode ler (FR-035). */
export async function searchStatus(user: User): Promise<SearchStatusValue> {
  const visible = visibleMeetingsSql(user, "m", 1);
  const [totals, failures, semantic, live] = await Promise.all([
    pool.query(TOTALS_SQL(visible), [user.id]),
    pool.query(FAILURES_SQL(visible), [user.id]),
    semanticState(),
    liveBusy(),
  ]);
  const t = totals.rows[0];
  const chat = chatEnabled();
  let chatReason: "ollama_indisponivel" | "desligado" | null = "desligado";
  if (chat) chatReason = semantic.available ? null : "ollama_indisponivel";
  return {
    enabled: config.search.enabled,
    semantic: { available: semantic.available, model: getEmbedder().model, dim: getEmbedder().dim, reason: semantic.reason },
    chat: { available: chat && semantic.available, reason: chatReason },
    paused: live ? "reuniao_ao_vivo" : null,
    totals: { meetings: t.meetings, indexed: t.indexed, textReady: t.text_ready, pending: t.pending, failed: t.failed, chunks: t.chunks },
    failures: failures.rows.map((r) => ({ meetingId: r.meeting_id, title: r.title, error: r.error, attempts: r.attempts })),
  };
}

/** Estado de uma reunião; `null` se não existir OU não for visível (a rota responde 404 igual nos dois casos). */
export async function meetingIndexStatus(user: User, meetingId: string): Promise<SearchMeetingStatusValue | null> {
  const { rows } = await pool.query(
    `SELECT s.status, s.chunk_count, s.embedded_count, s.indexed_at
       FROM search_index_state s JOIN meetings m ON m.id = s.meeting_id
      WHERE s.meeting_id = $2 AND ${visibleMeetingsSql(user, "m", 1)}`,
    [user.id, meetingId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    meetingId,
    status: row.status,
    chunkCount: row.chunk_count,
    embeddedCount: row.embedded_count,
    indexedAt: row.indexed_at ? (row.indexed_at as Date).toISOString() : null,
  };
}

/**
 * Recoloca na fila só as reuniões do PRÓPRIO usuário (dono). Devolve quantas; `null` quando
 * `meetingId` não é do usuário (igual a inexistente).
 */
export async function reindexOwn(user: User, meetingId?: string): Promise<number | null> {
  const { rows } = await pool.query(
    `WITH own AS (
       SELECT id FROM meetings WHERE created_by = $1 AND status = 'done' AND ($2::uuid IS NULL OR id = $2::uuid)
     ), up AS (
       INSERT INTO search_index_state (meeting_id, status) SELECT id, 'pending' FROM own
       ON CONFLICT (meeting_id) DO UPDATE
          SET status = 'pending', dirty_at = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM up)::int AS queued`,
    [user.id, meetingId ?? null],
  );
  const queued: number = rows[0].queued;
  return meetingId && queued === 0 ? null : queued;
}

/** Resumo para o `GET /system/status`. */
export async function searchSystemInfo(): Promise<SearchSystemInfoValue> {
  if (!config.search.enabled) return { enabled: false, semantic: false, paused: false };
  const [semantic, paused] = await Promise.all([semanticState(), liveBusy()]);
  return { enabled: true, semantic: semantic.available, paused };
}
