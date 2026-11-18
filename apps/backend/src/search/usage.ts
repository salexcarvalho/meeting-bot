import type { UsagePurposeValue } from "@meeting-bot/contracts";
import { classifyError } from "../usage/errorCode";
import { recordUsage } from "../usage/recorder";
import type { EmbedResult } from "./embedder";

// Uso de IA da busca no painel de consumo (specs/004-uso-custo). Só números e rótulos fixos,
// nunca texto de reunião, de busca ou de pergunta.

interface Common {
  model: string;
  meetingId: string | null;
  /** quem buscou; só vale quando não há reunião de origem (consulta) */
  userId: string | null;
  label: string;
  durationMs: number;
  purpose?: UsagePurposeValue;
}

export function recordEmbedUsage(common: Common, outcome: { ok: true; result: EmbedResult } | { ok: false; error: unknown }): void {
  const result = outcome.ok ? outcome.result : null;
  recordUsage({
    category: "llm",
    purpose: common.purpose ?? "busca",
    provider: "ollama",
    model: common.model,
    meetingId: common.meetingId,
    userId: common.meetingId ? null : common.userId,
    inputTokens: result?.inputTokens ?? null,
    outputTokens: null,
    audioSeconds: null,
    costUsd: null,
    durationMs: common.durationMs,
    computeMs: result?.computeMs ?? null,
    attempts: 1,
    success: outcome.ok,
    errorCode: outcome.ok ? null : classifyError(outcome.error),
    label: common.label,
  });
}
