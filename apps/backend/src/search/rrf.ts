// Fusão de listas ordenadas por Reciprocal Rank Fusion (k = 60) e agrupamento de trechos vizinhos.
// Módulo puro.

export const RRF_K = 60;

export type MatchSource = "text" | "semantic";

export interface Fused {
  id: number;
  score: number;
  matchedBy: MatchSource[];
}

/**
 * `lists` traz os ids na ordem do melhor para o pior de cada fonte. O score de um id é a soma de
 * 1 / (k + posição), posição começando em 1. Empate: melhor posição individual, depois menor id.
 */
export function fuse(lists: Partial<Record<MatchSource, number[]>>, k = RRF_K): Fused[] {
  const acc = new Map<number, { score: number; best: number; sources: Set<MatchSource> }>();
  for (const source of ["text", "semantic"] as const) {
    const ids = lists[source] ?? [];
    ids.forEach((id, index) => {
      const rank = index + 1;
      const entry = acc.get(id) ?? { score: 0, best: Number.POSITIVE_INFINITY, sources: new Set<MatchSource>() };
      entry.score += 1 / (k + rank);
      entry.best = Math.min(entry.best, rank);
      entry.sources.add(source);
      acc.set(id, entry);
    });
  }
  return [...acc.entries()]
    .map(([id, e]) => ({ id, score: e.score, best: e.best, matchedBy: [...e.sources] }))
    .sort((a, b) => b.score - a.score || a.best - b.best || a.id - b.id)
    .map(({ id, score, matchedBy }) => ({ id, score, matchedBy }));
}

export interface Neighbor {
  id: number;
  meetingId: string;
  kind: string;
  sourceId: string;
  seq: number;
}

/**
 * Mantém o primeiro (melhor) de cada grupo de trechos vizinhos: mesma reunião, tipo e origem com
 * `seq` consecutivo (as janelas da transcrição se sobrepõem). Preserva a ordem de entrada.
 */
export function dropNeighbors<T extends Neighbor>(ordered: T[]): T[] {
  const kept: T[] = [];
  for (const hit of ordered) {
    const near = kept.some(
      (k) => k.meetingId === hit.meetingId && k.kind === hit.kind && k.sourceId === hit.sourceId && Math.abs(k.seq - hit.seq) <= 1,
    );
    if (!near) kept.push(hit);
  }
  return kept;
}
