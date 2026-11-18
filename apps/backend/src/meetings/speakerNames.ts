import { REMOTE_SPEAKER_LABEL, USER_SPEAKER_LABEL } from "@meeting-bot/contracts";
import { disambiguateNames, type NamedPerson } from "../bot/speakers/names";
import { DOMINANT_MIN_FRACTION, DOMINANT_MIN_SECONDS, MERGE_GAP_SECONDS, MIN_SPEECH_SECONDS } from "../recording/speakerTimeline";

// Casamento "Speaker N" ↔ nome lido na chamada (spec 006, plan D3). Puro: sem banco, sem relógio, sem DOM.
// Os limiares são os iniciais do plano; a validação com reunião real (T060–T062) os calibra.

export const MATCH_THRESHOLDS = {
  /** evidência mínima do melhor nome: segundos absolutos e fração da fala do rótulo */
  minEvidenceSeconds: 2,
  minEvidenceFraction: 0.15,
  /** fração da fala do rótulo que cai sobre algum indicador */
  minCoverage: 0.3,
  /** fração do tempo coberto que vai para o melhor nome */
  minPurity: 0.6,
  /** melhor nome ÷ segundo melhor */
  minMargin: 1.5,
  /** confiança "alta" na interface; abaixo disso, "conferir" */
  highConfidence: 0.75,
  /** cobertura que dá confiança plena */
  fullCoverage: 0.6,
  /** fração do tempo da linha do tempo que precisa cair sobre fala do ASR, senão a leitura é descartada */
  minSpeechCoverage: 0.5,
  /** deslocamento de busca do indicador em relação ao áudio */
  maxSkewSeconds: 2,
  skewStepSeconds: 0.1,
  /** o melhor deslocamento precisa superar a mediana em tanto */
  skewGain: 1.15,
  skewGainOverDefault: 1.03,
  minSegmentSeconds: 0.3,
} as const;

export interface MatchSegment {
  /** "Speaker N", "Speaker N (parte i)", "user", "Remoto" ou null (sem diarização) */
  label: string | null;
  start: number;
  end: number;
}

export interface MatchInterval {
  key: string;
  name: string;
  start: number;
  end: number;
}

export interface NameDecision {
  name: string;
  key: string;
  /** 0 a 1 */
  confidence: number;
}

export type UndecidedReason = "evidence" | "coverage" | "purity" | "margin" | "no_data";

export interface MatchResult {
  names: Map<string, NameDecision>;
  /** atraso estimado do indicador em relação ao áudio (ms; positivo = indicador depois do áudio) */
  skewMs: number;
  /** fração da linha do tempo que cai sobre fala reconhecida; abaixo do mínimo, nada é aplicado */
  speechCoverage: number;
  valid: boolean;
  undecided: Record<string, UndecidedReason>;
}

export interface MatchOptions {
  /** deslocamento usado quando a estimativa por reunião não se destaca (BOT_SPEAKER_SKEW_MS) */
  defaultSkewMs?: number;
}

interface Prepared {
  segments: MatchSegment[];
  intervals: MatchInterval[];
  names: Map<string, string>;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Funde intervalos da mesma pessoa separados por menos de 0,5 s e descarta os curtos demais. */
function fuse(intervals: MatchInterval[]): MatchInterval[] {
  const byKey = new Map<string, MatchInterval[]>();
  for (const it of [...intervals].sort((a, b) => a.start - b.start)) {
    const list = byKey.get(it.key) ?? [];
    const last = list[list.length - 1];
    if (last && it.start - last.end < MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, it.end);
      last.name = it.name;
    } else {
      list.push({ ...it });
    }
    byKey.set(it.key, list);
  }
  return [...byKey.values()]
    .flat()
    .filter((it) => it.end - it.start >= MIN_SPEECH_SECONDS)
    .sort((a, b) => a.start - b.start);
}

/** Nome de cada chave: o último nome visto (o participante pode ter trocado "Convidado" pelo nome real), sem repetição entre pessoas. */
function resolveNames(intervals: MatchInterval[]): Map<string, string> {
  const people = new Map<string, NamedPerson & { lastAt: number }>();
  for (const it of intervals) {
    const p = people.get(it.key);
    if (!p) people.set(it.key, { key: it.key, name: it.name, firstAt: it.start, lastAt: it.start });
    else {
      p.firstAt = Math.min(p.firstAt, it.start);
      if (it.start >= p.lastAt) {
        p.name = it.name;
        p.lastAt = it.start;
      }
    }
  }
  return disambiguateNames([...people.values()]);
}

function prepare(segments: MatchSegment[], intervals: MatchInterval[]): Prepared {
  const fused = fuse(intervals);
  return {
    segments: segments.filter((s) => s.end - s.start >= MATCH_THRESHOLDS.minSegmentSeconds),
    intervals: fused,
    names: resolveNames(fused),
  };
}

/**
 * Quanto a linha do tempo, deslocada em `skew`, concorda com a fala: para cada segmento vale a pessoa que mais
 * o cobre. Somar a sobreposição com "qualquer pessoa" não serve: com turnos colados o tempo vaza para o vizinho
 * e a soma quase não muda com o deslocamento.
 */
function overlapScore(segments: MatchSegment[], intervals: MatchInterval[], skew: number): number {
  let score = 0;
  for (const seg of segments) {
    const byKey = new Map<string, number>();
    for (const it of intervals) {
      if (it.start - skew >= seg.end) break;
      const t = overlap(seg.start, seg.end, it.start - skew, it.end - skew);
      if (t > 0) byKey.set(it.key, (byKey.get(it.key) ?? 0) + t);
    }
    score += Math.max(0, ...byKey.values());
  }
  return score;
}

/**
 * Atraso do indicador (s) que mais alinha a linha do tempo com a fala; null quando nenhum se destaca.
 * Destaca-se se supera a mediana dos candidatos em 15% ou o atraso padrão (BOT_SPEAKER_SKEW_MS) em 3%.
 * Com vários atrasos empatados (a fala tem folga nas bordas), vale o do meio do patamar.
 */
function estimateSkew(segments: MatchSegment[], intervals: MatchInterval[], fallback: number): number | null {
  const { maxSkewSeconds, skewStepSeconds, skewGain, skewGainOverDefault } = MATCH_THRESHOLDS;
  const steps = Math.round(maxSkewSeconds / skewStepSeconds);
  const scores: { skew: number; score: number }[] = [];
  for (let i = -steps; i <= steps; i++) {
    const skew = Math.round(i * skewStepSeconds * 10) / 10;
    scores.push({ skew, score: overlapScore(segments, intervals, skew) });
  }
  const best = Math.max(...scores.map((s) => s.score));
  if (best <= 0) return null;
  const sorted = scores.map((s) => s.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const atDefault = overlapScore(segments, intervals, fallback);
  if (best < median * skewGain && best < atDefault * skewGainOverDefault) return null;
  const plateau = scores.filter((s) => s.score >= best * (1 - PLATEAU_TOLERANCE)).map((s) => s.skew);
  return plateau[Math.floor(plateau.length / 2)];
}

const PLATEAU_TOLERANCE = 1e-6;

/** Atraso estimado para a reunião, ou o padrão configurado quando a estimativa não se destaca. */
function skewFor(prepared: Prepared, opts: MatchOptions): number {
  const fallback = (opts.defaultSkewMs ?? 0) / 1000;
  return estimateSkew(prepared.segments, prepared.intervals, fallback) ?? fallback;
}

/** Fração do tempo da linha do tempo (já deslocada) que cai sobre alguma fala reconhecida. */
function speechCoverageOf(segments: MatchSegment[], intervals: MatchInterval[], skew: number): number {
  const spans = [...segments].sort((a, b) => a.start - b.start);
  const union: [number, number][] = [];
  for (const s of spans) {
    const last = union[union.length - 1];
    if (last && s.start <= last[1]) last[1] = Math.max(last[1], s.end);
    else union.push([s.start, s.end]);
  }
  let total = 0;
  let covered = 0;
  for (const it of intervals) {
    total += it.end - it.start;
    for (const [from, to] of union) {
      if (from >= it.end - skew) break;
      covered += overlap(it.start - skew, it.end - skew, from, to);
    }
  }
  return total > 0 ? covered / total : 0;
}

interface LabelStats {
  duration: number;
  covered: number;
  byKey: Map<string, number>;
}

/** Soma, por rótulo e pessoa, o tempo de sobreposição; com fala simultânea o tempo é dividido entre os ativos. */
function buildMatrix(segments: MatchSegment[], intervals: MatchInterval[], skew: number): Map<string, LabelStats> {
  const stats = new Map<string, LabelStats>();
  for (const seg of segments) {
    if (!seg.label) continue;
    const entry = stats.get(seg.label) ?? { duration: 0, covered: 0, byKey: new Map() };
    stats.set(seg.label, entry);
    entry.duration += seg.end - seg.start;
    const active = intervals
      .filter((it) => it.start - skew < seg.end && it.end - skew > seg.start)
      .map((it) => ({ key: it.key, start: Math.max(seg.start, it.start - skew), end: Math.min(seg.end, it.end - skew) }));
    const cuts = [...new Set([seg.start, seg.end, ...active.flatMap((a) => [a.start, a.end])])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [from, to] = [cuts[i], cuts[i + 1]];
      const mid = (from + to) / 2;
      const keys = new Set(active.filter((a) => a.start <= mid && a.end > mid).map((a) => a.key));
      if (!keys.size) continue;
      entry.covered += to - from;
      for (const key of keys) entry.byKey.set(key, (entry.byKey.get(key) ?? 0) + (to - from) / keys.size);
    }
  }
  return stats;
}

function decide(stats: LabelStats, names: Map<string, string>): NameDecision | UndecidedReason {
  const t = MATCH_THRESHOLDS;
  const ranked = [...stats.byKey].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "no_data";
  const [bestKey, best] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const coverage = stats.covered / stats.duration;
  const purity = best / stats.covered;
  if (best < Math.max(t.minEvidenceSeconds, t.minEvidenceFraction * stats.duration)) return "evidence";
  if (coverage < t.minCoverage) return "coverage";
  if (purity < t.minPurity) return "purity";
  if (second > 0 && best / second < t.minMargin) return "margin";
  const name = names.get(bestKey);
  if (!name) return "no_data";
  const confidence = Math.round(purity * Math.min(1, coverage / t.fullCoverage) * 100) / 100;
  return { name, key: bestKey, confidence };
}

const isReserved = (label: string) => label === USER_SPEAKER_LABEL || label === REMOTE_SPEAKER_LABEL;

/** Liga cada rótulo da diarização ao nome de maior sobreposição; sem evidência suficiente o rótulo fica como está. */
export function matchSpeakers(segments: MatchSegment[], intervals: MatchInterval[], opts: MatchOptions = {}): MatchResult {
  const prepared = prepare(segments, intervals);
  const empty: MatchResult = { names: new Map(), skewMs: opts.defaultSkewMs ?? 0, speechCoverage: 0, valid: false, undecided: {} };
  if (!prepared.intervals.length || !prepared.segments.length) return empty;

  const skew = skewFor(prepared, opts);
  const speechCoverage = speechCoverageOf(prepared.segments, prepared.intervals, skew);
  const result: MatchResult = {
    ...empty,
    skewMs: Math.round(skew * 1000),
    speechCoverage: Math.round(speechCoverage * 100) / 100,
    valid: speechCoverage >= MATCH_THRESHOLDS.minSpeechCoverage,
  };
  if (!result.valid) return result;

  const labelled = prepared.segments.filter((s) => s.label && !isReserved(s.label));
  for (const [label, stats] of buildMatrix(labelled, prepared.intervals, skew)) {
    const outcome = decide(stats, prepared.names);
    if (typeof outcome === "string") result.undecided[label] = outcome;
    else result.names.set(label, outcome);
  }
  return result;
}

export interface SegmentNameResult {
  /** índice do segmento (na lista recebida) → nome */
  names: Map<number, string>;
  skewMs: number;
  speechCoverage: number;
  valid: boolean;
}

/**
 * Modo por segmento (sem diarização): cada segmento leva o nome de quem mais falou nele, com ao menos
 * metade do tempo e 0,5 s e mais que qualquer outra pessoa. Os segmentos em `candidates` são os que
 * podem ser nomeados; `segments` inteiro serve de referência para o deslocamento e a validação.
 */
export function nameSegments(
  segments: MatchSegment[],
  candidates: number[],
  intervals: MatchInterval[],
  opts: MatchOptions = {},
): SegmentNameResult {
  const prepared = prepare(segments, intervals);
  const none: SegmentNameResult = { names: new Map(), skewMs: opts.defaultSkewMs ?? 0, speechCoverage: 0, valid: false };
  if (!prepared.intervals.length || !prepared.segments.length) return none;
  const skew = skewFor(prepared, opts);
  const speechCoverage = speechCoverageOf(prepared.segments, prepared.intervals, skew);
  const result = { ...none, skewMs: Math.round(skew * 1000), speechCoverage: Math.round(speechCoverage * 100) / 100 };
  if (speechCoverage < MATCH_THRESHOLDS.minSpeechCoverage) return result;
  const names = new Map<number, string>();
  for (const index of candidates) {
    const seg = segments[index];
    const name = dominantIn(prepared, seg.start, seg.end, skew);
    if (name) names.set(index, name);
  }
  return { ...result, valid: true, names };
}

function dominantIn(prepared: Prepared, start: number, end: number, skew: number): string | null {
  const length = end - start;
  if (length < MATCH_THRESHOLDS.minSegmentSeconds) return null;
  const time = new Map<string, number>();
  for (const it of prepared.intervals) {
    const t = overlap(start, end, it.start - skew, it.end - skew);
    if (t > 0) time.set(it.key, (time.get(it.key) ?? 0) + t);
  }
  const ranked = [...time].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [key, best] = ranked[0];
  if (best < DOMINANT_MIN_SECONDS || best < length * DOMINANT_MIN_FRACTION) return null;
  if (ranked[1] && ranked[1][1] >= best) return null;
  return prepared.names.get(key) ?? null;
}
