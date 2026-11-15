import {
  SEARCH_KINDS,
  type SearchHitValue,
  type SearchKindValue,
  type SearchModeValue,
  type SearchSemanticReason,
  type SearchTargetValue,
} from "@meeting-bot/contracts";
import { can, visibleMeetingsSql } from "../authz";
import { config } from "../config";
import { pool, withTransaction } from "../db";
import type { User } from "../types";
import { getEmbedder, vectorLiteral } from "./embedder";
import { semanticState } from "./gate";
import { dropNeighbors, fuse, type MatchSource } from "./rrf";
import { HEADLINE_OPTIONS, hasMatch, parseHeadline, plainSnippet } from "./snippet";
import { recordEmbedUsage } from "./usage";

// Consulta da busca (specs/003-busca-chat). A permissão é aplicada DENTRO de cada consulta, antes do
// LIMIT: `visibleMeetingsSql` (dono ou meeting_shares) junto com o filtro de tipos pelo papel. Nada de
// pós-filtro. O índice não guarda dono, então revogar um compartilhamento muda o resultado na hora.
// Todo valor do usuário vai como parâmetro; o vetor da consulta também.

export const CANDIDATES = 50;
const MAX_TOTAL = 100;
const HNSW_EF_SEARCH = 80;
const HNSW_MAX_SCAN_TUPLES = 20_000;

export interface ScopeFilters {
  kinds?: SearchKindValue[];
  projectId?: string;
  from?: string;
  to?: string;
  meetingIds?: string[];
}

interface Candidate {
  id: number;
  meetingId: string;
  kind: string;
  sourceId: string;
  seq: number;
  similarity: number | null;
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Tipos que o papel pode ler (FR-031), já cruzados com o filtro pedido. */
export function allowedKinds(user: User, requested?: SearchKindValue[]): SearchKindValue[] {
  const canTranscript = can(user, "transcripts.read");
  const canDocuments = can(user, "documents.read");
  const all = SEARCH_KINDS.filter((k) => (k === "transcript" ? canTranscript : canDocuments));
  return requested?.length ? all.filter((k) => requested.includes(k)) : [...all];
}

const FROM_SQL = `
  FROM search_chunks c
  JOIN meetings m ON m.id = c.meeting_id
  LEFT JOIN meeting_items it ON c.kind = 'item' AND it.id::text = c.source_id
  LEFT JOIN adrs a ON c.kind = 'adr' AND a.id::text = c.source_id`;

const MEETING_DATE = `(COALESCE(m.started_at, m.scheduled_start, m.created_at) AT TIME ZONE`;

function dateClauses(filters: ScopeFilters, p: Params): string[] {
  const clauses: string[] = [];
  const tz = filters.from || filters.to ? p.add(config.appTimezone) : "";
  if (filters.from) clauses.push(`${MEETING_DATE} ${tz})::date >= ${p.add(filters.from.slice(0, 10))}::date`);
  if (filters.to) clauses.push(`${MEETING_DATE} ${tz})::date <= ${p.add(filters.to.slice(0, 10))}::date`);
  return clauses;
}

/**
 * WHERE de permissão e filtros. `$1` é sempre o usuário. `meetingIds` é interseção com o visível
 * (nunca um bypass): a cláusula de visibilidade continua valendo.
 */
function scopeSql(user: User, kinds: SearchKindValue[], filters: ScopeFilters, p: Params): string {
  const clauses = [
    visibleMeetingsSql(user, "m", 1),
    `c.kind = ANY(${p.add(kinds)}::text[])`,
    `(c.kind <> 'item' OR (it.id IS NOT NULL AND it.review_status <> 'rejeitado'))`,
    `(c.kind <> 'adr' OR (a.id IS NOT NULL AND a.status <> 'rejeitado'))`,
  ];
  if (filters.projectId) clauses.push(`m.project_id = ${p.add(filters.projectId)}::uuid`);
  if (filters.meetingIds?.length) clauses.push(`m.id = ANY(${p.add(filters.meetingIds)}::uuid[])`);
  clauses.push(...dateClauses(filters, p));
  return clauses.join(" AND ");
}

function toCandidate(row: Record<string, unknown>): Candidate {
  return {
    id: Number(row.id),
    meetingId: row.meeting_id as string,
    kind: row.kind as string,
    sourceId: row.source_id as string,
    seq: Number(row.seq),
    similarity: row.similarity === null || row.similarity === undefined ? null : Number(row.similarity),
  };
}

const CANDIDATE_COLUMNS = `c.id, c.meeting_id, c.kind, c.source_id, c.seq`;

/** Consulta léxica (acento e flexão pela configuração `pt_unaccent`). */
async function lexicalCandidates(user: User, q: string, kinds: SearchKindValue[], filters: ScopeFilters, orMode: boolean): Promise<Candidate[]> {
  const p = new Params();
  p.add(user.id);
  const query = p.add(q);
  const tsq = orMode
    ? `replace(websearch_to_tsquery('pt_unaccent', ${query})::text, ' & ', ' | ')::tsquery`
    : `websearch_to_tsquery('pt_unaccent', ${query})`;
  const where = scopeSql(user, kinds, filters, p);
  const { rows } = await pool.query(
    `WITH q AS (SELECT ${tsq} AS tsq)
     SELECT ${CANDIDATE_COLUMNS}, NULL::float AS similarity
       ${FROM_SQL}, q
      WHERE c.tsv @@ q.tsq AND ${where}
      ORDER BY ts_rank_cd(c.tsv, q.tsq, 32) DESC, c.id
      LIMIT ${CANDIDATES}`,
    p.values,
  );
  return rows.map(toCandidate);
}

/** Texto: AND de todos os termos; sem resultado, OR (só quando a consulta não tem negação). */
async function textCandidates(
  user: User,
  q: string,
  kinds: SearchKindValue[],
  filters: ScopeFilters,
  fallback: boolean,
): Promise<{ list: Candidate[]; strict: boolean }> {
  const strict = await lexicalCandidates(user, q, kinds, filters, false);
  if (strict.length) return { list: strict, strict: true };
  if (!fallback || q.includes("-") || q.includes('"')) return { list: strict, strict: false };
  return { list: await lexicalCandidates(user, q, kinds, filters, true), strict: false };
}

/** Vetorial: iterative scan do HNSW para o filtro de permissão não esvaziar a lista (pgvector ≥ 0.8). */
async function semanticCandidates(user: User, vector: number[], kinds: SearchKindValue[], filters: ScopeFilters): Promise<Candidate[]> {
  const p = new Params();
  p.add(user.id);
  const vec = p.add(vectorLiteral(vector));
  const model = p.add(getEmbedder().model);
  const where = scopeSql(user, kinds, filters, p);
  return withTransaction(async (client) => {
    await client.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    await client.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    await client.query(`SET LOCAL hnsw.max_scan_tuples = ${HNSW_MAX_SCAN_TUPLES}`);
    const { rows } = await client.query(
      `SELECT ${CANDIDATE_COLUMNS}, 1 - (c.embedding <=> ${vec}::vector) AS similarity
         ${FROM_SQL}
        WHERE c.embedding IS NOT NULL AND c.embed_model = ${model} AND ${where}
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${CANDIDATES}`,
      p.values,
    );
    return rows.map(toCandidate);
  });
}

/** Embeda a consulta e registra o uso (só números). Falha → null (a busca cai para texto). */
async function embedQuery(user: User, text: string): Promise<number[] | null> {
  const embedder = getEmbedder();
  const started = Date.now();
  const common = { model: embedder.model, meetingId: null, userId: user.id, label: "consulta" };
  try {
    const result = await embedder.embedQuery(text);
    recordEmbedUsage({ ...common, durationMs: Date.now() - started }, { ok: true, result });
    return result.vectors[0] ?? null;
  } catch (err) {
    recordEmbedUsage({ ...common, durationMs: Date.now() - started }, { ok: false, error: err });
    return null;
  }
}

export interface Retrieval {
  /** candidatos de cada fonte, na ordem de relevância */
  text: Candidate[];
  semantic: Candidate[];
  modeUsed: "hybrid" | "text" | "semantic";
  /** a consulta léxica estrita (todos os termos) achou algo; o OR de reserva não conta */
  textStrict: boolean;
  semanticInfo: { available: boolean; reason: SearchSemanticReason | null };
}

export interface RetrieveOptions {
  mode: SearchModeValue;
  /** OR quando o AND não acha nada */
  orFallback: boolean;
  /** texto usado só para o embedding (o chat junta a pergunta anterior); padrão: a própria consulta */
  semanticText?: string;
}

async function semanticPart(
  user: User,
  q: string,
  kinds: SearchKindValue[],
  filters: ScopeFilters,
): Promise<{ list: Candidate[]; info: Retrieval["semanticInfo"] }> {
  const state = await semanticState();
  if (!state.available) return { list: [], info: state };
  const vector = await embedQuery(user, q);
  if (!vector) return { list: [], info: { available: false, reason: "ollama_indisponivel" } };
  return { list: await semanticCandidates(user, vector, kinds, filters), info: { available: true, reason: null } };
}

/** Recupera os candidatos já filtrados por permissão e escopo. */
export async function retrieve(user: User, q: string, filters: ScopeFilters, options: RetrieveOptions): Promise<Retrieval> {
  const kinds = allowedKinds(user, filters.kinds);
  const wantText = options.mode !== "semantic";
  const wantSemantic = options.mode !== "text";
  if (!kinds.length) {
    return { text: [], semantic: [], modeUsed: wantText ? "text" : "semantic", textStrict: false, semanticInfo: await semanticState() };
  }
  const [text, semantic] = await Promise.all([
    wantText ? textCandidates(user, q, kinds, filters, options.orFallback) : Promise.resolve({ list: [] as Candidate[], strict: false }),
    wantSemantic
      ? semanticPart(user, options.semanticText ?? q, kinds, filters)
      : semanticState().then((info) => ({ list: [] as Candidate[], info })),
  ]);
  const semanticOn = wantSemantic && semantic.info.available;
  let modeUsed: Retrieval["modeUsed"] = "text";
  if (semanticOn) modeUsed = wantText ? "hybrid" : "semantic";
  else if (!wantText) modeUsed = "semantic";
  return { text: text.list, semantic: semantic.list, modeUsed, textStrict: text.strict, semanticInfo: semantic.info };
}

export interface HydratedHit {
  hit: SearchHitValue;
  content: string;
  similarity: number | null;
  /** veio da consulta léxica estrita (todos os termos) */
  lexical: boolean;
}

function targetOf(row: Record<string, unknown>): SearchTargetValue {
  const kind = row.kind as SearchKindValue;
  return {
    meetingId: row.meeting_id as string,
    kind,
    segmentId: row.segment_exists ? Number(row.first_segment_id) : null,
    start: row.start_seconds === null ? null : Number(row.start_seconds),
    end: row.end_seconds === null ? null : Number(row.end_seconds),
    itemId: kind === "item" ? (row.source_id as string) : null,
    adrId: kind === "adr" ? (row.source_id as string) : null,
  };
}

function snippetOf(row: Record<string, unknown>) {
  const parts = parseHeadline(String(row.headline ?? ""));
  return hasMatch(parts) ? parts : plainSnippet(String(row.content));
}

function toHit(row: Record<string, unknown>, matchedBy: MatchSource[]): SearchHitValue {
  const kind = row.kind as SearchKindValue;
  const speakers = (row.speakers as string[] | null) ?? [];
  return {
    id: Number(row.id),
    kind,
    meeting: {
      id: row.meeting_id as string,
      title: row.title as string,
      date: (row.at as Date).toISOString(),
      project: row.project_id ? { id: row.project_id as string, name: row.project_name as string } : null,
    },
    snippet: snippetOf(row),
    speaker: kind === "transcript" ? (speakers[0] ?? null) : null,
    matchedBy,
    reviewStatus: ((kind === "item" ? row.item_status : kind === "adr" ? row.adr_status : null) as SearchHitValue["reviewStatus"]) ?? null,
    target: targetOf(row),
  };
}

/**
 * Hidrata os ids finais. A permissão é aplicada DE NOVO aqui: se o acesso foi revogado entre a
 * consulta e esta leitura, o trecho simplesmente não volta.
 */
export async function hydrate(
  user: User,
  ordered: { id: number; matchedBy: MatchSource[]; similarity: number | null }[],
  q: string,
  filters: ScopeFilters,
): Promise<HydratedHit[]> {
  if (!ordered.length) return [];
  const kinds = allowedKinds(user);
  if (!kinds.length) return [];
  const p = new Params();
  p.add(user.id);
  const ids = p.add(ordered.map((o) => o.id));
  const query = p.add(q);
  const options = p.add(HEADLINE_OPTIONS);
  const where = scopeSql(user, kinds, { ...filters, kinds: undefined }, p);
  const { rows } = await pool.query(
    `SELECT c.id, c.meeting_id, c.kind, c.source_id, c.content, c.speakers, c.start_seconds, c.end_seconds, c.first_segment_id,
            (seg.id IS NOT NULL) AS segment_exists, m.title, m.project_id, pr.name AS project_name,
            COALESCE(m.started_at, m.scheduled_start, m.created_at) AS at,
            it.review_status AS item_status, a.status AS adr_status,
            ts_headline('pt_unaccent', c.content, websearch_to_tsquery('pt_unaccent', ${query}), ${options}) AS headline
       ${FROM_SQL}
       LEFT JOIN projects pr ON pr.id = m.project_id
       LEFT JOIN transcript_segments seg ON c.kind = 'transcript' AND seg.id = c.first_segment_id AND seg.meeting_id = c.meeting_id
      WHERE c.id = ANY(${ids}::bigint[]) AND ${where}`,
    p.values,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const out: HydratedHit[] = [];
  for (const o of ordered) {
    const row = byId.get(o.id);
    if (!row) continue;
    out.push({ hit: toHit(row, o.matchedBy), content: row.content as string, similarity: o.similarity, lexical: o.matchedBy.includes("text") });
  }
  return out;
}

export interface FusedResult {
  ordered: { id: number; matchedBy: MatchSource[]; similarity: number | null }[];
  retrieval: Retrieval;
}

/** RRF das duas listas, com o agrupamento de trechos vizinhos opcional. */
export function fuseRetrieval(retrieval: Retrieval, groupNeighbors: boolean): FusedResult["ordered"] {
  const byId = new Map<number, Candidate>();
  for (const c of [...retrieval.text, ...retrieval.semantic]) byId.set(c.id, { ...byId.get(c.id), ...c, similarity: c.similarity ?? byId.get(c.id)?.similarity ?? null });
  let fused = fuse({ text: retrieval.text.map((c) => c.id), semantic: retrieval.semantic.map((c) => c.id) }).slice(0, MAX_TOTAL);
  if (groupNeighbors) {
    const kept = new Set(dropNeighbors(fused.map((f) => byId.get(f.id) as Candidate)).map((c) => c.id));
    fused = fused.filter((f) => kept.has(f.id));
  }
  return fused.map((f) => ({ id: f.id, matchedBy: f.matchedBy, similarity: byId.get(f.id)?.similarity ?? null }));
}
