import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { detectMeetingUrl, parseIcs } from "../src/calendar/ics";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const range = { from: new Date("2026-09-15T03:00:00Z"), to: new Date("2026-10-16T03:00:00Z") };

describe("parseIcs", () => {
  it("lê convite do Outlook/Teams com fuso do Windows", () => {
    const { occurrences, ignored } = parseIcs(fixture("outlook-teams.ics"), range);
    expect(ignored).toBe(0);
    expect(occurrences).toHaveLength(1);
    const o = occurrences[0];
    expect(o.uid).toBe("040000008200E00074C5B7101A82E00800000000A1B2C3D4E5F60708");
    expect(o.recurrenceKey).toBe("");
    expect(o.title).toBe("Portal SES - integração com regulação");
    expect(o.start.toISOString()).toBe("2026-09-17T13:00:00.000Z");
    expect(o.end.toISOString()).toBe("2026-09-17T14:00:00.000Z");
    expect(o.organizer).toBe("Maria Souza");
    expect(o.attendees).toEqual([
      { name: "Sérgio Carvalho", email: "sergio@exemplo.gov.br" },
      { name: "Marcos Lima", email: "marcos@exemplo.gov.br" },
    ]);
    expect(o.url).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC123%40thread.v2/0?context=%7b%22Tid%22%3a%22t1%22%7d",
    );
    expect(o.platform).toBe("teams");
    expect(o.cancelled).toBe(false);
    expect(o.sequence).toBe(0);
    expect(o.description).toContain("Pauta: integração do Portal SES");
    expect(o.location).toBe("Reunião do Microsoft Teams");
  });

  it("expande recorrência com EXDATE e override", () => {
    const { occurrences } = parseIcs(fixture("recorrente.ics"), range);
    const starts = occurrences.map((o) => o.start.toISOString());
    expect(starts).toEqual([
      "2026-09-18T17:00:00.000Z", // override (remarcada para 14h)
      "2026-09-21T12:00:00.000Z",
      "2026-09-23T12:00:00.000Z",
      "2026-09-25T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-09-30T12:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-05T12:00:00.000Z",
    ]);
    const override = occurrences[0];
    expect(override.title).toBe("Daily InfraVision (remarcada)");
    expect(override.recurrenceKey).toBe("2026-09-18T12:00:00.000Z");
    expect(override.end.toISOString()).toBe("2026-09-18T17:30:00.000Z");
    expect(override.sequence).toBe(2);
    expect(occurrences[1].recurrenceKey).toBe("2026-09-21T12:00:00.000Z");
    expect(occurrences[1].title).toBe("Daily InfraVision");
    expect(occurrences[1].url).toBe("https://meet.google.com/abc-defg-hij");
    expect(occurrences[1].platform).toBe("meet");
    // EXDATE de 16/09 não aparece
    expect(starts).not.toContain("2026-09-16T12:00:00.000Z");
  });

  it("chave de recorrência é estável entre importações", () => {
    const a = parseIcs(fixture("recorrente.ics"), range).occurrences.map((o) => o.recurrenceKey);
    const b = parseIcs(fixture("recorrente.ics"), range).occurrences.map((o) => o.recurrenceKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("marca cancelamento (METHOD:CANCEL)", () => {
    const { occurrences } = parseIcs(fixture("cancelado.ics"), range);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].cancelled).toBe(true);
    expect(occurrences[0].uid).toBe("040000008200E00074C5B7101A82E00800000000A1B2C3D4E5F60708");
    expect(occurrences[0].recurrenceKey).toBe("");
    expect(occurrences[0].sequence).toBe(1);
  });

  it("ignora eventos de dia inteiro", () => {
    const { occurrences, ignored } = parseIcs(fixture("dia-inteiro.ics"), range);
    expect(occurrences).toHaveLength(0);
    expect(ignored).toBe(1);
  });

  it("acha link do Meet na descrição", () => {
    const { occurrences } = parseIcs(fixture("meet.ics"), range);
    expect(occurrences[0].url).toBe("https://meet.google.com/xyz-abcd-efg");
    expect(occurrences[0].organizer).toBe("joao@exemplo.com");
    expect(occurrences[0].title).toBe("Alinhamento Agenith");
  });

  it("ignora eventos antigos fora da janela", () => {
    const { occurrences, ignored } = parseIcs(fixture("outlook-teams.ics"), {
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    expect(occurrences).toHaveLength(0);
    expect(ignored).toBe(1);
  });

  it("recusa conteúdo que não é iCalendar", () => {
    expect(() => parseIcs("isto não é um convite", range)).toThrow(/não parece um arquivo de calendário/);
  });
});

describe("detectMeetingUrl", () => {
  it("prioriza Teams/Meet e ignora links comuns", () => {
    expect(detectMeetingUrl("Veja https://exemplo.com/doc e https://teams.microsoft.com/meet/123?p=abc")).toEqual({
      url: "https://teams.microsoft.com/meet/123?p=abc",
      platform: "teams",
    });
    expect(detectMeetingUrl("Zoom: https://empresa.zoom.us/j/123456789?pwd=x.")).toEqual({
      url: "https://empresa.zoom.us/j/123456789?pwd=x",
      platform: "other",
    });
    expect(detectMeetingUrl("sem link", null)).toBeNull();
    expect(detectMeetingUrl("http://teams.microsoft.com/l/meetup-join/x")).toBeNull();
  });
});

describe("scripts/fixture-ics.sh", () => {
  it("gera um convite do Teams importável que começa em N minutos", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fixture-ics-"));
    const out = path.join(dir, "convite.ics");
    execFileSync(path.join(__dirname, "../../../scripts/fixture-ics.sh"), ["20", "45", out]);
    const now = Date.now();
    const { occurrences } = parseIcs(readFileSync(out, "utf8"), {
      from: new Date(now - 86_400_000),
      to: new Date(now + 31 * 86_400_000),
    });
    rmSync(dir, { recursive: true, force: true });
    expect(occurrences).toHaveLength(1);
    const [o] = occurrences;
    expect(o.title).toContain("Portal SES");
    expect(o.platform).toBe("teams");
    expect(o.attendees).toHaveLength(2);
    const minutes = (o.start.getTime() - now) / 60_000;
    expect(minutes).toBeGreaterThan(18);
    expect(minutes).toBeLessThanOrEqual(21);
    expect((o.end.getTime() - o.start.getTime()) / 60_000).toBe(45);
  });
});
