import type { MeetingStatus } from "@meeting-bot/contracts";

// Regras puras da agenda (testadas em test/calendar-service.test.ts).

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ProjectMatcher {
  id: string;
  name: string;
  keywords: string[];
}

export function suggestProject<T extends ProjectMatcher>(title: string, projects: T[]): T | null {
  const haystack = ` ${normalizeText(title)} `;
  let best: { project: T; length: number } | null = null;
  for (const project of projects) {
    for (const term of [project.name, ...project.keywords]) {
      const needle = normalizeText(term);
      if (!needle) continue;
      if (haystack.includes(` ${needle} `) && (!best || needle.length > best.length)) {
        best = { project, length: needle.length };
      }
    }
  }
  return best?.project ?? null;
}

// Estados em que o convite ainda pode alterar a reunião.
export const EDITABLE_STATUSES: MeetingStatus[] = ["scheduled", "skipped", "missed", "cancelled"];

export type UpsertDecision = "create" | "update" | "cancel" | "unchanged" | "ignore";

export function decideUpsert(
  existing: { status: MeetingStatus; ical_sequence: number; changed: boolean } | null,
  incoming: { sequence: number; cancelled: boolean },
): UpsertDecision {
  if (!existing) return incoming.cancelled ? "ignore" : "create";
  if (!EDITABLE_STATUSES.includes(existing.status)) return "unchanged";
  if (incoming.sequence < existing.ical_sequence) return "unchanged";
  if (incoming.cancelled) return existing.status === "cancelled" ? "unchanged" : "cancel";
  if (existing.status === "cancelled") {
    return incoming.sequence > existing.ical_sequence ? "update" : "unchanged";
  }
  return existing.changed ? "update" : "unchanged";
}

function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instant.getTime();
}

// Meia-noite local (no fuso) de uma data YYYY-MM-DD, em UTC.
export function localMidnight(date: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error("Data inválida (use AAAA-MM-DD).");
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess)) throw new Error("Data inválida.");
  // Duas iterações resolvem mudanças de horário de verão.
  let ts = guess - offsetMs(new Date(guess), timeZone);
  ts = guess - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export function dayRange(date: string, timeZone: string): { start: Date; end: Date } {
  const start = localMidnight(date, timeZone);
  const [y, mo, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return { start, end: localMidnight(next, timeZone) };
}

export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}
