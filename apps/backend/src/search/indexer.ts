import { config } from "../config";
import { pool, withTransaction } from "../db";
import type { SearchIndexStatusValue } from "@meeting-bot/contracts";
import { hub } from "../live/hub";
import { getSpeakers, speakerNameResolver } from "../repo/transcripts";
import {
  buildAdrChunk,
  buildAnalysisChunks,
  buildItemChunk,
  buildMeetingChunk,
  buildTranscriptChunks,
  contentHash,
  embedText,
  type AnalysisInput,
  type ChunkDraft,
} from "./chunker";
import { dateLabel } from "./format";
import { EmbedError, getEmbedder, vectorLiteral, type Embedder } from "./embedder";
import { vectorInstalled } from "./gate";
import { recordEmbedUsage } from "./usage";

// Indexação de uma reunião em duas fases (data-model.md): texto (só banco; pode rodar a qualquer
// momento) e vetores (Ollama em CPU; espera a gravação e a chamada terminarem).

export const MAX_ATTEMPTS = 5;
/** espera crescente entre tentativas: 30 s, 2 min, 10 min, 1 h, 6 h */
export const BACKOFF_SECONDS = [30, 120, 600, 3600, 21_600];
const UPSERT_BATCH = 200;
const LAST_ERROR_MAX = 300;

interface MeetingRow {
  id: string;
  title: string;
  status: string;
  project_name: string | null;
  at: Date;
  organizer: string | null;
  attendees: unknown;
  description: string | null;
  analysis: unknown;
}

async function loadMeeting(meetingId: string): Promise<MeetingRow | null> {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.status, p.name AS project_name, m.organizer, m.attendees, m.description, m.analysis,
            COALESCE(m.started_at, m.scheduled_start, m.created_at) AS at
       FROM meetings m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1`,
    [meetingId],
  );
  return rows[0] ?? null;
}

/** Contexto que acompanha cada trecho no embedding (não é guardado: entra no hash). */
export function headerOf(title: string, at: Date): string {
  return `${title} — ${dateLabel(at)}`;
}

function attendeeNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      const item = a as { name?: unknown; email?: unknown };
      if (typeof item.name === "string" && item.name) return item.name;
      return typeof item.email === "string" ? item.email : "";
    })
    .filter(Boolean);
}

async function buildDrafts(meeting: MeetingRow): Promise<ChunkDraft[]> {
  const id = meeting.id;
  const [segments, speakers, items, adrs] = await Promise.all([
    pool.query(
      `SELECT id, speaker, text, start_seconds, end_seconds FROM transcript_segments
        WHERE meeting_id = $1 AND pass = 'final' ORDER BY start_seconds, id`,
      [id],
    ),
    getSpeakers(id),
    pool.query(`SELECT id, type, description, owner, due, review_status, attributes FROM meeting_items WHERE meeting_id = $1`, [id]),
    pool.query(`SELECT id, status, title, context, problem, decision, consequences FROM adrs WHERE meeting_id = $1`, [id]),
  ]);
  const nameOf = speakerNameResolver(speakers);
  const transcript = buildTranscriptChunks(
    segments.rows.map((s) => ({
      id: Number(s.id),
      speaker: nameOf(s.speaker),
      text: s.text as string,
      start: Number(s.start_seconds),
      end: Number(s.end_seconds),
    })),
  );
  const itemChunks = items.rows.map((r) =>
    buildItemChunk({
      id: r.id,
      type: r.type,
      description: r.description,
      owner: r.owner,
      due: r.due,
      reviewStatus: r.review_status,
      attributes: (r.attributes ?? {}) as Record<string, unknown>,
    }),
  );
  const adrChunks = adrs.rows.map((r) => buildAdrChunk(r as Parameters<typeof buildAdrChunk>[0]));
  const meta = buildMeetingChunk({
    title: meeting.title,
    projectName: meeting.project_name,
    dateLabel: dateLabel(meeting.at),
    organizer: meeting.organizer,
    attendees: attendeeNames(meeting.attendees),
    description: meeting.description,
  });
  return [
    ...transcript,
    ...buildAnalysisChunks(meeting.analysis as AnalysisInput | null),
    ...itemChunks.filter((c): c is ChunkDraft => c !== null),
    ...adrChunks.filter((c): c is ChunkDraft => c !== null),
    meta,
  ];
}

function upsertSql(rows: number, withVector: boolean): string {
  const tuples = Array.from({ length: rows }, (_, i) => {
    const o = i * 11;
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}::text[], $${o + 11})`;
  });
  // Hash igual = vetor aproveitado; hash diferente = vetor zerado (será recalculado).
  const keep = (col: string) => `CASE WHEN search_chunks.content_hash = EXCLUDED.content_hash THEN search_chunks.${col} END`;
  const vectorReset = withVector
    ? `, embedding = ${keep("embedding")}, embed_model = ${keep("embed_model")}, embedded_at = ${keep("embedded_at")}`
    : "";
  return `INSERT INTO search_chunks (meeting_id, kind, source_id, seq, content, start_seconds, end_seconds, first_segment_id, last_segment_id, speakers, content_hash)
          VALUES ${tuples.join(", ")}
          ON CONFLICT (meeting_id, kind, source_id, seq) DO UPDATE
             SET content = EXCLUDED.content, start_seconds = EXCLUDED.start_seconds, end_seconds = EXCLUDED.end_seconds,
                 first_segment_id = EXCLUDED.first_segment_id, last_segment_id = EXCLUDED.last_segment_id,
                 speakers = EXCLUDED.speakers, content_hash = EXCLUDED.content_hash, updated_at = now()${vectorReset}
           WHERE (search_chunks.content, search_chunks.start_seconds, search_chunks.end_seconds, search_chunks.first_segment_id,
                  search_chunks.last_segment_id, search_chunks.speakers, search_chunks.content_hash)
                 IS DISTINCT FROM (EXCLUDED.content, EXCLUDED.start_seconds, EXCLUDED.end_seconds, EXCLUDED.first_segment_id,
                                   EXCLUDED.last_segment_id, EXCLUDED.speakers, EXCLUDED.content_hash)`;
}

function paramsOf(meetingId: string, drafts: { draft: ChunkDraft; hash: string }[]): unknown[] {
  return drafts.flatMap(({ draft: d, hash }) => [
    meetingId,
    d.kind,
    d.sourceId,
    d.seq,
    d.content,
    d.startSeconds,
    d.endSeconds,
    d.firstSegmentId,
    d.lastSegmentId,
    d.speakers,
    hash,
  ]);
}

export interface TextIndexResult {
  chunks: number;
  /** `dirty_at` (texto, microssegundos) lido no começo: o fim só vale se ele não mudou */
  dirtyAt: string;
}

/** Fase de texto: monta os trechos e sincroniza `search_chunks` (upsert por hash + remoção do que sumiu). */
export async function indexMeetingText(meetingId: string): Promise<TextIndexResult | null> {
  const meeting = await loadMeeting(meetingId);
  if (meeting?.status !== "done") return null;
  const { rows: state } = await pool.query(`SELECT dirty_at::text AS dirty_at FROM search_index_state WHERE meeting_id = $1`, [meetingId]);
  if (!state[0]) return null;
  const header = headerOf(meeting.title, meeting.at);
  const drafts = (await buildDrafts(meeting)).map((draft) => ({
    draft,
    hash: contentHash(embedText(header, draft.content), config.search.embedModel),
  }));
  const withVector = await vectorInstalled();
  await withTransaction(async (client) => {
    for (let i = 0; i < drafts.length; i += UPSERT_BATCH) {
      const batch = drafts.slice(i, i + UPSERT_BATCH);
      await client.query(upsertSql(batch.length, withVector), paramsOf(meetingId, batch));
    }
    await client.query(
      `DELETE FROM search_chunks
        WHERE meeting_id = $1
          AND (kind, source_id, seq) NOT IN (SELECT k, s, q FROM unnest($2::text[], $3::text[], $4::int[]) AS t(k, s, q))`,
      [meetingId, drafts.map((d) => d.draft.kind), drafts.map((d) => d.draft.sourceId), drafts.map((d) => d.draft.seq)],
    );
  });
  return { chunks: drafts.length, dirtyAt: state[0].dirty_at as string };
}

/**
 * Texto pronto: os trechos já respondem à busca por texto. O estado continua `indexing` até a fase de
 * vetores terminar (ou ser dispensada). Só vale se a reunião não foi alterada no meio.
 */
export async function finishText(meetingId: string, dirtyAt: string, chunks: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE search_index_state
        SET text_indexed_at = now(), chunk_count = $3, updated_at = now()
      WHERE meeting_id = $1 AND dirty_at::text = $2 AND status = 'indexing'`,
    [meetingId, dirtyAt, chunks],
  );
  return (rowCount ?? 0) > 0;
}

export interface EmbedProgress {
  embedded: number;
  /** trechos ainda sem vetor do modelo atual */
  remaining: number;
  /** parou porque há reunião ao vivo */
  paused: boolean;
}

interface PendingRow {
  id: string;
  content: string;
  content_hash: string;
}

async function pendingRows(meetingId: string, model: string, skip: string[], limit: number): Promise<PendingRow[]> {
  const { rows } = await pool.query(
    `SELECT id::text, content, content_hash FROM search_chunks
      WHERE meeting_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2) AND NOT (id::text = ANY($3::text[]))
      ORDER BY id LIMIT $4`,
    [meetingId, model, skip, limit],
  );
  return rows as PendingRow[];
}

async function remainingCount(meetingId: string, model: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM search_chunks WHERE meeting_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2)`,
    [meetingId, model],
  );
  return rows[0].n;
}

async function storeVectors(rows: PendingRow[], vectors: number[][], model: string): Promise<void> {
  await pool.query(
    `UPDATE search_chunks c
        SET embedding = v.e::vector, embed_model = $4, embedded_at = now()
       FROM unnest($1::bigint[], $2::text[], $3::text[]) AS v(id, e, h)
      WHERE c.id = v.id AND c.content_hash = v.h`,
    [rows.map((r) => r.id), vectors.map(vectorLiteral), rows.map((r) => r.content_hash), model],
  );
}

export interface EmbedOptions {
  /** consultado antes de cada lote: gravação ou chamada em curso interrompe */
  paused: () => Promise<boolean>;
  embedder?: Embedder;
}

/**
 * Fase de vetores: embeda só os trechos sem vetor do modelo atual, em lotes, gravando a cada lote
 * (falha parcial preserva o que já foi gravado). Lança o erro do embedder para o worker decidir o backoff.
 */
export async function embedPending(meetingId: string, options: EmbedOptions): Promise<EmbedProgress> {
  const embedder = options.embedder ?? getEmbedder();
  const meeting = await loadMeeting(meetingId);
  if (!meeting) return { embedded: 0, remaining: 0, paused: false };
  const header = headerOf(meeting.title, meeting.at);
  const stale: string[] = [];
  let embedded = 0;
  for (;;) {
    if (await options.paused()) return { embedded, remaining: await remainingCount(meetingId, embedder.model), paused: true };
    const batch = await pendingRows(meetingId, embedder.model, stale, config.search.embedBatch);
    if (!batch.length) break;
    const usable: { row: PendingRow; text: string }[] = [];
    for (const row of batch) {
      const text = embedText(header, row.content);
      // hash divergente = a reunião mudou depois da fase de texto; a próxima rodada de texto corrige
      if (contentHash(text, embedder.model) === row.content_hash) usable.push({ row, text });
      else stale.push(row.id);
    }
    if (usable.length) {
      embedded += await embedBatch(meetingId, embedder, usable);
    }
  }
  return { embedded, remaining: await remainingCount(meetingId, embedder.model), paused: false };
}

async function embedBatch(meetingId: string, embedder: Embedder, usable: { row: PendingRow; text: string }[]): Promise<number> {
  const started = Date.now();
  const common = { model: embedder.model, meetingId, userId: null, label: "indexação", durationMs: 0 };
  try {
    const result = await embedder.embedDocuments(usable.map((u) => u.text));
    recordEmbedUsage({ ...common, durationMs: Date.now() - started }, { ok: true, result });
    await storeVectors(usable.map((u) => u.row), result.vectors, embedder.model);
    return usable.length;
  } catch (err) {
    recordEmbedUsage({ ...common, durationMs: Date.now() - started }, { ok: false, error: err });
    throw err;
  }
}

/** Fim da fase de vetores: `indexed` se todos os trechos têm vetor do modelo atual; senão fica `text_ready`. */
export async function finishEmbedding(meetingId: string, dirtyAt: string, progress: EmbedProgress): Promise<boolean> {
  const done = progress.remaining === 0;
  const { rowCount } = await pool.query(
    `UPDATE search_index_state s
        SET status = $3,
            indexed_at = CASE WHEN $3 = 'indexed' THEN now() ELSE s.indexed_at END,
            embed_model = $4, attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now(),
            chunk_count = (SELECT count(*) FROM search_chunks WHERE meeting_id = $1),
            embedded_count = (SELECT count(*) FROM search_chunks WHERE meeting_id = $1 AND embedding IS NOT NULL AND embed_model = $4)
      WHERE s.meeting_id = $1 AND s.dirty_at::text = $2 AND s.status = 'indexing'`,
    [meetingId, dirtyAt, done ? "indexed" : "text_ready", config.search.embedModel],
  );
  return (rowCount ?? 0) > 0;
}

/** Semântica desligada: o estado final é `text_ready` e a tela mostra "somente texto". */
export async function finishTextOnly(meetingId: string, dirtyAt: string): Promise<void> {
  await pool.query(
    `UPDATE search_index_state s
        SET status = 'text_ready', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now(),
            chunk_count = (SELECT count(*) FROM search_chunks WHERE meeting_id = $1)
      WHERE s.meeting_id = $1 AND s.dirty_at::text = $2 AND s.status = 'indexing'`,
    [meetingId, dirtyAt],
  );
}

/** Motivo curto e sem conteúdo de reunião. */
export function failureReason(err: unknown): string {
  if (err instanceof EmbedError) return err.message.slice(0, LAST_ERROR_MAX);
  return `falha na indexação (${err instanceof Error ? err.name : "erro"})`;
}

/** Falha: espera crescente; na 5ª tentativa vira `failed`. A guarda `status = 'indexing'` preserva um `markDirty` concorrente. */
export async function recordFailure(meetingId: string, err: unknown, phase: "text" | "vectors"): Promise<void> {
  await pool.query(
    `UPDATE search_index_state
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + make_interval(secs => (($3::int[])[LEAST(attempts + 1, $4)])),
            status = CASE WHEN attempts + 1 >= $4 THEN 'failed' WHEN $5 = 'text' THEN 'pending' ELSE 'text_ready' END,
            updated_at = now()
      WHERE meeting_id = $1 AND status = 'indexing'`,
    [meetingId, failureReason(err), BACKOFF_SECONDS, MAX_ATTEMPTS, phase],
  );
}

export async function currentStatus(meetingId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT status FROM search_index_state WHERE meeting_id = $1`, [meetingId]);
  return rows[0]?.status ?? null;
}

export async function publishState(meetingId: string): Promise<void> {
  const status = await currentStatus(meetingId);
  if (status) hub.publishToMeeting(meetingId, { type: "search_index", meetingId, status: status as SearchIndexStatusValue });
}
