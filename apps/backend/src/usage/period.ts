import { USAGE_MAX_WINDOW_MONTHS, UsagePeriodQuery } from "@meeting-bot/contracts";
import { config } from "../config";

// Período dos painéis de uso e da auditoria: mês (AAAA-MM) ou intervalo livre, sempre no fuso da
// aplicação (APP_TIMEZONE). Janela máxima de 24 meses.

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

export class PeriodError extends Error {}

export interface UsagePeriod {
  from: Date;
  to: Date;
  /** AAAA-MM quando a consulta foi por mês; null no intervalo livre */
  month: string | null;
}

const DAY_MS = 86_400_000;
// 24 meses podem ter até 731 dias; folga de 1 dia para o fuso.
const MAX_WINDOW_MS = Math.ceil((USAGE_MAX_WINDOW_MONTHS * 365.25 + 1) * DAY_MS);

/** Valida e resolve `month` ou `from`/`to` (sem nada = mês corrente). */
export function resolvePeriod(query: Record<string, unknown>, now = new Date(), timezone = config.appTimezone): UsagePeriod {
  const parsed = UsagePeriodQuery.safeParse({
    month: typeof query.month === "string" ? query.month : undefined,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
  });
  if (!parsed.success) throw new PeriodError("Período inválido: use month=AAAA-MM ou from e to em ISO 8601.");
  const { month, from, to } = parsed.data;
  if (from !== undefined && to !== undefined) {
    const start = new Date(from);
    const end = new Date(to);
    if (end <= start) throw new PeriodError("Período inválido: to precisa ser depois de from.");
    if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
      throw new PeriodError(`Período inválido: a janela máxima é de ${USAGE_MAX_WINDOW_MONTHS} meses.`);
    }
    return { from: start, to: end, month: null };
  }
  const chosen = month ?? currentMonth(now, timezone);
  return { ...monthRange(chosen, timezone), month: chosen };
}
