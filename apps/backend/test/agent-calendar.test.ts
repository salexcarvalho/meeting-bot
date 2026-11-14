import { describe, expect, it } from "vitest";
import { AgentCalendarImportInput } from "@meeting-bot/contracts";
import { eventToOccurrence } from "../src/calendar/agentImport";

const base = { source: "aurora-outlook", date: "2026-11-14" };
const event = (uid: string) => ({
  uid, title: `Reunião ${uid}`, start: "2026-11-14T09:00:00-03:00", end: "2026-11-14T10:00:00-03:00",
});

describe("AgentCalendarImportInput", () => {
  it("aceita eventos ou .ics, nunca os dois nem nenhum", () => {
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [event("a")] }).success).toBe(true);
    expect(AgentCalendarImportInput.safeParse({ ...base, ics: "BEGIN:VCALENDAR" }).success).toBe(true);
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [], ics: "x" }).success).toBe(false);
    expect(AgentCalendarImportInput.safeParse(base).success).toBe(false);
  });

  it("limita a 100 eventos", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => event(`u${i}`));
    expect(AgentCalendarImportInput.safeParse({ ...base, events: many(100) }).success).toBe(true);
    const over = AgentCalendarImportInput.safeParse({ ...base, events: many(101) });
    expect(over.success).toBe(false);
  });

  it("exige origem conhecida, data real e horário com fuso", () => {
    expect(AgentCalendarImportInput.safeParse({ ...base, source: "outra", events: [] }).success).toBe(false);
    expect(AgentCalendarImportInput.safeParse({ ...base, date: "2026-02-31", events: [] }).success).toBe(false);
    expect(AgentCalendarImportInput.safeParse({ ...base, date: "14/11/2026", events: [] }).success).toBe(false);
    const naive = { ...event("a"), start: "2026-11-14T09:00:00" };
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [naive] }).success).toBe(false);
  });

  it("limita o tamanho do .ics", () => {
    expect(AgentCalendarImportInput.safeParse({ ...base, ics: "x".repeat(150_000) }).success).toBe(true);
    expect(AgentCalendarImportInput.safeParse({ ...base, ics: "x".repeat(150_001) }).success).toBe(false);
  });

  it("confirmEmpty é opcional e booleano", () => {
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [] }).success).toBe(true);
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [], confirmEmpty: true }).success).toBe(true);
    expect(AgentCalendarImportInput.safeParse({ ...base, events: [], confirmEmpty: "sim" }).success).toBe(false);
  });
});

describe("eventToOccurrence", () => {
  it("evento único usa chave vazia (igual ao .ics); ocorrência de série usa o início", () => {
    expect(eventToOccurrence(event("a")).recurrenceKey).toBe("");
    expect(eventToOccurrence({ ...event("a"), recurring: false }).recurrenceKey).toBe("");
    expect(eventToOccurrence({ ...event("a"), recurring: true }).recurrenceKey).toBe("2026-11-14T12:00:00.000Z");
  });

  it("reconhece o link do Teams e normaliza o organizador", () => {
    const link = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";
    const o = eventToOccurrence({ ...event("abc"), teams: link, organizer: " Ana " });
    expect(o).toMatchObject({ uid: "abc", platform: "teams", url: link, organizer: "Ana", cancelled: false, sequence: 0 });
  });

  it("link https desconhecido vira 'other'; http e lixo são ignorados", () => {
    expect(eventToOccurrence({ ...event("a"), teams: "https://exemplo.test/sala" })).toMatchObject({ platform: "other" });
    expect(eventToOccurrence({ ...event("a"), teams: "http://exemplo.test/sala" })).toMatchObject({ url: null, platform: "none" });
    expect(eventToOccurrence({ ...event("a"), teams: "não é link" })).toMatchObject({ url: null, platform: "none" });
  });

  it("status cancelado, título vazio e fim inválido", () => {
    expect(eventToOccurrence({ ...event("a"), status: "Cancelled" }).cancelled).toBe(true);
    expect(eventToOccurrence({ ...event("a"), status: "canceled" }).cancelled).toBe(true);
    expect(eventToOccurrence({ ...event("a"), status: "tentative" }).cancelled).toBe(false);
    const o = eventToOccurrence({ ...event("a"), title: "", end: "2026-11-14T08:00:00-03:00" });
    expect(o.title).toBe("Reunião sem título");
    expect(o.end.getTime() - o.start.getTime()).toBe(30 * 60_000);
  });
});
