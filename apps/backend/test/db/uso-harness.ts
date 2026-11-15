import type { Pool } from "pg";

// Semente de linhas de uso para os testes dos painéis: insere direto em ai_usage_logs com `at` fixo,
// num mês distante (2026-01) para não se misturar com o que outros testes gravam "agora".

export interface UsageSeed {
  user?: string | null;
  meeting?: string | null;
  category?: "llm" | "asr";
  purpose?: string;
  provider?: string;
  model?: string | null;
  input?: number | null;
  output?: number | null;
  audio?: number | null;
  cost?: number | null;
  duration?: number | null;
  compute?: number | null;
  success?: boolean;
  error?: string | null;
  at: string;
}

export async function seedUsage(pool: Pool, seed: UsageSeed): Promise<number> {
  const success = seed.success ?? true;
  const category = seed.category ?? "llm";
  const { rows } = await pool.query(
    `INSERT INTO ai_usage_logs (at, user_id, meeting_id, category, purpose, provider, model, input_tokens, output_tokens,
                                audio_seconds, cost_usd, duration_ms, compute_ms, success, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      seed.at,
      seed.user ?? null,
      seed.meeting ?? null,
      category,
      seed.purpose ?? (category === "asr" ? "asr_final" : "ata"),
      seed.provider ?? (category === "asr" ? "whisper" : "openrouter"),
      seed.model ?? null,
      seed.input ?? null,
      seed.output ?? null,
      seed.audio ?? null,
      seed.cost ?? null,
      seed.duration ?? null,
      seed.compute ?? null,
      success,
      success ? null : (seed.error ?? "other"),
    ],
  );
  return Number(rows[0].id);
}

/** Todas as chaves de um JSON, em qualquer profundidade. */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

const FORBIDDEN_KEY = /^(meetingId|meeting\w*|title|participants|transcript\w*)$/i;

/** Garante que uma resposta de admin não tem chave de reunião nem os textos/ids dados. */
export function assertNoMeetingData(json: unknown, forbiddenValues: string[]): void {
  const bad = [...allKeys(json)].filter((k) => FORBIDDEN_KEY.test(k));
  if (bad.length) throw new Error(`chaves de reunião na resposta de admin: ${bad.join(", ")}`);
  const text = JSON.stringify(json);
  for (const value of forbiddenValues) if (text.includes(value)) throw new Error(`a resposta de admin contém "${value}"`);
}
