import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TOKEN = "teste-".repeat(8);
const SOURCE = "aurora-outlook";
const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_casa%40thread.v2/0";

// Importação da Aurora casa o evento com a reunião que o usuário já tinha (cadastro manual ou .ics), sem duplicar.
describe.skipIf(!enabled)("importação da agenda casa com cadastro existente (HTTP + Postgres)", async () => {
  vi.stubEnv("AGENT_OWNER", "ca-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled, cancelScheduled, importIcs } = await import("../../src/calendar/service");

  const servers: Server[] = [];
  let base = "";
  let sent = 0;
  let owner = "";
  let outro = "";

  // Hora local de São Paulo (UTC-3, sem horário de verão em 2031) com minutos.
  const at = (day: string, h: number, min = 0) =>
    `${day}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-03:00`;
  const ev = (uid: string, title: string, day: string, h: number, min = 0, extra: Record<string, unknown> = {}) => ({
    uid, title, start: at(day, h, min), end: at(day, h + 1, min), ...extra,
  });
  // Limite de 10 envios por minuto por servidor: cada servidor atende poucos envios.
  async function serve(): Promise<void> {
    const server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    servers.push(server);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sent = 0;
  }
  const send = async (day: string, events: unknown[]) => {
    if (sent++ >= 8) await serve();
    return fetch(`${base}/api/agent/calendar/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ source: SOURCE, date: day, events }),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, number> }));
  };
  const manual = (title: string, day: string, h: number, extra: Record<string, unknown> = {}) =>
    createScheduled({ title, start: at(day, h), durationMinutes: 60, skipRecording: false, ...extra }, owner);
  const rows = async (day: string) =>
    (await pool.query(
      `SELECT id, title, status, url, source, ical_uid, recurrence_key, skip_recording, series_id, import_source,
              import_removed_at, scheduled_start
         FROM meetings WHERE created_by = $1 AND scheduled_start >= $2::timestamptz
          AND scheduled_start < $2::timestamptz + interval '1 day' ORDER BY scheduled_start, id`,
      [owner, `${day}T00:00:00-03:00`],
    )).rows;
  const one = async (id: string) => (await pool.query(`SELECT * FROM meetings WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword("senha-forte-123");
    owner = (await createUser("ca-dono", hash, { role: "SUPER_ADMIN" })).id;
    outro = (await createUser("ca-outra", hash, { role: "USER" })).id;
    invalidateHostOwner();
    await serve();
  });

  afterAll(async () => {
    servers.forEach((s) => s.close());
    // Banco compartilhado com os demais arquivos de agenda (mesma origem, outro dono): não deixa reuniões para trás.
    await pool.query(`DELETE FROM meetings WHERE created_by = ANY($1::uuid[])`, [[owner, outro]]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("casa com cadastro manual: vincula o uid, preserva as escolhas do usuário e não duplica", async () => {
    const day = "2031-04-14";
    const m = await manual("Alinhamento Semanal", day, 10, { skipRecording: true, url: TEAMS });
    await pool.query(`UPDATE meetings SET series_id = gen_random_uuid() WHERE id = $1`, [m.id]);
    const semLink = await manual("Revisão de Backlog", day, 14);
    const before = (await rows(day)).length;

    // título com caixa, acento e espaços diferentes; início 3 min depois; o evento traz outro link
    const body = [
      ev("hash-a", "  alinhamento   SEMANAL ", day, 10, 3, { teams: "https://teams.microsoft.com/l/meetup-join/outro" }),
      ev("hash-b", "revisao de backlog", day, 14, 0, { teams: TEAMS, organizer: "Ana", location: "Sala 2" }),
    ];
    const first = await send(day, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ created: 0, updated: 2, removed: 0 });
    expect(await rows(day)).toHaveLength(before);

    const a = await one(m.id);
    expect(a).toMatchObject({
      ical_uid: "hash-a", import_source: SOURCE, title: "Alinhamento Semanal", status: "skipped",
      skip_recording: true, url: TEAMS, source: "manual",
    });
    expect(a.series_id).not.toBeNull();
    expect(a.scheduled_start.toISOString()).toBe(new Date(at(day, 10)).toISOString());

    // campos vazios são preenchidos
    expect(await one(semLink.id)).toMatchObject({ url: expect.stringContaining("teams.microsoft.com"), organizer: "Ana", location: "Sala 2" });

    // reimportação: idempotente, nada criado nem alterado
    const second = await send(day, body);
    expect(second.json).toMatchObject({ created: 0, updated: 0, unchanged: 2, removed: 0 });
    expect(await rows(day)).toHaveLength(before);
    expect(await one(m.id)).toMatchObject({ title: "Alinhamento Semanal", status: "skipped", url: TEAMS });

    // sumir da lista não cancela o cadastro do usuário
    const gone = await send(day, [ev("hash-c", "Outra coisa", day, 17)]);
    expect(gone.json).toMatchObject({ created: 1, removed: 0 });
    expect(await one(m.id)).toMatchObject({ status: "skipped", import_removed_at: null });
    expect(await one(semLink.id)).toMatchObject({ status: "scheduled", import_removed_at: null });
  });

  it("casa com .ics de UID diferente: reconhece e pula a criação sem sobrescrever o uid", async () => {
    const day = "2031-04-15";
    const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//teste//PT", "BEGIN:VEVENT", "UID:uid-real-do-outlook@teste",
      "DTSTAMP:20310301T120000Z", "DTSTART:20310415T120000Z", "DTEND:20310415T130000Z", "SUMMARY:Planejamento Trimestral",
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    expect((await importIcs([{ name: "p.ics", text }], owner)).created).toBe(1);
    const before = await rows(day);
    expect(before).toHaveLength(1);

    const body = [ev("hash-ics", "Planejamento trimestral", day, 9, 2)];
    for (let pass = 0; pass < 2; pass++) {
      const res = await send(day, body);
      expect(res.json).toMatchObject({ created: 0, updated: 0, unchanged: 1, removed: 0 });
    }
    const after = await rows(day);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ ical_uid: "uid-real-do-outlook@teste", import_source: null, source: "ics", status: "scheduled" });
  });

  it("não casa fora da tolerância de 5 minutos (e casa exatamente nela)", async () => {
    const day = "2031-04-16";
    const longe = await manual("Retrospectiva", day, 10);
    const limite = await manual("Demonstração", day, 15);
    const before = (await rows(day)).length;

    const res = await send(day, [ev("h-longe", "Retrospectiva", day, 10, 6), ev("h-limite", "Demonstração", day, 15, 5)]);
    expect(res.json).toMatchObject({ created: 1, updated: 1 });
    expect(await rows(day)).toHaveLength(before + 1);
    expect((await one(longe.id)).ical_uid).toBeNull();
    expect((await one(limite.id)).ical_uid).toBe("h-limite");
  });

  it("títulos diferentes no mesmo horário não casam", async () => {
    const day = "2031-04-17";
    const m = await manual("Reunião de Produto", day, 11);
    const before = (await rows(day)).length;

    const res = await send(day, [ev("h-outro", "Reunião de Engenharia", day, 11)]);
    expect(res.json).toMatchObject({ created: 1, updated: 0 });
    expect(await rows(day)).toHaveLength(before + 1);
    expect((await one(m.id)).ical_uid).toBeNull();
  });

  it("não casa com reunião de outro dono nem com cadastro cancelado pelo usuário", async () => {
    const day = "2031-04-18";
    await createScheduled({ title: "Reunião Privada", start: at(day, 9), durationMinutes: 60, skipRecording: false }, outro);
    const cancelada = await manual("Reunião Descartada", day, 13);
    await cancelScheduled(cancelada.id, "one");
    const before = await pool.query(`SELECT count(*)::int AS n FROM meetings`);

    const res = await send(day, [ev("h-priv", "Reunião Privada", day, 9), ev("h-desc", "Reunião Descartada", day, 13)]);
    expect(res.json).toMatchObject({ created: 2, updated: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM meetings`)).rows[0].n).toBe(before.rows[0].n + 2);
    expect((await one(cancelada.id)).status).toBe("cancelled");
  });

  it("remarcação no Outlook move o cadastro vinculado em vez de cancelá-lo", async () => {
    const day = "2031-04-21";
    const m = await manual("Mentoria", day, 10, { skipRecording: true });
    await send(day, [ev("h-m1", "Mentoria", day, 10)]);
    expect((await one(m.id)).ical_uid).toBe("h-m1");
    const before = (await rows(day)).length;

    // o envio usa hash de título e início: remarcar troca o uid
    const res = await send(day, [ev("h-m2", "Mentoria", day, 15)]);
    expect(res.json).toMatchObject({ created: 0, removed: 0 });
    expect(await rows(day)).toHaveLength(before);
    const moved = await one(m.id);
    expect(moved).toMatchObject({ ical_uid: "h-m2", status: "skipped", skip_recording: true, title: "Mentoria" });
    expect(moved.scheduled_start.toISOString()).toBe(new Date(at(day, 15)).toISOString());

    const again = await send(day, [ev("h-m2", "Mentoria", day, 15)]);
    expect(again.json).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});
