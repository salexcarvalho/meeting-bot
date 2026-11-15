import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/types";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TOKEN = "teste-".repeat(8);
const SOURCE = "aurora-outlook";
const teams = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;
// Dias de 2033 (nenhum outro teste usa): 03/06 sexta, 04/06 sábado, 05/06 domingo, 06/06 segunda.
const SEXTA = "2033-06-03";
const SABADO = "2033-06-04";
const SEGUNDA = "2033-06-06";
const at = (day: string, hour: number, minute = 0) =>
  `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00`;

// O navegador do bot não sobe no teste: registra só o pedido.
const launches = vi.hoisted(() => [] as string[]);
vi.mock("../../src/bot/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/bot/runner")>()),
  startBot: (id: string) => {
    launches.push(id);
  },
}));

// Requisito do dono: sem agenda no fim de semana (WORKING_DAYS padrão = segunda a sexta, fuso da agenda).
describe.skipIf(!enabled)("fim de semana sem agenda (Postgres)", async () => {
  vi.stubEnv("AGENT_OWNER", "fds-dono");
  vi.stubEnv("AUTO_ASSISTANT", "true");

  const { pool, createUser, getMeeting } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled, getAgenda, setAutoOnOffDay, CalendarError } = await import("../../src/calendar/service");
  const { extendActiveSeries } = await import("../../src/calendar/seriesExtend");
  const { tickAutoAssistant } = await import("../../src/bot/autoJoin");
  const { toMeetingSummary } = await import("../../src/meetings/summary");

  let user: User;
  let server: Server;
  let base = "";

  const weekdaysOf = async (seriesId: string) =>
    (
      await pool.query(
        `SELECT DISTINCT EXTRACT(ISODOW FROM scheduled_start AT TIME ZONE 'America/Sao_Paulo')::int AS d
           FROM meetings WHERE series_id = $1 ORDER BY d`,
        [seriesId],
      )
    ).rows.map((r) => r.d as number);

  const countSeries = async (seriesId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [seriesId])).rows[0].n as number;

  const send = (body: unknown) =>
    fetch(`${base}/api/agent/calendar/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, any> }));

  const aurora = (events: unknown[], date: string) => ({ source: SOURCE, date, events });
  const ev = (uid: string, day: string, extra: Record<string, unknown> = {}) => ({
    uid, title: `Reunião ${uid}`, start: at(day, 10), end: at(day, 11), ...extra,
  });
  const rowsOf = async (uid: string) =>
    (await pool.query(`SELECT id, status FROM meetings WHERE ical_uid = $1 ORDER BY scheduled_start`, [uid])).rows;

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword("senha-forte-123");
    user = await createUser("fds-dono", hash, { role: "SUPER_ADMIN" });
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    // o teste da Aurora checa que só o dono do agente dele tem reuniões da origem: não deixa as minhas
    await pool.query(`DELETE FROM meetings WHERE created_by = $1 AND import_source IS NOT NULL`, [user.id]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("recorrência diária do cadastro manual não gera sábado nem domingo", async () => {
    const first = await createScheduled(
      {
        title: "Daily do time", start: new Date(at(SEXTA, 10)).toISOString(), durationMinutes: 30,
        skipRecording: false, recurrence: { freq: "daily", interval: 1, until: new Date(at("2033-06-16", 23)).toISOString() },
      },
      user.id,
    );
    expect(await weekdaysOf(first.series_id!)).toEqual([1, 2, 3, 4, 5]);
    expect(await countSeries(first.series_id!)).toBe(10); // 03, 06-10, 13-16
  });

  it("o job de extensão da série também pula o fim de semana e não duplica", async () => {
    const first = await createScheduled(
      {
        title: "Daily sem fim", start: new Date(at("2033-07-01", 9)).toISOString(), durationMinutes: 30,
        skipRecording: false, recurrence: { freq: "daily", interval: 1, until: null },
      },
      user.id,
    );
    const initial = await countSeries(first.series_id!);
    await extendActiveSeries(new Date(Date.parse(at("2033-07-01", 9)) + 250 * 86_400_000));
    const extended = await countSeries(first.series_id!);
    expect(extended).toBeGreaterThan(initial);
    expect(await weekdaysOf(first.series_id!)).toEqual([1, 2, 3, 4, 5]);
    await extendActiveSeries(new Date(Date.parse(at("2033-07-01", 9)) + 250 * 86_400_000));
    expect(await countSeries(first.series_id!)).toBe(extended);
  });

  it("série semanal que só cairia no sábado é recusada, sem criar nada", async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM meetings`)).rows[0].n;
    await expect(
      createScheduled(
        {
          title: "Sábado semanal", start: new Date(at(SABADO, 10)).toISOString(), durationMinutes: 30,
          skipRecording: false, recurrence: { freq: "weekly", interval: 1, until: null },
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(CalendarError);
    expect((await pool.query(`SELECT count(*)::int AS n FROM meetings`)).rows[0].n).toBe(before);
  });

  it("Aurora: ocorrência de série no sábado é ignorada e a de segunda entra", async () => {
    const serieSabado = await send(aurora([ev("serie-fds@teste", SABADO, { recurring: true })], SABADO));
    expect(serieSabado.status).toBe(200);
    expect(serieSabado.json).toMatchObject({
      created: 0, ignored: 1, removed: 0, ignoredEvents: [{ uid: "serie-fds@teste", reason: "non_working_day" }],
    });
    expect(await rowsOf("serie-fds@teste")).toHaveLength(0);

    const serieSegunda = await send(aurora([ev("serie-fds@teste", SEGUNDA, { recurring: true })], SEGUNDA));
    expect(serieSegunda.json).toMatchObject({ created: 1, ignored: 0, ignoredEvents: [] });
  });

  it("Aurora: avulsa no sábado entra; série ignorada no sábado não cancela linha já existente do mesmo uid", async () => {
    const avulsa = await send(aurora([ev("avulsa-fds@teste", SABADO)], SABADO));
    expect(avulsa.json).toMatchObject({ created: 1, ignored: 0 });

    // linha antiga de uma série no sábado (criada antes desta regra): o reenvio não a cancela nem apaga
    await pool.query(
      `INSERT INTO meetings (title, platform, status, created_by, source, scheduled_start, scheduled_end, ical_uid, recurrence_key, import_source)
       VALUES ('Série antiga', 'none', 'scheduled', $1, 'ics', $2, $3, 'serie-antiga@teste', $5, $4)`,
      [user.id, new Date(at(SABADO, 14)), new Date(at(SABADO, 15)), SOURCE, new Date(at(SABADO, 14)).toISOString()],
    );
    const antiga = ev("serie-antiga@teste", SABADO, { start: at(SABADO, 14), end: at(SABADO, 15), recurring: true });
    const resend = await send(aurora([ev("avulsa-fds@teste", SABADO), antiga], SABADO));
    expect(resend.json).toMatchObject({ created: 0, unchanged: 1, removed: 0, ignored: 1 });
    expect(await rowsOf("serie-antiga@teste")).toEqual([expect.objectContaining({ status: "scheduled" })]);
  });

  it("avulsa no sábado aparece na agenda marcada como dia sem agenda", async () => {
    const m = await createScheduled(
      { title: "Avulsa de sábado", start: new Date(at(SABADO, 10)).toISOString(), durationMinutes: 30, url: teams("agenda"), skipRecording: false },
      user.id,
    );
    expect(m.status).toBe("scheduled");
    const agenda = await getAgenda(SABADO, user);
    const found = agenda.meetings.find((x) => x.id === m.id);
    expect(found).toMatchObject({ offDay: true, autoOnOffDay: false, status: "scheduled" });
  });

  it("assistente não entra na avulsa de sábado; entra se o usuário pediu e entra normalmente na segunda", async () => {
    const sabado = await createScheduled(
      { title: "Sábado com link", start: new Date(at(SABADO, 16)).toISOString(), durationMinutes: 60, url: teams("sab"), skipRecording: false },
      user.id,
    );
    const segunda = await createScheduled(
      { title: "Segunda com link", start: new Date(at(SEGUNDA, 16)).toISOString(), durationMinutes: 60, url: teams("seg"), skipRecording: false },
      user.id,
    );

    launches.length = 0;
    await tickAutoAssistant(new Date(at(SABADO, 16, 15)));
    expect(launches).not.toContain(sabado.id);
    expect((await getMeeting(sabado.id))?.status).toBe("scheduled");

    const asked = await setAutoOnOffDay(sabado.id, true);
    expect(toMeetingSummary(asked)).toMatchObject({ offDay: true, autoOnOffDay: true });
    launches.length = 0;
    await tickAutoAssistant(new Date(at(SABADO, 16, 15)));
    expect(launches).toEqual([sabado.id]);

    launches.length = 0;
    await tickAutoAssistant(new Date(at(SEGUNDA, 16, 15)));
    expect(launches).toEqual([segunda.id]);
  });

  it("o pedido do usuário pode ser desfeito e só vale para reunião ainda por vir", async () => {
    const m = await createScheduled(
      { title: "Sábado desfeito", start: new Date(at(SABADO, 18)).toISOString(), durationMinutes: 30, url: teams("undo"), skipRecording: false },
      user.id,
    );
    expect((await setAutoOnOffDay(m.id, true)).auto_on_off_day).toBe(true);
    expect((await setAutoOnOffDay(m.id, false)).auto_on_off_day).toBe(false);
    launches.length = 0;
    await tickAutoAssistant(new Date(at(SABADO, 18, 15)));
    expect(launches).not.toContain(m.id);

    await pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [m.id]);
    await expect(setAutoOnOffDay(m.id, true)).rejects.toMatchObject({ status: 409 });
  });
});
