import { pool } from "../db";

// Incorpora uma única vez o histórico de envios externos do audit_log (formato antigo, sem `purpose`)
// em ai_usage_logs. Idempotente: `audit_log_id` é único, então rodar de novo não duplica nada.
// Linhas novas do audit_log já trazem `purpose` e NÃO são incorporadas (o registro de uso as gera).

const MEETING_UUID = `CASE WHEN a.detail->>'meetingId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN (a.detail->>'meetingId')::uuid END`;

const NON_NEGATIVE = (expr: string, cast: string) => `CASE WHEN (${expr})::numeric >= 0 THEN (${expr})::${cast} END`;

const LLM_PURPOSE = `CASE
    WHEN a.detail->>'label' LIKE 'extração final%' OR a.detail->>'label' LIKE 'consolidação final%' THEN 'itens'
    WHEN a.detail->>'label' LIKE 'narrativa%' THEN 'ata'
    WHEN a.detail->>'label' LIKE 'resumo%' THEN 'resumo'
    WHEN a.detail->>'label' LIKE 'ADR%' THEN 'adr'
    ELSE 'outro' END`;

const BASE_JOIN = `FROM audit_log a
  LEFT JOIN meetings m ON m.id = ${MEETING_UUID}
  WHERE NOT (a.detail ? 'purpose')`;

const INSERT_COLUMNS = `(at, user_id, meeting_id, category, purpose, provider, model, channel, input_tokens, output_tokens,
   audio_seconds, cost_usd, duration_ms, attempts, success, label, source, audit_log_id)`;

const ON_CONFLICT = `ON CONFLICT (audit_log_id) WHERE audit_log_id IS NOT NULL DO NOTHING`;

const LLM_BACKFILL = `
  INSERT INTO ai_usage_logs ${INSERT_COLUMNS}
  SELECT a.at, COALESCE(a.user_id, m.created_by), m.id, 'llm', ${LLM_PURPOSE},
         CASE WHEN a.detail->>'provider' IN ('openrouter', 'claude', 'codex') THEN a.detail->>'provider' ELSE 'openrouter' END,
         left(a.detail->>'model', 120), NULL,
         ${NON_NEGATIVE("a.detail->>'promptTokens'", "bigint")}, ${NON_NEGATIVE("a.detail->>'completionTokens'", "bigint")},
         NULL, ${NON_NEGATIVE("a.detail->>'cost'", "numeric")}, ${NON_NEGATIVE("a.detail->>'durationMs'", "integer")},
         1, true, left(a.detail->>'label', 80), 'audit_backfill', a.id
  ${BASE_JOIN} AND a.kind = 'external_llm'
  ${ON_CONFLICT}`;

const ASR_BACKFILL = `
  INSERT INTO ai_usage_logs ${INSERT_COLUMNS}
  SELECT a.at, COALESCE(a.user_id, m.created_by), m.id, 'asr', 'asr_final', 'deepgram', left(a.detail->>'model', 120),
         CASE WHEN a.detail->>'channel' IN ('mic', 'remote', 'mixed') THEN a.detail->>'channel' END,
         NULL, NULL, ${NON_NEGATIVE("a.detail->>'seconds'", "numeric(12,2)")}, NULL, NULL, 1, true, NULL, 'audit_backfill', a.id
  ${BASE_JOIN} AND a.kind = 'external_asr'
  ${ON_CONFLICT}`;

/** Devolve quantas linhas novas entraram (0 na segunda execução). */
export async function backfillUsageFromAudit(): Promise<number> {
  const llm = await pool.query(LLM_BACKFILL);
  const asr = await pool.query(ASR_BACKFILL);
  return (llm.rowCount ?? 0) + (asr.rowCount ?? 0);
}
