import type {
  UsageCallsPageValue,
  UsageCallsQueryInput,
  UsageReportValue,
  UsageTopMeetingValue,
} from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";
import { asrSplit, byDay, byModel, byProvider, byPurpose, mapTotals, TOTALS_COLUMNS, totals, type UsageScope } from "./aggregate";
import { decodeCursor, encodeCursor } from "./cursor";
import type { UsagePeriod } from "./period";

// Painel do próprio usuário: TODA consulta filtra por `l.user_id = $1` (o dono da reunião no momento
// da chamada). Reunião compartilhada não entra: o custo é de quem gerou (FR-012).

const TOP_MEETINGS_LIMIT = 20;

export function userScope(userId: string, period: UsagePeriod): UsageScope {
  return {
    where: "l.user_id = $1 AND l.at >= $2 AND l.at < $3",
    params: [userId, period.from, period.to, config.appTimezone],
    tzParam: 4,
  };
}

export function retentionInfo() {
  return { usageDays: config.usageRetentionDays, auditDays: config.auditRetentionDays };
}

/** Reuniões que mais consumiram; o título só aparece para reunião do próprio usuário (segunda trava). */
async function topMeetings(scope: UsageScope): Promise<UsageTopMeetingValue[]> {
  const { rows } = await pool.query(
    `SELECT m.id AS meeting_id, m.title, ${TOTALS_COLUMNS}
       FROM ai_usage_logs l
       JOIN meetings m ON m.id = l.meeting_id AND m.created_by = $1
      WHERE ${scope.where}
      GROUP BY m.id, m.title
      ORDER BY (COALESCE(sum(l.input_tokens), 0) + COALESCE(sum(l.output_tokens), 0) + COALESCE(sum(l.audio_seconds), 0)) DESC, m.id
      LIMIT ${TOP_MEETINGS_LIMIT}`,
    scope.params,
  );
  return rows.map((row) => ({ meetingId: String(row.meeting_id), title: String(row.title), ...mapTotals(row) }));
}

export async function usageReport(userId: string, period: UsagePeriod): Promise<UsageReportValue> {
  const scope = userScope(userId, period);
  const [all, purposes, providers, models, days, asr, top] = await Promise.all([
    totals(scope),
    byPurpose(scope),
    byProvider(scope),
    byModel(scope),
    byDay(scope),
    asrSplit(scope),
    topMeetings(scope),
  ]);
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString(), month: period.month },
    totals: all,
    byPurpose: purposes,
    byProvider: providers,
    byModel: models,
    byDay: days,
    asr,
    topMeetings: top,
    retention: retentionInfo(),
  };
}

const NUMBER_OR_NULL = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Chamadas do usuário, mais recentes primeiro, paginadas por cursor (at, id). */
export async function usageCalls(userId: string, period: UsagePeriod, query: UsageCallsQueryInput): Promise<UsageCallsPageValue> {
  const params: unknown[] = [userId, period.from, period.to];
  const filters: string[] = ["l.user_id = $1", "l.at >= $2", "l.at < $3"];
  if (query.status !== "all") filters.push(query.status === "ok" ? "l.success" : "NOT l.success");
  if (query.purpose) filters.push(`l.purpose = $${params.push(query.purpose)}`);
  if (query.provider) filters.push(`l.provider = $${params.push(query.provider)}`);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw new CursorError();
  if (cursor) {
    const at = params.push(cursor.at);
    const id = params.push(cursor.id);
    filters.push(`(l.at, l.id) < ($${at}::timestamptz, $${id}::bigint)`);
  }
  const limit = params.push(query.limit + 1);
  const { rows } = await pool.query(
    `SELECT l.id, l.at, l.at::text AS at_text, l.purpose, l.provider, l.model, l.category, l.input_tokens, l.output_tokens,
            l.audio_seconds, l.cost_usd, l.duration_ms, l.compute_ms, l.attempts, l.success, l.error_code,
            m.id AS meeting_id, m.title AS meeting_title
       FROM ai_usage_logs l
       LEFT JOIN meetings m ON m.id = l.meeting_id AND m.created_by = $1
      WHERE ${filters.join(" AND ")}
      ORDER BY l.at DESC, l.id DESC
      LIMIT $${limit}`,
    params,
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: Number(r.id),
      at: (r.at as Date).toISOString(),
      purpose: r.purpose,
      provider: r.provider,
      model: r.model,
      category: r.category,
      inputTokens: NUMBER_OR_NULL(r.input_tokens),
      outputTokens: NUMBER_OR_NULL(r.output_tokens),
      audioSeconds: NUMBER_OR_NULL(r.audio_seconds),
      costUsd: NUMBER_OR_NULL(r.cost_usd),
      durationMs: NUMBER_OR_NULL(r.duration_ms),
      computeMs: NUMBER_OR_NULL(r.compute_ms),
      attempts: Number(r.attempts),
      success: Boolean(r.success),
      errorCode: r.error_code,
      meetingId: r.meeting_id ?? null,
      meetingTitle: r.meeting_title ?? null,
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(String(last.at_text), String(last.id)) : null,
  };
}

export class CursorError extends Error {
  constructor() {
    super("Cursor inválido.");
  }
}
