import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TOKEN = "teste-".repeat(8);
const SOURCE = "aurora-outlook";
const DAY = "2031-03-10";
const OTHER_DAY = "2031-03-11";
// 02:30Z do dia 11 = 23:30 do dia 10 em São Paulo (UTC-3)
const NOITE = { start: "2031-03-11T02:30:00Z", end: "2031-03-11T03:00:00Z" };
const teamsLink = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;

// Agenda enviada pela Aurora (POST /api/agent/calendar/import), em nome do dono do agente.
describe.skipIf(!enabled)("importação da agenda pela Aurora (HTTP + Postgres)", async () => {
  vi.stubEnv("AGENT_OWNER", "au-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled, cancelScheduled, setSkip, importIcs } = await import("../../src/calendar/service");

  const servers: Server[] = [];
  let owner = "";
  let outro = "";

  // Cada servidor tem o próprio limite de taxa: o teste de limite não atrapalha os demais.
  async function serve(): Promise<string> {
    const server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const send = (base: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}/api/agent/calendar/import`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, json: await res.json() }));

  const hour = (day: string, h: number) => `${day}T${String(h).padStart(2, "0")}:00:00-03:00`;
  const ev = (uid: string, h: number, extra: Record<string, unknown> = {}) => ({
    uid, title: `Reunião ${uid}`, start: hour(DAY, h), end: hour(DAY, h + 1), ...extra,
  });
  const payload = (events: unknown[], date = DAY) => ({ source: SOURCE, date, events });

  // Reuniões da origem de um dia (UTC-3, sem horário de verão em 2031).
  async function auroraRows(day: string) {
    const { rows } = await pool.query(
      `SELECT id, title, status, platform, url, source, ical_uid, recurrence_key, skip_recording, extract_items,
              import_source, import_removed_at, created_by
         FROM meetings
        WHERE import_source = $1 AND scheduled_start >= $2::timestamptz AND scheduled_start < $2::timestamptz + interval '1 day'
        ORDER BY scheduled_start`,
      [SOURCE, `${day}T00:00:00-03:00`],
    );
    return rows;
  }
  const byUid = <T extends { ical_uid: string }>(rows: T[], uid: string): T => rows.find((r) => r.ical_uid === uid)!;
  const countAll = async () => (await pool.query(`SELECT count(*)::int AS n FROM meetings`)).rows[0].n as number;

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword("senha-forte-123");
    owner = (await createUser("au-dono", hash, { role: "SUPER_ADMIN" })).id;
    outro = (await createUser("au-outra", hash, { role: "USER" })).id;
    invalidateHostOwner();
  });

  afterAll(async () => {
    servers.forEach((s) => s.close());
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("sem token ou com token errado: 401, e o errado fica no audit_log", async () => {
    const base = await serve();
    const failures = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE kind = 'agent_auth_failed'`)).rows[0].n as number;
    const before = await failures();
    const total = await countAll();

    expect((await send(base, payload([ev("x", 9)]), null)).status).toBe(401);
    expect((await send(base, payload([ev("x", 9)]), "token-errado-".repeat(4))).status).toBe(401);

    await vi.waitFor(async () => expect(await failures()).toBe(before + 2));
    expect(await countAll()).toBe(total);
  });

  it("rejeita corpo inválido: mais de 100 eventos, origem desconhecida, data impossível, evento fora do dia", async () => {
    const base = await serve();
    const total = await countAll();
    const many = Array.from({ length: 101 }, (_, i) => ev(`m${i}`, 9));

    const tooMany = await send(base, payload(many));
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.json)).toMatch(/100 eventos/);
    expect((await send(base, { ...payload([]), source: "outra" })).status).toBe(400);
    expect((await send(base, payload([], "2031-02-31"))).status).toBe(400);
    expect((await send(base, { source: SOURCE, date: DAY })).status).toBe(400);

    // 02:30Z do dia 10 ainda é dia 9 em São Paulo
    const fora = await send(base, payload([ev("ok", 9), ev("fora", 9, { start: "2031-03-10T02:30:00Z", end: "2031-03-10T03:30:00Z" })]));
    expect(fora.status).toBe(400);
    expect(await countAll()).toBe(total);
  });

  it("importa no nome do dono, é idempotente e usa o fuso da aplicação para definir o dia", async () => {
    const base = await serve();
    // 02:30Z do dia 11 = 23:30 do dia 10 em São Paulo
    const lateNight = ev("noite", 23, NOITE);
    const body = payload([ev("a", 9, { teams: teamsLink("a1"), organizer: "Ana" }), ev("b", 14, { location: "Sala 3" }), lateNight]);

    const first = await send(base, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ source: SOURCE, date: DAY, created: 3, updated: 0, removed: 0, unchanged: 0 });

    const rows = await auroraRows(DAY);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.created_by === owner && r.source === "ics" && r.status === "scheduled")).toBe(true);
    expect(byUid(rows, "a")).toMatchObject({ platform: "teams", url: teamsLink("a1"), skip_recording: false, extract_items: false });
    expect(byUid(rows, "a").recurrence_key).toBe(new Date(hour(DAY, 9)).toISOString());

    const total = await countAll();
    const second = await send(base, body);
    expect(second.json).toMatchObject({ created: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(await countAll()).toBe(total);
    expect((await auroraRows(DAY)).map((r) => r.id)).toEqual(rows.map((r) => r.id));

    const audited = await pool.query(`SELECT detail, user_id FROM audit_log WHERE kind = 'agent_calendar_import' ORDER BY id DESC LIMIT 1`);
    expect(audited.rows[0].user_id).toBe(owner);
    expect(audited.rows[0].detail).toMatchObject({ source: SOURCE, date: DAY, mode: "events", unchanged: 3 });
    expect(JSON.stringify(audited.rows[0].detail)).not.toContain("Reunião");
  });

  it("reimportar atualiza dados sem desfazer o que o usuário escolheu na reunião", async () => {
    const base = await serve();
    const before = await auroraRows(DAY);
    const a = byUid(before, "a");
    await setSkip(a.id, true); // "Não gravar"
    await pool.query(`UPDATE meetings SET extract_items = true WHERE id = $1`, [a.id]);

    const res = await send(base, payload([ev("a", 9, { title: "Reunião a (renomeada)", teams: teamsLink("a1") }), ev("b", 14), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ created: 0, updated: 1 });

    const after = byUid(await auroraRows(DAY), "a");
    expect(after.id).toBe(a.id);
    expect(after.title).toBe("Reunião a (renomeada)");
    expect(after).toMatchObject({ status: "skipped", skip_recording: true, extract_items: true });
    // campos que o envio deixou vazio (local da reunião b) não são apagados
    expect(byUid(await auroraRows(DAY), "b")).toMatchObject({ title: "Reunião b" });
    const loc = await pool.query(`SELECT location FROM meetings WHERE ical_uid = 'b' AND created_by = $1`, [owner]);
    expect(loc.rows[0].location).toBe("Sala 3");
  });

  it("evento que sumiu da lista é cancelado; outro dia, reunião manual e cancelamento do usuário ficam intactos", async () => {
    const base = await serve();
    // evento de outro dia, enviado no próprio dia
    const otherDay = { uid: "outro-dia", title: "Outro dia", start: hour(OTHER_DAY, 10), end: hour(OTHER_DAY, 11) };
    expect((await send(base, payload([otherDay], OTHER_DAY))).status).toBe(200);

    const manual = await createScheduled({ title: "Manual", start: hour(DAY, 16), durationMinutes: 30, skipRecording: false }, owner);
    const before = await auroraRows(DAY);
    const b = byUid(before, "b");
    // "a" e "noite" ficam; "b" some
    const res = await send(base, payload([ev("a", 9), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ removed: 1, created: 0 });

    const after = await auroraRows(DAY);
    expect(byUid(after, "b")).toMatchObject({ id: b.id, status: "cancelled" });
    expect(byUid(after, "b").import_removed_at).not.toBeNull();
    expect(byUid(after, "a").status).toBe("skipped");
    expect(byUid(await auroraRows(OTHER_DAY), "outro-dia").status).toBe("scheduled");
    expect((await pool.query(`SELECT status FROM meetings WHERE id = $1`, [manual.id])).rows[0].status).toBe("scheduled");

    // lista vazia no dia seguinte cancela só o que é da origem naquele dia
    const empty = await send(base, payload([], OTHER_DAY));
    expect(empty.json).toMatchObject({ removed: 1 });
    expect((await pool.query(`SELECT status FROM meetings WHERE id = $1`, [manual.id])).rows[0].status).toBe("scheduled");
    expect(byUid(await auroraRows(DAY), "a").status).toBe("skipped");
  });

  it("evento que volta à lista reativa; cancelamento feito pelo usuário continua cancelado", async () => {
    const base = await serve();
    const rows = await auroraRows(DAY);
    // o usuário cancela "noite" pela interface
    await cancelScheduled(byUid(rows, "noite").id, "one");

    const res = await send(base, payload([ev("a", 9), ev("b", 14), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ created: 0, updated: 1 });

    const after = await auroraRows(DAY);
    expect(byUid(after, "b").status).toBe("scheduled");
    expect(byUid(after, "b").import_removed_at).toBeNull();
    expect(byUid(after, "a").status).toBe("skipped"); // "Não gravar" preservado
    expect(byUid(after, "noite").status).toBe("cancelled");
    expect(byUid(after, "noite").import_removed_at).toBeNull();
  });

  it("status cancelado no envio cancela o evento existente e não cria um novo", async () => {
    const base = await serve();
    const total = await countAll();
    const res = await send(base, payload([ev("a", 9, { status: "cancelled" }), ev("b", 14), ev("novo-cancelado", 18, { status: "canceled" }), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ cancelled: 1, ignored: 1, created: 0 });
    expect(await countAll()).toBe(total);
    expect(byUid(await auroraRows(DAY), "a").status).toBe("cancelled");
  });

  it("aceita .ics no lugar da lista de eventos e reconhece evento único já importado do mesmo uid", async () => {
    const base = await serve();
    const ICS_DAY = "2031-03-12";
    const ics = (uid: string, summary: string, start: string, end: string) =>
      ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//teste//PT", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:20310301T120000Z`,
        `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

    // 09:00-03:00 = 12:00Z; o .ics importado antes pela tela (chave de recorrência vazia) não pode duplicar
    const imp = await importIcs([{ name: "antes.ics", text: ics("ics-1@teste", "Do .ics", "20310312T120000Z", "20310312T130000Z") }], owner);
    expect(imp.created).toBe(1);
    const before = await countAll();
    const res = await send(base, { source: SOURCE, date: ICS_DAY, ics: ics("ics-1@teste", "Do .ics", "20310312T120000Z", "20310312T130000Z") });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: 0, removed: 0, unchanged: 1 });
    expect(await countAll()).toBe(before);

    const novo = await send(base, { source: SOURCE, date: ICS_DAY, ics: ics("ics-2@teste", "Outro .ics", "20310312T180000Z", "20310312T190000Z") });
    expect(novo.json).toMatchObject({ created: 1 });
    expect((await send(base, { source: SOURCE, date: ICS_DAY, ics: "isso não é calendário" })).status).toBe(400);

    // a reunião vinda da tela não é da origem Aurora: o envio não a cancela
    const manual = await pool.query(`SELECT status, import_source FROM meetings WHERE ical_uid = 'ics-1@teste' AND created_by = $1`, [owner]);
    expect(manual.rows[0]).toMatchObject({ status: "scheduled", import_source: null });
    await send(base, payload([], ICS_DAY));
    expect((await pool.query(`SELECT status FROM meetings WHERE ical_uid = 'ics-1@teste' AND created_by = $1`, [owner])).rows[0].status).toBe("scheduled");
  });

  it("nunca grava para outro usuário além do dono do agente", async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE import_source = $1 AND created_by <> $2`, [SOURCE, owner]);
    expect(rows[0].n).toBe(0);
    expect(outro).not.toBe(owner);
  });

  it("limita a taxa de envios", async () => {
    const base = await serve();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await send(base, payload([], "2031-04-01"))).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
