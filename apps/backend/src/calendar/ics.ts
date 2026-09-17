import { expandRecurringEvent, sync, type ParameterValue, type VEvent } from "node-ical";
import type { Attendee, Platform } from "@meeting-bot/contracts";

// Importação de convites .ics (Outlook/Teams/Google), research R10.

export interface Occurrence {
  uid: string;
  /** Início original da ocorrência (RECURRENCE-ID) em ISO; "" para eventos únicos. */
  recurrenceKey: string;
  sequence: number;
  title: string;
  start: Date;
  end: Date;
  organizer: string | null;
  attendees: Attendee[];
  description: string | null;
  location: string | null;
  url: string | null;
  platform: Platform;
  cancelled: boolean;
  /** Cancelamento de série inteira (sem RECURRENCE-ID). */
  cancelsSeries: boolean;
}

export interface ParseResult {
  occurrences: Occurrence[];
  ignored: number;
  /** Títulos que vieram só como ocorrência (RECURRENCE-ID sem RRULE): a série não está no arquivo. */
  partialSeries: string[];
}

const MAX_DESCRIPTION = 20_000;

export function paramValue(value: ParameterValue | undefined | null): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return typeof value.val === "string" ? value.val : String(value.val ?? "");
}

function paramCN(value: ParameterValue<string, Record<string, string>>): string | undefined {
  return typeof value === "object" && value !== null ? value.params?.CN : undefined;
}

function stripMailto(raw: string): string | null {
  const email = raw.replace(/^mailto:/i, "").trim();
  return email.includes("@") ? email : null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function attendeesOf(event: VEvent): Attendee[] {
  const raw = asArray(event.attendee as ParameterValue<string, Record<string, string>> | undefined);
  const out: Attendee[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    const email = stripMailto(paramValue(a));
    const name = (paramCN(a) ?? email ?? "").trim();
    if (!name) continue;
    const key = (email ?? name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, email });
  }
  return out.slice(0, 200);
}

function organizerOf(event: VEvent): string | null {
  const org = event.organizer as ParameterValue<string, Record<string, string>> | undefined;
  if (!org) return null;
  return paramCN(org)?.trim() || stripMailto(paramValue(org)) || null;
}

const MEETING_URL_PATTERNS: { re: RegExp; platform: Platform }[] = [
  { re: /https:\/\/teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/[^\s<>"')\]]+/i, platform: "teams" },
  { re: /https:\/\/teams\.live\.com\/meet\/[^\s<>"')\]]+/i, platform: "teams" },
  { re: /https:\/\/[a-z0-9.-]*\.teams\.microsoft\.com\/[^\s<>"')\]]+/i, platform: "teams" },
  { re: /https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}[^\s<>"')\]]*/i, platform: "meet" },
  { re: /https:\/\/[a-z0-9.-]*zoom\.us\/j\/[^\s<>"')\]]+/i, platform: "other" },
];

export function detectMeetingUrl(...texts: (string | null | undefined)[]): { url: string; platform: Platform } | null {
  for (const { re, platform } of MEETING_URL_PATTERNS) {
    for (const text of texts) {
      const match = text?.match(re);
      if (match) return { url: match[0].replace(/[.,;:]+$/, ""), platform };
    }
  }
  return null;
}

function toOccurrence(
  event: VEvent,
  start: Date,
  end: Date,
  recurrenceKey: string,
  calendarCancelled: boolean,
): Occurrence {
  const description = paramValue(event.description as ParameterValue | undefined).slice(0, MAX_DESCRIPTION) || null;
  const location = paramValue(event.location).trim() || null;
  const teamsUrl = typeof event["MICROSOFT-SKYPETEAMSMEETINGURL"] === "string"
    ? (event["MICROSOFT-SKYPETEAMSMEETINGURL"] as string)
    : null;
  const eventUrl = paramValue(event.url as ParameterValue | undefined) || null;
  const found = detectMeetingUrl(teamsUrl, eventUrl, location, description);
  const cancelled = calendarCancelled || event.status === "CANCELLED";
  return {
    uid: event.uid,
    recurrenceKey,
    sequence: Number(event.sequence ?? 0) || 0,
    title: paramValue(event.summary).trim().slice(0, 300) || "Reunião sem título",
    start,
    end,
    organizer: organizerOf(event),
    attendees: attendeesOf(event),
    description,
    location,
    url: found?.url ?? null,
    platform: found?.platform ?? "none",
    cancelled,
    cancelsSeries: cancelled && Boolean(event.rrule) && !event.recurrenceid,
  };
}

function endOf(event: VEvent, start: Date): Date {
  const end = event.end ? new Date(event.end) : new Date(start.getTime() + 60 * 60_000);
  return end > start ? end : new Date(start.getTime() + 30 * 60_000);
}

export function parseIcs(text: string, range: { from: Date; to: Date }): ParseResult {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error("O arquivo não parece um arquivo de calendário (.ics).");
  }
  const data = sync.parseICS(text);
  const calendarCancelled = String(data.vcalendar?.method ?? "").toUpperCase() === "CANCEL";
  const occurrences: Occurrence[] = [];
  const partialSeries = new Set<string>();
  let ignored = 0;

  for (const [key, component] of Object.entries(data)) {
    if (key === "vcalendar" || !component || (component as { type?: string }).type !== "VEVENT") continue;
    const event = component as VEvent;
    if (event.datetype === "date") {
      ignored++;
      continue;
    }

    if (event.rrule && !calendarCancelled && event.status !== "CANCELLED") {
      const instances = expandRecurringEvent(event, { from: range.from, to: range.to });
      if (!instances.length) ignored++;
      for (const inst of instances) {
        if (inst.isFullDay) continue;
        const source = inst.event;
        const originalStart = source.recurrenceid ? new Date(source.recurrenceid) : new Date(inst.start);
        const start = new Date(inst.start);
        const end = new Date(inst.end);
        occurrences.push(toOccurrence(source, start, end > start ? end : endOf(source, start), originalStart.toISOString(), false));
      }
      continue;
    }

    const start = new Date(event.start);
    const end = endOf(event, start);
    const cancelled = calendarCancelled || event.status === "CANCELLED";
    if (!cancelled && end < range.from) {
      ignored++;
      continue;
    }
    const recurrenceKey = event.recurrenceid ? new Date(event.recurrenceid).toISOString() : "";
    const occurrence = toOccurrence(event, start, end, recurrenceKey, calendarCancelled);
    occurrences.push(occurrence);
    // Ocorrência sem a regra de repetição: o Outlook exportou "esta ocorrência", não a série.
    if (recurrenceKey && !occurrence.cancelled) partialSeries.add(occurrence.title);

    // Arquivo só com overrides (sem a série) também traz as ocorrências alteradas.
    for (const override of Object.values(event.recurrences ?? {}) as VEvent[]) {
      if (!override.recurrenceid) continue;
      const oStart = new Date(override.start);
      const oKey = new Date(override.recurrenceid).toISOString();
      if (occurrences.some((o) => o.uid === event.uid && o.recurrenceKey === oKey)) continue;
      const extra = toOccurrence(override, oStart, endOf(override, oStart), oKey, calendarCancelled);
      occurrences.push(extra);
      if (!extra.cancelled) partialSeries.add(extra.title);
    }
  }

  occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { occurrences, ignored, partialSeries: [...partialSeries] };
}
