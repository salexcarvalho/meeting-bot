import type { Channel } from "@meeting-bot/contracts";

// Evidência ao vivo → segmento final (data-model.md, item_evidence).

export const REMAP_MAX_GAP_S = 10;

export interface TimedSegment {
  id: number;
  channel: Channel;
  start: number;
  end: number;
}

export function remapEvidence(
  evidence: { channel: Channel; start: number; end: number },
  finals: TimedSegment[],
): number | null {
  let best: TimedSegment | null = null;
  let bestOverlap = 0;
  let nearest: TimedSegment | null = null;
  let nearestGap = Infinity;
  for (const f of finals) {
    if (f.channel !== evidence.channel) continue;
    const overlap = Math.min(f.end, evidence.end) - Math.max(f.start, evidence.start);
    if (overlap > bestOverlap) {
      best = f;
      bestOverlap = overlap;
    } else if (overlap <= 0) {
      const gap = Math.max(f.start - evidence.end, evidence.start - f.end, 0);
      if (gap < nearestGap) {
        nearest = f;
        nearestGap = gap;
      }
    }
  }
  if (best) return best.id;
  if (nearest && nearestGap <= REMAP_MAX_GAP_S) return nearest.id;
  return null;
}
