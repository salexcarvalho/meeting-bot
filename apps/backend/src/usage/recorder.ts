import {
  UsageCategory,
  UsageErrorCode,
  UsageProvider,
  UsagePurpose,
  type UsageCategoryValue,
  type UsageErrorCodeValue,
  type UsageProviderValue,
  type UsagePurposeValue,
} from "@meeting-bot/contracts";
import { pool } from "../db";

// Registro de uso de IA (specs/004-uso-custo/contracts/instrumentation.md). Só metadados e números:
// `UsageSample` não tem campo para texto de reunião. recordUsage nunca lança nem atrasa o chamador.

export interface UsageSample {
  category: UsageCategoryValue;
  purpose: UsagePurposeValue;
  provider: UsageProviderValue;
  model: string | null;
  meetingId: string | null;
  /** só quando não há reunião (teste, utilitário); com reunião o dono é derivado */
  userId?: string | null;
  channel?: "mic" | "remote" | "mixed" | null;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  /** exatamente o custo informado pelo provedor; nunca calculado */
  costUsd: number | null;
  durationMs: number | null;
  computeMs: number | null;
  attempts: number;
  success: boolean;
  errorCode: UsageErrorCodeValue | null;
  /** rótulo interno (ex.: "extração final 1/3"); nunca conteúdo */
  label: string | null;
}

const LABEL_MAX = 80;
const MODEL_MAX = 120;
const OWNER_TTL_MS = 60_000;
const MAX_SMALLINT = 32_767;
const PURPOSES_BY_CATEGORY: Record<UsageCategoryValue, ReadonlySet<UsagePurposeValue>> = {
  llm: new Set<UsagePurposeValue>(["ata", "adr", "itens", "resumo", "ao_vivo", "outro"]),
  asr: new Set<UsagePurposeValue>(["asr_final", "asr_ao_vivo", "outro"]),
};

const owners = new Map<string, { userId: string | null; until: number }>();

export function resetOwnerCache(): void {
  owners.clear();
}

/** Dono da reunião (`meetings.created_by`), com cache curto. Reunião inexistente = nulo. */
export async function ownerOfMeeting(meetingId: string): Promise<string | null> {
  const hit = owners.get(meetingId);
  if (hit && hit.until > Date.now()) return hit.userId;
  const { rows } = await pool.query(`SELECT created_by FROM meetings WHERE id = $1`, [meetingId]);
  const userId: string | null = rows[0]?.created_by ?? null;
  owners.set(meetingId, { userId, until: Date.now() + OWNER_TTL_MS });
  return userId;
}

function count(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function decimal(value: number | null | undefined, places: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function textOrNull(value: string | null | undefined, max: number): string | null {
  const trimmed = typeof value === "string" ? value.trim().slice(0, max) : "";
  return trimmed || null;
}

type Normalized = Omit<UsageSample, "userId" | "meetingId" | "channel"> & { channel: string | null };

/** Valida e normaliza; amostra inválida vira null (descartada com aviso, nunca grava lixo). */
export function normalizeSample(sample: UsageSample): Normalized | null {
  const category = UsageCategory.safeParse(sample.category);
  const purpose = UsagePurpose.safeParse(sample.purpose);
  const provider = UsageProvider.safeParse(sample.provider);
  if (!category.success || !purpose.success || !provider.success) return null;
  if (!PURPOSES_BY_CATEGORY[category.data].has(purpose.data)) return null;
  const isAsr = category.data === "asr";
  const code = sample.success ? null : UsageErrorCode.safeParse(sample.errorCode ?? "other");
  return {
    category: category.data,
    purpose: purpose.data,
    provider: provider.data,
    model: textOrNull(sample.model, MODEL_MAX),
    channel: sample.channel ?? null,
    inputTokens: count(sample.inputTokens),
    outputTokens: count(sample.outputTokens),
    audioSeconds: isAsr ? decimal(sample.audioSeconds, 2) : null,
    costUsd: decimal(sample.costUsd, 8),
    durationMs: count(sample.durationMs),
    computeMs: count(sample.computeMs),
    attempts: Math.min(Math.max(count(sample.attempts) ?? 1, 1), MAX_SMALLINT),
    success: sample.success,
    errorCode: code?.success ? code.data : sample.success ? null : "other",
    label: textOrNull(sample.label, LABEL_MAX),
  };
}

async function persist(sample: UsageSample, row: Normalized): Promise<void> {
  const userId = sample.meetingId ? await ownerOfMeeting(sample.meetingId) : (sample.userId ?? null);
  await pool.query(
    `INSERT INTO ai_usage_logs
       (user_id, meeting_id, category, purpose, provider, model, channel, input_tokens, output_tokens,
        audio_seconds, cost_usd, duration_ms, compute_ms, attempts, success, error_code, label)
     VALUES ($1, (SELECT id FROM meetings WHERE id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      userId,
      sample.meetingId,
      row.category,
      row.purpose,
      row.provider,
      row.model,
      row.channel,
      row.inputTokens,
      row.outputTokens,
      row.audioSeconds,
      row.costUsd,
      row.durationMs,
      row.computeMs,
      row.attempts,
      row.success,
      row.errorCode,
      row.label,
    ],
  );
}

/**
 * Registra uma chamada concluída (sucesso ou erro). Síncrona para o chamador e nunca lança:
 * a falha do registro vai para o console e não altera a geração nem a transcrição (FR-006).
 */
export function recordUsage(sample: UsageSample): void {
  try {
    const row = normalizeSample(sample);
    if (!row) {
      console.warn("[uso] amostra inválida descartada");
      return;
    }
    void persist(sample, row).catch((err) => console.error("[uso] falha ao gravar:", err));
  } catch (err) {
    console.error("[uso] falha ao registrar:", err);
  }
}
