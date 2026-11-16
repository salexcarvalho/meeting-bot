import { describe, expect, it } from "vitest";
import { eventToOccurrence } from "../src/calendar/agentImport";
import { isLinkedManual, linkedChanges, pickCandidate, sameTitle } from "../src/calendar/match";
import { pairByTitle, type LinkedRow } from "../src/calendar/reschedule";
import type { MeetingRow } from "../src/db";

const at = (h: number, min = 0) => `2031-05-01T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`;
const occ = (title: string, h: number, min = 0, extra: Record<string, unknown> = {}) =>
  eventToOccurrence({ uid: `${title}-${h}-${min}`, title, start: at(h, min), end: at(h + 1, min), ...extra });
const row = (title: string, h: number, min = 0, extra: Partial<MeetingRow> = {}): MeetingRow =>
  ({ id: `${title}-${h}-${min}`, title, scheduled_start: new Date(at(h, min)), scheduled_end: new Date(at(h + 1, min)),
    url: null, organizer: null, location: null, source: "manual", import_source: null, ical_uid: null, ...extra }) as MeetingRow;

describe("sameTitle", () => {
  it("ignora caixa, acento e espaços repetidos", () => {
    expect(sameTitle("  Reunião   de ALINHAMENTO ", "reuniao de alinhamento")).toBe(true);
    expect(sameTitle("Reunião A", "Reunião B")).toBe(false);
    expect(sameTitle("", "  ")).toBe(false);
  });
});

describe("pickCandidate", () => {
  it("aceita até 5 minutos de diferença, nos dois sentidos, e recusa além disso", () => {
    expect(pickCandidate([row("Daily", 10, 5)], occ("Daily", 10))?.id).toBe("Daily-10-5");
    expect(pickCandidate([row("Daily", 9, 55)], occ("Daily", 10))?.id).toBe("Daily-9-55");
    expect(pickCandidate([row("Daily", 10, 6)], occ("Daily", 10))).toBeNull();
  });

  it("exige o mesmo título e escolhe a mais próxima", () => {
    expect(pickCandidate([row("Outra", 10)], occ("Daily", 10))).toBeNull();
    expect(pickCandidate([row("Daily", 10, 4), row("daily", 10, 1)], occ("Daily", 10))?.id).toBe("daily-10-1");
  });
});

describe("linkedChanges", () => {
  it("só preenche o que está vazio e remarca se passou da tolerância", () => {
    const o = occ("Daily", 10, 2, { teams: "https://teams.microsoft.com/l/meetup-join/x", organizer: "Ana", location: "Sala" });
    expect(linkedChanges(row("Daily", 10), o)).toMatchObject({ organizer: "Ana", location: "Sala", platform: "teams" });
    expect(linkedChanges(row("Daily", 10), o)).not.toHaveProperty("scheduled_start");
    const kept = linkedChanges(row("Daily", 10, 0, { url: "u", organizer: "Bia", location: "L" }), o);
    expect(kept).toEqual({});
    expect(linkedChanges(row("Daily", 15), o)).toHaveProperty("scheduled_start");
  });
});

describe("isLinkedManual", () => {
  it("só reconhece cadastro manual com a origem do envio", () => {
    expect(isLinkedManual(row("A", 9, 0, { import_source: "aurora-outlook" }), "aurora-outlook")).toBe(true);
    expect(isLinkedManual(row("A", 9, 0, { import_source: null }), "aurora-outlook")).toBe(false);
    expect(isLinkedManual(row("A", 9, 0, { source: "ics", import_source: "aurora-outlook" }), "aurora-outlook")).toBe(false);
    expect(isLinkedManual(row("A", 9, 0, { import_source: "x" }), undefined)).toBe(false);
  });
});

describe("pairByTitle", () => {
  const linked = (id: string, uid: string, title: string, h: number): LinkedRow => ({ id, uid, title, start: new Date(at(h)) });

  it("pareia linha sem evento com evento novo de mesmo título", () => {
    const pairs = pairByTitle([linked("r1", "u1", "Mentoria", 10)], [occ("mentoria", 15)], new Set());
    expect([...pairs.keys()]).toEqual(["r1"]);
    expect(pairs.get("r1")?.start.toISOString()).toBe(new Date(at(15)).toISOString());
  });

  it("não pareia quando o uid ainda está no envio, o evento já tem linha, é cancelado ou tem outro título", () => {
    const e = occ("Mentoria", 15);
    expect(pairByTitle([linked("r1", e.uid, "Mentoria", 10)], [e], new Set()).size).toBe(0);
    expect(pairByTitle([linked("r1", "u1", "Mentoria", 10)], [e], new Set([e.uid])).size).toBe(0);
    expect(pairByTitle([linked("r1", "u1", "Mentoria", 10)], [occ("Mentoria", 15, 0, { status: "cancelled" })], new Set()).size).toBe(0);
    expect(pairByTitle([linked("r1", "u1", "Mentoria", 10)], [occ("Outro", 15)], new Set()).size).toBe(0);
  });

  it("pareia em ordem de início quando há mais de uma do mesmo título", () => {
    const pairs = pairByTitle(
      [linked("r2", "u2", "Daily", 14), linked("r1", "u1", "Daily", 9)],
      [occ("Daily", 18), occ("Daily", 12)],
      new Set(),
    );
    expect(pairs.get("r1")?.start.toISOString()).toBe(new Date(at(12)).toISOString());
    expect(pairs.get("r2")?.start.toISOString()).toBe(new Date(at(18)).toISOString());
  });
});
