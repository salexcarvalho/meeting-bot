import { createHash } from "node:crypto";
import type { SearchKindValue } from "@meeting-bot/contracts";

// Divide o conteúdo de uma reunião em trechos pesquisáveis (specs/003-busca-chat/data-model.md).
// Módulo puro: não toca em banco nem em rede.

export const CHUNK_MAX_CHARS = 4000;
const SPLIT_AT_CHARS = 3500;
const TARGET_WORDS = 180;
const PAUSE_SECONDS = 45;
const NARRATIVE_MAX = 1800;
const EMBED_TEXT_MAX = 2400;

export interface TranscriptSegmentInput {
  id: number;
  /** nome exibido (já resolvido por `speakerNameResolver`) */
  speaker: string | null;
  text: string;
  start: number;
  end: number;
}

export interface ChunkDraft {
  kind: SearchKindValue;
  sourceId: string;
  seq: number;
  content: string;
  startSeconds: number | null;
  endSeconds: number | null;
  firstSegmentId: number | null;
  lastSegmentId: number | null;
  speakers: string[];
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Corta um texto longo demais em pedaços ≤ CHUNK_MAX_CHARS, sempre em fronteira de palavra. */
export function splitLong(text: string, limit = SPLIT_AT_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(" ", limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

interface Line {
  segment: TranscriptSegmentInput;
  text: string;
}

function render(lines: Line[]): string {
  let previous: string | null | undefined;
  return lines
    .map(({ segment, text }) => {
      const showSpeaker = segment.speaker && segment.speaker !== previous;
      previous = segment.speaker;
      return showSpeaker ? `${segment.speaker}: ${text}` : text;
    })
    .join("\n");
}

function windowDraft(lines: Line[], seq: number): ChunkDraft {
  const segments = lines.map((l) => l.segment);
  const speakers = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))];
  return {
    kind: "transcript",
    sourceId: "",
    seq,
    content: render(lines),
    startSeconds: segments[0].start,
    endSeconds: Math.max(...segments.map((s) => s.end)),
    firstSegmentId: segments[0].id,
    lastSegmentId: segments.at(-1)?.id ?? segments[0].id,
    speakers,
  };
}

/** Segmento maior que o limite vira vários "segmentos" de mesmo id e tempo, para caber no trecho. */
function expandLines(segments: TranscriptSegmentInput[]): Line[] {
  const lines: Line[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const piece of splitLong(text)) lines.push({ segment, text: piece });
  }
  return lines;
}

/**
 * Janelas de ~180 palavras com sobreposição de 1 segmento; quebra em pausa > 45 s.
 * mic e remote entram na mesma sequência, ordenados por início.
 */
export function buildTranscriptChunks(input: TranscriptSegmentInput[]): ChunkDraft[] {
  const ordered = [...input].sort((a, b) => a.start - b.start || a.id - b.id);
  const lines = expandLines(ordered);
  const chunks: ChunkDraft[] = [];
  let current: Line[] = [];
  let words = 0;
  for (const line of lines) {
    const last = current.at(-1);
    const paused = last !== undefined && line.segment.start - last.segment.end > PAUSE_SECONDS;
    if (current.length && (paused || words >= TARGET_WORDS)) {
      chunks.push(windowDraft(current, chunks.length));
      current = paused || current.length === 1 ? [] : [current[current.length - 1]];
      words = current.reduce((n, l) => n + wordCount(l.text), 0);
    }
    current.push(line);
    words += wordCount(line.text);
  }
  if (current.length) chunks.push(windowDraft(current, chunks.length));
  return chunks;
}

export interface AnalysisInput {
  objetivo?: string | null;
  resumo_executivo?: string | null;
  assuntos?: { titulo: string; resumo: string }[] | null;
  observacoes_arquiteto?: string[] | null;
}

function narrative(sourceId: string, content: string): ChunkDraft | null {
  const text = content.replace(/\s+/g, " ").trim().slice(0, NARRATIVE_MAX);
  if (!text) return null;
  return { kind: "analysis", sourceId, seq: 0, content: text, startSeconds: null, endSeconds: null, firstSegmentId: null, lastSegmentId: null, speakers: [] };
}

/** Narrativa da ata: uma seção por trecho (`objetivo`, `resumo_executivo`, `assunto:n`, `observacao:n`). */
export function buildAnalysisChunks(analysis: AnalysisInput | null | undefined): ChunkDraft[] {
  if (!analysis) return [];
  const drafts = [
    narrative("objetivo", analysis.objetivo ?? ""),
    narrative("resumo_executivo", analysis.resumo_executivo ?? ""),
    ...(analysis.assuntos ?? []).map((a, i) => narrative(`assunto:${i + 1}`, `${a.titulo}: ${a.resumo}`)),
    ...(analysis.observacoes_arquiteto ?? []).map((o, i) => narrative(`observacao:${i + 1}`, o)),
  ];
  return drafts.filter((d): d is ChunkDraft => d !== null);
}

export interface ItemInput {
  id: string;
  type: string;
  description: string;
  owner: string | null;
  due: string | null;
  reviewStatus: string;
  attributes: Record<string, unknown>;
}

const ATTRIBUTE_LABELS: [string, string][] = [
  ["sistema", "Sistema"],
  ["motivacao", "Motivação"],
  ["impacto", "Impacto"],
  ["dependencia", "Dependência"],
  ["categoria", "Categoria"],
];

function attributeLines(attributes: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, label] of ATTRIBUTE_LABELS) {
    const value = Object.hasOwn(attributes, key) ? attributes[key] : null;
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${value.trim()}`);
  }
  return lines;
}

/** Item rejeitado não gera trecho. O selo proposto/aprovado não entra no texto: é lido na consulta. */
export function buildItemChunk(item: ItemInput): ChunkDraft | null {
  if (item.reviewStatus === "rejeitado") return null;
  const lines = [`${item.type}: ${item.description.trim()}`];
  if (item.owner) lines.push(`Responsável: ${item.owner}`);
  if (item.due) lines.push(`Prazo: ${item.due}`);
  lines.push(...attributeLines(item.attributes));
  const content = lines.join("\n").slice(0, CHUNK_MAX_CHARS);
  return { kind: "item", sourceId: item.id, seq: 0, content, startSeconds: null, endSeconds: null, firstSegmentId: null, lastSegmentId: null, speakers: [] };
}

export interface AdrInput {
  id: string;
  status: string;
  title: string;
  context: string;
  problem: string;
  decision: string;
  consequences: string;
}

export function buildAdrChunk(adr: AdrInput): ChunkDraft | null {
  if (adr.status === "rejeitado") return null;
  const content = [
    adr.title,
    `Contexto: ${adr.context}`,
    `Problema: ${adr.problem}`,
    `Decisão: ${adr.decision}`,
    `Consequências: ${adr.consequences}`,
  ]
    .map((s) => s.trim())
    .join("\n")
    .slice(0, CHUNK_MAX_CHARS);
  return { kind: "adr", sourceId: adr.id, seq: 0, content, startSeconds: null, endSeconds: null, firstSegmentId: null, lastSegmentId: null, speakers: [] };
}

export interface MeetingMetaInput {
  title: string;
  projectName: string | null;
  /** data já formatada (dd/mm/aaaa) */
  dateLabel: string;
  organizer: string | null;
  attendees: string[];
  description: string | null;
}

export function buildMeetingChunk(meta: MeetingMetaInput): ChunkDraft {
  const lines = [meta.title, `Data: ${meta.dateLabel}`];
  if (meta.projectName) lines.push(`Projeto: ${meta.projectName}`);
  if (meta.organizer) lines.push(`Organizador: ${meta.organizer}`);
  if (meta.attendees.length) lines.push(`Participantes: ${meta.attendees.join(", ")}`);
  if (meta.description?.trim()) lines.push(meta.description.replace(/\s+/g, " ").trim());
  const content = lines.join("\n").slice(0, CHUNK_MAX_CHARS);
  return { kind: "meeting", sourceId: "", seq: 0, content, startSeconds: null, endSeconds: null, firstSegmentId: null, lastSegmentId: null, speakers: [] };
}

/** Texto enviado ao modelo de embedding: o contexto da reunião vem antes do trecho (não é guardado). */
export function embedText(header: string, content: string, prefix = ""): string {
  return `${prefix}${header}\n${content}`.slice(0, EMBED_TEXT_MAX);
}

/** Hash do que foi embedado mais o modelo: decide se o vetor precisa ser recalculado. */
export function contentHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}
