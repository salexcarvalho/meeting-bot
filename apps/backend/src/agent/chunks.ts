import { estimateTokens } from "./prompts";

// Divide a transcrição final em janelas de ~2 000 tokens com sobreposição de 2 segmentos.

export function chunkSegments<T extends { text: string }>(segments: T[], maxTokens = 2_000, overlap = 2): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  while (start < segments.length) {
    let tokens = 0;
    let end = start;
    while (end < segments.length) {
      const t = estimateTokens(segments[end].text) + 6;
      if (end > start && tokens + t > maxTokens) break;
      tokens += t;
      end++;
    }
    chunks.push(segments.slice(start, end));
    if (end >= segments.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
