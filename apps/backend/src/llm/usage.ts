import type { LlmUsageReport, LlmUsageCall, LlmUsageGroup, LlmUsageMeeting } from "@meeting-bot/contracts";
import { can, visibleMeetingsSql } from "../authz";
import { config } from "../config";
import { pool } from "../db";
import type { User } from "../types";

// Consumo de LLM lido do audit_log (kind = 'external_llm'), que já guarda modelo, provedor, tokens
// e custo de cada chamada. Só leitura: nada aqui bloqueia geração (decisão do usuário em 2026-09-17).
// A assinatura (Claude/Codex) não cobra por chamada: `cost` vem nulo e só os tokens contam.

const RECENT_LIMIT = 30;

/** Primeiro instante do mês (no fuso da aplicação) e do mês seguinte. */
export function monthRange(month: string, timezone = config.appTimezone): { from: Date; to: Date } {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("Mês inválido: use AAAA-MM.");
  const year = Number(match[1]);
  const index = Number(match[2]);
  if (index < 1 || index > 12) throw new Error("Mês inválido: use AAAA-MM.");
  const start = (y: number, m: number) => localMonthStart(y, m, timezone);
  return { from: start(year, index), to: index === 12 ? start(year + 1, 1) : start(year, index + 1) };
}

/** Meia-noite do dia 1 daquele mês no fuso pedido, em UTC. */
function localMonthStart(year: number, month: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, 1);
  // Corrige o deslocamento do fuso (duas passadas cobrem a virada de horário de verão).
  let date = new Date(guess);
  for (let i = 0; i < 2; i++) {
    const offset = timezoneOffsetMs(date, timezone);
    date = new Date(guess + offset);
  }
  return date;
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return date.getTime() - asUtc;
}

export function currentMonth(now = new Date(), timezone = config.appTimezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(now);
}

const NUMBERS = `
  COALESCE((a.detail->>'promptTokens')::bigint, 0) AS prompt_tokens,
  COALESCE((a.detail->>'completionTokens')::bigint, 0) AS completion_tokens,
  (a.detail->>'cost')::numeric AS cost,
  (a.detail->>'durationMs')::bigint AS duration_ms`;

/**
 * Só entram chamadas de reuniões que o usuário enxerga. As sem reunião (testes, uploads avulsos)
 * ficam para quem lê todas as reuniões: são da instância, não de alguém.
 */
function visibilitySql(user: User): string {
  const visible = visibleMeetingsSql(user, "m", 3);
  if (can(user, "meetings.read_all")) return `(m.id IS NULL OR ${visible})`;
  return `(m.id IS NOT NULL AND ${visible})`;
}

const BASE = `
  FROM audit_log a
  LEFT JOIN meetings m ON m.id::text = a.detail->>'meetingId'
  WHERE a.kind = 'external_llm' AND a.at >= $1 AND a.at < $2`;

function group(rows: Record<string, unknown>[], key: string): LlmUsageGroup[] {
  return rows.map((r) => ({
    key: String(r[key] ?? "—"),
    calls: Number(r.calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costUsd: r.cost === null ? null : Number(r.cost),
  }));
}

export async function llmUsage(user: User, month: string): Promise<LlmUsageReport> {
  const { from, to } = monthRange(month);
  const args = [from, to, user.id];
  const where = `${BASE} AND ${visibilitySql(user)}`;

  const totals = await pool.query(
    `SELECT count(*)::bigint AS calls,
            COALESCE(sum(COALESCE((a.detail->>'promptTokens')::bigint, 0)), 0) AS prompt_tokens,
            COALESCE(sum(COALESCE((a.detail->>'completionTokens')::bigint, 0)), 0) AS completion_tokens,
            sum((a.detail->>'cost')::numeric) AS cost
     ${where}`,
    args,
  );

  const byProvider = await pool.query(
    `SELECT COALESCE(a.detail->>'provider', 'openrouter') AS provider, count(*)::bigint AS calls,
            COALESCE(sum(COALESCE((a.detail->>'promptTokens')::bigint, 0)), 0) AS prompt_tokens,
            COALESCE(sum(COALESCE((a.detail->>'completionTokens')::bigint, 0)), 0) AS completion_tokens,
            sum((a.detail->>'cost')::numeric) AS cost
     ${where} GROUP BY 1 ORDER BY 2 DESC`,
    args,
  );

  const byModel = await pool.query(
    `SELECT COALESCE(a.detail->>'model', '—') AS model, count(*)::bigint AS calls,
            COALESCE(sum(COALESCE((a.detail->>'promptTokens')::bigint, 0)), 0) AS prompt_tokens,
            COALESCE(sum(COALESCE((a.detail->>'completionTokens')::bigint, 0)), 0) AS completion_tokens,
            sum((a.detail->>'cost')::numeric) AS cost
     ${where} GROUP BY 1 ORDER BY 2 DESC`,
    args,
  );

  const byMeeting = await pool.query(
    `SELECT m.id, m.title, count(*)::bigint AS calls,
            COALESCE(sum(COALESCE((a.detail->>'promptTokens')::bigint, 0)), 0) AS prompt_tokens,
            COALESCE(sum(COALESCE((a.detail->>'completionTokens')::bigint, 0)), 0) AS completion_tokens,
            sum((a.detail->>'cost')::numeric) AS cost
     ${where} AND m.id IS NOT NULL GROUP BY m.id, m.title
     ORDER BY sum(COALESCE((a.detail->>'promptTokens')::bigint, 0) + COALESCE((a.detail->>'completionTokens')::bigint, 0)) DESC
     LIMIT 50`,
    args,
  );

  const recent = await pool.query(
    `SELECT a.at, a.detail->>'label' AS label, COALESCE(a.detail->>'provider', 'openrouter') AS provider,
            a.detail->>'model' AS model, m.id AS meeting_id, m.title AS meeting_title, ${NUMBERS}
     ${where} ORDER BY a.at DESC LIMIT ${RECENT_LIMIT}`,
    args,
  );

  const t = totals.rows[0];
  return {
    month,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      key: "total",
      calls: Number(t.calls),
      promptTokens: Number(t.prompt_tokens),
      completionTokens: Number(t.completion_tokens),
      costUsd: t.cost === null ? null : Number(t.cost),
    },
    byProvider: group(byProvider.rows, "provider"),
    byModel: group(byModel.rows, "model"),
    byMeeting: byMeeting.rows.map(
      (r): LlmUsageMeeting => ({
        meetingId: r.id,
        title: r.title,
        calls: Number(r.calls),
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        costUsd: r.cost === null ? null : Number(r.cost),
      }),
    ),
    recent: recent.rows.map(
      (r): LlmUsageCall => ({
        at: r.at.toISOString(),
        label: r.label,
        provider: r.provider,
        model: r.model,
        meetingId: r.meeting_id,
        meetingTitle: r.meeting_title,
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        costUsd: r.cost === null ? null : Number(r.cost),
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      }),
    ),
  };
}
