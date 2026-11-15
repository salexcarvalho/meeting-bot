import type { RecurrenceRule } from "@meeting-bot/contracts";

const TZ = "America/Sao_Paulo";

const RECURRENCE_LABEL: Record<RecurrenceRule["freq"], { one: string; many: string }> = {
  daily: { one: "todo dia", many: "dias" },
  weekly: { one: "toda semana", many: "semanas" },
  monthly: { one: "todo mês", many: "meses" },
};

export function recurrenceLabel(rule: RecurrenceRule): string {
  const l = RECURRENCE_LABEL[rule.freq];
  return rule.interval > 1 ? `a cada ${rule.interval} ${l.many}` : l.one;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });
}

export function formatLongDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

// Data (YYYY-MM-DD) de hoje no fuso da aplicação.
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return dt.toISOString().slice(0, 10);
}

// Valor para <input type="datetime-local"> no fuso da aplicação.
export function toLocalInput(iso: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// "2026-09-16T10:00" no fuso da aplicação → ISO UTC.
export function fromLocalInput(value: string): string {
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const asTz = new Date(toLocalInput(new Date(guess).toISOString()) + ":00Z").getTime();
  const offset = asTz - guess;
  return new Date(guess - offset).toISOString();
}

// ---------- uso de IA (specs/004-uso-custo) ----------

const NUMBER_BR = new Intl.NumberFormat("pt-BR");
const NO_VALUE = "—";

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? NO_VALUE : NUMBER_BR.format(n);
}

/** Tokens: 950, 12,3 mil, 1,2 mi. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return NO_VALUE;
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (n >= 1000) return `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return NUMBER_BR.format(n);
}

/** USD como o provedor informou; valores pequenos ganham mais casas. Nulo nunca vira zero. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 6 : 2;
  return `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Minutos de áudio: 45 s, 12 min, 1 h 30 min. */
export function formatAudio(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return NO_VALUE;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Duração em ms: 850 ms, 4,2 s, 2 min 03 s. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return NO_VALUE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes < 60
    ? `${minutes} min ${String(total % 60).padStart(2, "0")} s`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Meses (AAAA-MM) do atual para trás, para o seletor de período. */
export function recentMonths(count: number, current = todayIso().slice(0, 7)): string[] {
  const [y, m] = current.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
