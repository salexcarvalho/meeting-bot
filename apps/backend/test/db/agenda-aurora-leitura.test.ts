import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TOKEN = "teste-".repeat(8);
const SOURCE = "aurora-outlook";
const DAY = "2031-05-12";
const OTHER_DAY = "2031-05-13";
const teamsLink = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;

// Leitura da agenda do dia pelo agente externo (GET /api/agent/meetings), no escopo do dono do agente.
describe.skipIf(!enabled)("leitura da agenda do dia pela Aurora (HTTP + Postgres)", async () => {
  vi.stubEnv("AGENT_OWNER", "le-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { hostAgentLastSeen } = await import("../../src/recording/hostAgentState");
  const { createScheduled, setSkip } = await import("../../src/calendar/service");

  let server: Server;
  let base = "";
  let owner = "";
  let outro = "";

  const hour = (day: string, h: number) => `${day}T${String(h).padStart(2, "0")}:00:00-03:00`;
  const ev = (uid: string, h: number, extra: Record<string, unknown> = {}) => ({
    uid, title: `Reunião ${uid}`, start: hour(DAY, h), end: hour(DAY, h + 1), ...extra,
  });
  const importDay = (events: unknown[], date = DAY) =>
    fetch(`${base}/api/agent/calendar/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ source: SOURCE, date, events }),
    });
  const get = (query: string, token: string | null = TOKEN) =>
    fetch(`${base}/api/agent/meetings${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (res) => ({
      status: res.status,
      json: (await res.json()) as { date?: string; error?: string; meetings?: Record<string, unknown>[] },
    }));
  const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword("senha-forte-123");
    owner = (await createUser("le-dono", hash, { role: "SUPER_ADMIN" })).id;
    outro = (await createUser("le-outra", hash, { role: "USER" })).id;
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    // Banco compartilhado com os demais arquivos de agenda (mesma origem, outro dono): não deixa reuniões para trás.
    await pool.query(`DELETE FROM meetings WHERE created_by = ANY($1::uuid[])`, [[owner, outro]]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("sem token ou com token errado: 401", async () => {
    expect((await get(`?date=${DAY}`, null)).status).toBe(401);
    expect((await get(`?date=${DAY}`, "token-errado-".repeat(4))).status).toBe(401);
  });

  it("data inválida: 400, sem consultar nada", async () => {
    for (const bad of ["?date=14/11/2026", "?date=2031-02-31", "?date=", "?date=2031-5-1", "?date=a&date=b"]) {
      const res = await get(bad);
      expect(res.status, bad).toBe(400);
      expect(res.json.error).toMatch(/^date: /);
    }
  });

  it("devolve só as reuniões do dia do dono, com o uid importado e sem registrar heartbeat", async () => {
    expect((await importDay([ev("a", 9, { teams: teamsLink("a1") }), ev("b", 14), ev("serie", 16, { recurring: true })])).status).toBe(200);
    expect((await importDay([{ uid: "outro-dia", title: "Outro dia", start: hour(OTHER_DAY, 10), end: hour(OTHER_DAY, 11) }], OTHER_DAY)).status).toBe(200);
    const manual = await createScheduled({ title: "Manual", start: hour(DAY, 18), durationMinutes: 30, skipRecording: false }, owner);
    await createScheduled({ title: "De outra pessoa", start: hour(DAY, 11), durationMinutes: 30, skipRecording: false }, outro);
    const skipped = (await pool.query(`SELECT id FROM meetings WHERE ical_uid = 'b' AND created_by = $1`, [owner])).rows[0].id as string;
    await setSkip(skipped, true);

    const meetingsBefore = await count("meetings");
    const auditBefore = await count("audit_log");
    const seenBefore = hostAgentLastSeen();

    const res = await get(`?date=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.json.date).toBe(DAY);
    const list = res.json.meetings!;
    expect(list.map((m) => m.title)).toEqual(["Reunião a", "Reunião b", "Reunião serie", "Manual"]);
    expect(list[0]).toEqual({
      id: expect.any(String), icalUid: "a", title: "Reunião a",
      start: "2031-05-12T12:00:00.000Z", end: "2031-05-12T13:00:00.000Z",
      url: teamsLink("a1"), platform: "teams", skipRecording: false, status: "scheduled", recurring: false,
    });
    expect(list[1]).toMatchObject({ icalUid: "b", url: null, platform: null, skipRecording: true, status: "skipped", recurring: false });
    expect(list[2]).toMatchObject({ icalUid: "serie", recurring: true });
    expect(list[3]).toMatchObject({ id: manual.id, icalUid: null, recurring: false });
    expect(Object.keys(list[0]).sort()).toEqual(
      ["end", "icalUid", "id", "platform", "recurring", "skipRecording", "start", "status", "title", "url"],
    );

    // Leitura pura: nada novo no banco e nenhum heartbeat registrado.
    expect(await count("meetings")).toBe(meetingsBefore);
    expect(await count("audit_log")).toBe(auditBefore);
    expect(hostAgentLastSeen()).toBe(seenBefore);
  });

  it("outro dia traz só as reuniões dele; dia sem reunião devolve lista vazia", async () => {
    const other = await get(`?date=${OTHER_DAY}`);
    expect(other.json.meetings!.map((m) => m.icalUid)).toEqual(["outro-dia"]);
    const empty = await get("?date=2031-06-01");
    expect(empty).toMatchObject({ status: 200, json: { date: "2031-06-01", meetings: [] } });
  });

  it("sem date vale hoje no fuso da aplicação", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.json.meetings).toEqual(expect.any(Array));
  });
});
