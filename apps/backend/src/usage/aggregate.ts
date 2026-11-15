import {
  USAGE_PROVIDER_LABELS,
  USAGE_PURPOSE_LABELS,
  type UsageAsrSplitValue,
  type UsageGroupValue,
  type UsagePurposeValue,
  type UsageProviderValue,
  type UsageTotalsValue,
} from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";

// Agregações sobre ai_usage_logs (alias `l`), sempre feitas no banco. A função de totais é única:
// painel do usuário e do admin usam o mesmo cálculo, então a soma dos grupos fecha com o total.

/**
 * Filtro já com os parâmetros posicionais. Todo parâmetro enviado precisa aparecer no SQL (o Postgres
 * recusa a consulta com parâmetro sem uso): por isso o fuso só entra na consulta por dia.
 */
export interface UsageScope {
  where: string;
  params: unknown[];
}

export const TOTALS_COLUMNS = `
  count(*)::bigint AS calls,
  (count(*) FILTER (WHERE NOT l.success))::bigint AS failed_calls,
  COALESCE(sum(l.input_tokens), 0)::bigint AS input_tokens,
  COALESCE(sum(l.output_tokens), 0)::bigint AS output_tokens,
  sum(l.cost_usd) AS cost_usd,
  count(l.cost_usd)::bigint AS priced_calls,
  COALESCE(sum(l.audio_seconds), 0) AS audio_seconds,
  COALESCE(sum(l.duration_ms), 0)::bigint AS duration_ms,
  sum(l.compute_ms)::bigint AS compute_ms`;

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function mapTotals(row: Row | undefined): UsageTotalsValue {
  return {
    calls: num(row?.calls),
    failedCalls: num(row?.failed_calls),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    costUsd: numOrNull(row?.cost_usd),
    pricedCalls: num(row?.priced_calls),
    audioSeconds: num(row?.audio_seconds),
    durationMs: num(row?.duration_ms),
    computeMs: numOrNull(row?.compute_ms),
  };
}

export async function totals(scope: UsageScope): Promise<UsageTotalsValue> {
  const { rows } = await pool.query(`SELECT ${TOTALS_COLUMNS} FROM ai_usage_logs l WHERE ${scope.where}`, scope.params);
  return mapTotals(rows[0]);
}

export type KeyLabel = (key: string, row: Row) => string;

interface GroupSpec {
  /** expressão SQL da chave do grupo */
  key: string;
  /** parâmetros usados só pela chave (ex.: o fuso), que viram os próximos $n */
  extraParams?: unknown[];
  /** JOIN extra (ex.: users) */
  join?: string;
  /** colunas extras exibidas só para montar o rótulo (nunca dado de reunião) */
  extra?: string;
  order: string;
  label: KeyLabel;
}

export async function grouped(scope: UsageScope, spec: GroupSpec): Promise<UsageGroupValue[]> {
  const extraColumn = spec.extra ? spec.extra + "," : "";
  const groupBy = spec.extra ? "1, 2" : "1";
  const { rows } = await pool.query(
    `SELECT ${spec.key} AS key, ${extraColumn} ${TOTALS_COLUMNS}
       FROM ai_usage_logs l ${spec.join ?? ""}
      WHERE ${scope.where}
      GROUP BY ${groupBy}
      ORDER BY ${spec.order}`,
    [...scope.params, ...(spec.extraParams ?? [])],
  );
  return rows.map((row) => {
    const key = String(row.key);
    return { key, label: spec.label(key, row), ...mapTotals(row) };
  });
}

const purposeLabel: KeyLabel = (key) => USAGE_PURPOSE_LABELS[key as UsagePurposeValue] ?? key;
const providerLabel: KeyLabel = (key) => USAGE_PROVIDER_LABELS[key as UsageProviderValue] ?? key;

export const byPurpose = (scope: UsageScope) =>
  grouped(scope, { key: "l.purpose", order: "count(*) DESC, 1", label: purposeLabel });

export const byProvider = (scope: UsageScope) =>
  grouped(scope, { key: "l.provider", order: "count(*) DESC, 1", label: providerLabel });

export const byModel = (scope: UsageScope) =>
  grouped(scope, { key: "COALESCE(l.model, '—')", order: "count(*) DESC, 1", label: (key) => key });

/** Dia no fuso da aplicação (AAAA-MM-DD); o rótulo é DD/MM. */
export const byDay = (scope: UsageScope) =>
  grouped(scope, {
    key: `to_char((l.at AT TIME ZONE $${scope.params.length + 1}::text)::date, 'YYYY-MM-DD')`,
    extraParams: [config.appTimezone],
    order: "1",
    label: (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`,
  });

/** ASR local (Whisper) × externo (Deepgram): minutos, tempo local e custo informado. */
export async function asrSplit(scope: UsageScope): Promise<UsageAsrSplitValue> {
  const { rows } = await pool.query(
    `SELECT
       (count(*) FILTER (WHERE l.provider = 'whisper'))::bigint AS local_calls,
       COALESCE(sum(l.audio_seconds) FILTER (WHERE l.provider = 'whisper'), 0) AS local_audio,
       (sum(l.compute_ms) FILTER (WHERE l.provider = 'whisper'))::bigint AS local_compute,
       (count(*) FILTER (WHERE l.provider = 'deepgram'))::bigint AS external_calls,
       COALESCE(sum(l.audio_seconds) FILTER (WHERE l.provider = 'deepgram'), 0) AS external_audio,
       sum(l.cost_usd) FILTER (WHERE l.provider = 'deepgram') AS external_cost
       FROM ai_usage_logs l
      WHERE l.category = 'asr' AND ${scope.where}`,
    scope.params,
  );
  const row = rows[0] ?? {};
  return {
    local: { audioSeconds: num(row.local_audio), computeMs: numOrNull(row.local_compute), calls: num(row.local_calls) },
    external: { audioSeconds: num(row.external_audio), costUsd: numOrNull(row.external_cost), calls: num(row.external_calls) },
  };
}
