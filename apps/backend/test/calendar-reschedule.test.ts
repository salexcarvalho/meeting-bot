import { describe, expect, it } from "vitest";
import { eventToOccurrence } from "../src/calendar/agentImport";
import { pairByUid, type DayRow } from "../src/calendar/reschedule";

const at = (h: number) => `2031-05-01T${String(h).padStart(2, "0")}:00:00Z`;
const serie = (uid: string, h: number, extra: Record<string, unknown> = {}) =>
  eventToOccurrence({ uid, title: uid, start: at(h), end: at(h + 1), recurring: true, ...extra });
const row = (id: string, uid: string, h: number, movable = true): DayRow => ({
  id, uid, key: new Date(at(h)).toISOString(), start: new Date(at(h)), movable,
});

describe("pairByUid (remarcação no mesmo dia)", () => {
  it("pareia linha sem evento com evento sem linha", () => {
    expect([...pairByUid([row("r1", "u", 10)], [serie("u", 15)])]).toEqual([["r1", new Date(at(15)).toISOString()]]);
  });

  it("não pareia quando a linha ainda casa com um evento enviado", () => {
    expect(pairByUid([row("r1", "u", 10)], [serie("u", 10)]).size).toBe(0);
  });

  it("pareia em ordem de início e sobra evento sem linha", () => {
    const pairs = pairByUid([row("r2", "u", 11), row("r1", "u", 9)].sort((a, b) => a.start.getTime() - b.start.getTime()), [
      serie("u", 18), serie("u", 13), serie("u", 16),
    ]);
    expect(pairs.get("r1")).toBe(new Date(at(13)).toISOString());
    expect(pairs.get("r2")).toBe(new Date(at(16)).toISOString());
    expect(pairs.size).toBe(2);
  });

  it("não move linha não movível, de outro uid, nem evento cancelado ou único", () => {
    expect(pairByUid([row("r1", "u", 10, false)], [serie("u", 15)]).size).toBe(0);
    expect(pairByUid([row("r1", "u", 10)], [serie("outro", 15)]).size).toBe(0);
    expect(pairByUid([row("r1", "u", 10)], [serie("u", 15, { status: "cancelled" })]).size).toBe(0);
    expect(pairByUid([row("r1", "u", 10)], [serie("u", 15, { recurring: false })]).size).toBe(0);
  });
});
