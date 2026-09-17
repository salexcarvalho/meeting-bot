import type { ItemType, ReviewStatus } from "@meeting-bot/contracts";
import { words } from "./text";

// Deduplicação por Jaccard entre itens do mesmo tipo (contracts/llm-schemas.md §1.4).

export const DUPLICATE_THRESHOLD = 0.55;

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de da do das dos em na no nas nos por pela pelo pelas pelos para pra pro " +
    "com sem sob sobre entre ate e ou mas que se como quando onde qual quais quem ja nao sim tambem " +
    "mais menos muito muita muitos muitas pouco ser estar ter haver foi sera vai vao vamos fica ficou " +
    "deve devem precisa precisam isso isto esse essa esses essas este esta estes estas aquele aquela " +
    "ele ela eles elas nos voce voces seu sua seus suas nosso nossa lhe ao aos a sera sendo sido"
  ).split(" "),
);

export function normalizeTokens(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DedupCandidate {
  id: string;
  type: ItemType;
  description: string;
  reviewStatus: ReviewStatus;
}

export function findDuplicate<T extends DedupCandidate>(
  item: { type: ItemType; description: string },
  existing: T[],
  threshold = DUPLICATE_THRESHOLD,
): T | null {
  const tokens = normalizeTokens(item.description);
  let best: T | null = null;
  let bestScore = threshold;
  for (const e of existing) {
    if (e.type !== item.type) continue;
    const s = jaccard(tokens, normalizeTokens(e.description));
    if (s >= bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}

// Plano de criação: o que vira item novo, o que é anexado a um existente e o que é descartado
// (duplicado de rejeitado). Itens repetidos no mesmo lote se juntam ao primeiro.
export type PlanStep<I> =
  | { kind: "create"; item: I; ref: string }
  | { kind: "merge"; item: I; targetId: string }
  | { kind: "skip"; item: I; targetId: string };

export function planAiItems<I extends { type: ItemType; description: string }>(
  existing: DedupCandidate[],
  items: I[],
): PlanStep<I>[] {
  const pool: DedupCandidate[] = [...existing];
  const steps: PlanStep<I>[] = [];
  items.forEach((item, n) => {
    const dup = findDuplicate(item, pool);
    if (dup) {
      steps.push({ kind: dup.reviewStatus === "rejeitado" ? "skip" : "merge", item, targetId: dup.id });
      return;
    }
    const ref = `new:${n}`;
    pool.push({ id: ref, type: item.type, description: item.description, reviewStatus: "proposto" });
    steps.push({ kind: "create", item, ref });
  });
  return steps;
}
