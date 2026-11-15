import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../src/calendar/ics";
import { autoSuppressed } from "../src/calendar/offDay";
import { generateOccurrenceStarts } from "../src/calendar/service";
import { DEFAULT_WORKING_DAYS, isoWeekday, isWorkingDay, parseWorkingDays } from "../src/calendar/workingDays";

const TZ = "America/Sao_Paulo";
const BRT_WEEKDAYS = [1, 2, 3, 4, 5];
const worksOnWeekdays = (d: Date) => isWorkingDay(d, DEFAULT_WORKING_DAYS, TZ);
const isoDays = (dates: Date[]) => dates.map((d) => isoWeekday(d, TZ));

describe("parseWorkingDays", () => {
  it("vazio ou ausente = segunda a sexta", () => {
    expect(parseWorkingDays(undefined)).toEqual([1, 2, 3, 4, 5]);
    expect(parseWorkingDays("  ")).toEqual([1, 2, 3, 4, 5]);
  });

  it("aceita lista ISO com espaços, ordena e tira repetidos", () => {
    expect(parseWorkingDays("6, 1,2,2 ,3")).toEqual([1, 2, 3, 6]);
    expect(parseWorkingDays("1,2,3,4,5,6,7")).toHaveLength(7);
  });

  it.each(["0", "8", "seg,ter", "1,,2", "1;2", "-1", "1.5"])("recusa %j", (raw) => {
    expect(() => parseWorkingDays(raw)).toThrow(/WORKING_DAYS inválido/);
  });
});

describe("dia da semana no fuso da agenda", () => {
  it("domingo 23h30 em Brasília já é segunda em UTC, mas continua domingo na agenda", () => {
    const domingoNoite = new Date("2026-11-16T02:30:00Z"); // 15/11 (domingo) 23:30 BRT
    expect(domingoNoite.getUTCDay()).toBe(1);
    expect(isoWeekday(domingoNoite, TZ)).toBe(7);
    expect(isWorkingDay(domingoNoite, DEFAULT_WORKING_DAYS, TZ)).toBe(false);
  });

  it("sexta 21h em Brasília já é sábado em UTC, mas continua dia útil na agenda", () => {
    const sextaNoite = new Date("2026-11-14T00:30:00Z"); // 13/11 (sexta) 21:30 BRT
    expect(sextaNoite.getUTCDay()).toBe(6);
    expect(isoWeekday(sextaNoite, TZ)).toBe(5);
    expect(isWorkingDay(sextaNoite, DEFAULT_WORKING_DAYS, TZ)).toBe(true);
  });

  it("sábado e domingo ficam de fora do padrão; WORKING_DAYS custom pode incluir o sábado", () => {
    const sabado = new Date("2026-11-14T15:00:00Z");
    const domingo = new Date("2026-11-15T15:00:00Z");
    expect(isWorkingDay(sabado, DEFAULT_WORKING_DAYS, TZ)).toBe(false);
    expect(isWorkingDay(domingo, DEFAULT_WORKING_DAYS, TZ)).toBe(false);
    expect(isWorkingDay(sabado, [1, 2, 3, 4, 5, 6], TZ)).toBe(true);
    expect(isWorkingDay(domingo, [1, 2, 3, 4, 5, 6], TZ)).toBe(false);
  });

  it("o fuso muda o dia: segunda 01h em Tóquio ainda é domingo em Brasília", () => {
    const instant = new Date("2026-11-15T16:00:00Z");
    expect(isoWeekday(instant, "Asia/Tokyo")).toBe(1);
    expect(isoWeekday(instant, TZ)).toBe(7);
  });
});

describe("recorrência manual não se espalha pelo fim de semana", () => {
  const horizon = new Date("2026-12-31T00:00:00Z");
  const friday = new Date("2026-11-13T13:00:00Z"); // sexta 10h BRT

  it("diária pula sábado e domingo", () => {
    const starts = generateOccurrenceStarts(friday, { freq: "daily", interval: 1 }, new Date("2026-11-24T00:00:00Z"));
    expect(isoDays(starts)).toEqual([5, 1, 2, 3, 4, 5, 1]);
    expect(starts.every(worksOnWeekdays)).toBe(true);
  });

  it("começar no sábado descarta a primeira ocorrência e segue pelos dias úteis", () => {
    const saturday = new Date("2026-11-14T13:00:00Z");
    const starts = generateOccurrenceStarts(saturday, { freq: "daily", interval: 1 }, new Date("2026-11-18T00:00:00Z"));
    expect(starts.map((d) => d.toISOString())).toEqual([
      "2026-11-16T13:00:00.000Z",
      "2026-11-17T13:00:00.000Z",
    ]);
  });

  it("semanal em dia útil não muda; semanal no sábado não gera nada e avisa", () => {
    const weekly = generateOccurrenceStarts(friday, { freq: "weekly", interval: 1 }, horizon, worksOnWeekdays);
    expect(weekly).toHaveLength(7);
    expect(new Set(isoDays(weekly))).toEqual(new Set([5]));
    const saturday = new Date("2026-11-14T13:00:00Z");
    expect(() => generateOccurrenceStarts(saturday, { freq: "weekly", interval: 1 }, horizon, worksOnWeekdays)).toThrow(
      /sem agenda/,
    );
  });

  it("WORKING_DAYS custom com sábado mantém o sábado", () => {
    const withSaturday = (d: Date) => isWorkingDay(d, [1, 2, 3, 4, 5, 6], TZ);
    const starts = generateOccurrenceStarts(friday, { freq: "daily", interval: 1 }, new Date("2026-11-19T00:00:00Z"), withSaturday);
    expect(isoDays(starts)).toEqual([5, 6, 1, 2, 3]);
  });

  it("o dia útil vale no fuso da agenda: domingo 23h30 BRT não entra, mesmo sendo segunda em UTC", () => {
    const domingoNoite = new Date("2026-11-16T02:30:00Z");
    const starts = generateOccurrenceStarts(domingoNoite, { freq: "daily", interval: 1 }, new Date("2026-11-18T05:00:00Z"));
    expect(starts.map((d) => d.toISOString())).toEqual(["2026-11-17T02:30:00.000Z", "2026-11-18T02:30:00.000Z"]);
  });
});

const ICS_HEAD = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//teste//PT"];
const range = { from: new Date("2026-09-13T03:00:00Z"), to: new Date("2026-09-24T03:00:00Z") };

function dailyIcs(extra: string[] = []): string {
  return [
    ...ICS_HEAD,
    "BEGIN:VEVENT", "UID:daily@teste", "DTSTAMP:20260901T120000Z",
    "DTSTART:20260914T130000Z", "DTEND:20260914T133000Z", "RRULE:FREQ=DAILY;COUNT=10", "SUMMARY:Daily",
    "END:VEVENT",
    ...extra,
    "END:VCALENDAR", "",
  ].join("\r\n");
}

describe("RRULE do .ics não gera sábado nem domingo", () => {
  it("diária: só segunda a sexta, e o uid fica marcado para nunca causar remoção", () => {
    const { occurrences, ignored, offDayUids } = parseIcs(dailyIcs(), range, worksOnWeekdays);
    expect(isoDays(occurrences.map((o) => o.start))).toEqual([1, 2, 3, 4, 5, 1, 2, 3]);
    expect(ignored).toBe(2);
    expect(offDayUids).toEqual(["daily@teste"]);
  });

  it("sem o filtro (uso fora da agenda) todas as ocorrências vêm", () => {
    expect(parseIcs(dailyIcs(), range).occurrences).toHaveLength(10);
  });

  it("ocorrência que o organizador remarcou para o sábado é mantida (escolha explícita), sem automação", () => {
    const override = [
      "BEGIN:VEVENT", "UID:daily@teste", "DTSTAMP:20260901T120000Z", "RECURRENCE-ID:20260916T130000Z",
      "DTSTART:20260919T130000Z", "DTEND:20260919T133000Z", "SUMMARY:Daily extra", "END:VEVENT",
    ];
    const { occurrences } = parseIcs(dailyIcs(override), range, worksOnWeekdays);
    const saturday = occurrences.find((o) => o.start.toISOString() === "2026-09-19T13:00:00.000Z");
    expect(saturday?.title).toBe("Daily extra");
    expect(autoSuppressed(saturday!.start, false)).toBe(true);
  });

  it("evento avulso no sábado é importado normalmente", () => {
    const single = [
      ...ICS_HEAD, "BEGIN:VEVENT", "UID:avulso@teste", "DTSTAMP:20260901T120000Z",
      "DTSTART:20260919T130000Z", "DTEND:20260919T140000Z", "SUMMARY:Avulsa de sábado", "END:VEVENT",
      "END:VCALENDAR", "",
    ].join("\r\n");
    const { occurrences, offDayUids } = parseIcs(single, range, worksOnWeekdays);
    expect(occurrences).toHaveLength(1);
    expect(offDayUids).toEqual([]);
  });
});

describe("autoSuppressed (sem lembrete nem entrada automática)", () => {
  const sabado = new Date("2026-11-14T13:00:00Z");
  const segunda = new Date("2026-11-16T13:00:00Z");

  it("avulsa no fim de semana é suprimida; o pedido do usuário liga de novo", () => {
    expect(autoSuppressed(sabado, false)).toBe(true);
    expect(autoSuppressed(sabado, true)).toBe(false);
  });

  it("dia útil nunca é suprimido; sem horário também não", () => {
    expect(autoSuppressed(segunda, false)).toBe(false);
    expect(autoSuppressed(null, false)).toBe(false);
  });

  it("domingo 23h30 em Brasília é suprimido, mesmo sendo segunda em UTC", () => {
    expect(autoSuppressed(new Date("2026-11-16T02:30:00Z"), false)).toBe(true);
  });

  it("segunda 00h30 em Brasília (= segunda 03h30 UTC) é dia útil", () => {
    expect(autoSuppressed(new Date("2026-11-16T03:30:00Z"), false)).toBe(false);
  });
});

describe("WORKING_DAYS no ambiente", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("incluir o sábado libera a automação nele e continua suprimindo o domingo", async () => {
    vi.stubEnv("WORKING_DAYS", "1,2,3,4,5,6");
    vi.resetModules();
    const { autoSuppressed: custom } = await import("../src/calendar/offDay");
    const { config } = await import("../src/config");
    expect(config.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(custom(new Date("2026-11-14T13:00:00Z"), false)).toBe(false);
    expect(custom(new Date("2026-11-15T13:00:00Z"), false)).toBe(true);
  });

  it("valor inválido derruba a configuração com mensagem clara", async () => {
    vi.stubEnv("WORKING_DAYS", "seg,ter");
    vi.resetModules();
    await expect(import("../src/config")).rejects.toThrow(/WORKING_DAYS inválido/);
  });

  it("sem a variável vale segunda a sexta", async () => {
    vi.stubEnv("WORKING_DAYS", "");
    vi.resetModules();
    const { config } = await import("../src/config");
    expect(config.workingDays).toEqual(BRT_WEEKDAYS);
  });
});
