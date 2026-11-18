import { describe, expect, it } from "vitest";
import { AgentMeetingsQuery } from "@meeting-bot/contracts";
import { toAgentDayMeeting, type AgentDayRow } from "../src/calendar/agentDay";

const row: AgentDayRow = {
  id: "11111111-1111-4111-8111-111111111111",
  ical_uid: "uid-1",
  title: "Reunião",
  scheduled_start: new Date("2026-11-14T12:00:00Z"),
  scheduled_end: new Date("2026-11-14T13:00:00Z"),
  url: "https://exemplo.test/sala",
  platform: "other",
  skip_recording: false,
  status: "scheduled",
  recurring: true,
};

describe("AgentMeetingsQuery", () => {
  it("date é opcional e precisa ser um dia real AAAA-MM-DD", () => {
    expect(AgentMeetingsQuery.safeParse({}).success).toBe(true);
    expect(AgentMeetingsQuery.safeParse({ date: "2026-11-14" }).success).toBe(true);
    for (const date of ["14/11/2026", "2026-02-31", "", "2026-1-1", ["2026-11-14", "2026-11-15"]]) {
      expect(AgentMeetingsQuery.safeParse({ date }).success, String(date)).toBe(false);
    }
  });
});

describe("toAgentDayMeeting", () => {
  it("converte a linha para o contrato, com datas ISO", () => {
    expect(toAgentDayMeeting(row)).toEqual({
      id: row.id, icalUid: "uid-1", title: "Reunião",
      start: "2026-11-14T12:00:00.000Z", end: "2026-11-14T13:00:00.000Z",
      url: "https://exemplo.test/sala", platform: "other", skipRecording: false, status: "scheduled", recurring: true,
    });
  });

  it("plataforma 'none' vira null e uid ausente fica null", () => {
    expect(toAgentDayMeeting({ ...row, platform: "none", url: null, ical_uid: null })).toMatchObject({
      platform: null, url: null, icalUid: null,
    });
  });
});
