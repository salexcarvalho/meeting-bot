// Gatilhos do agente ao vivo (research.md): extrai por volume de fala ou tempo, nunca a cada frase.

export interface ExtractTrigger {
  newSegments: number;
  newSpeechSeconds: number;
  secondsSinceLastExtract: number;
}

export function shouldExtract(
  s: ExtractTrigger,
  opts: { minSpeechSeconds: number; maxIntervalSeconds: number },
): boolean {
  if (s.newSegments === 0) return false;
  return s.newSpeechSeconds >= opts.minSpeechSeconds || s.secondsSinceLastExtract >= opts.maxIntervalSeconds;
}

export interface ConsolidateTrigger {
  secondsSinceLastConsolidate: number;
  extractionsSince: number;
}

export function shouldConsolidate(s: ConsolidateTrigger, opts: { intervalSeconds: number }): boolean {
  return s.extractionsSince > 0 && s.secondsSinceLastConsolidate >= opts.intervalSeconds;
}
