import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isoWeekday } from "../../src/calendar/workingDays";
import type { User } from "../../src/types";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const AGENT = { authorization: `Bearer ${"teste-".repeat(8)}`, "content-type": "application/json" };
const teams = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;
const TZ = "America/Sao_Paulo";

// "Hoje" é sempre dia sem agenda: WORKING_DAYS recebe todos os dias da semana menos os de agora,
// o que deixa o teste igual em qualquer dia em que ele rode (sem depender de ser fim de semana).
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const todayWeekdays = new Set([-1, 10].map((m) => isoWeekday(minutesFromNow(m), TZ)));
const WORKING = [1, 2, 3, 4, 5, 6, 7].filter((d) => !todayWeekdays.has(d)).join(",");

// O navegador do bot não sobe no teste: registra só o pedido.
const launches = vi.hoisted(() => [] as string[]);
vi.mock("../../src/bot/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/bot/runner")>()),
  startBot: (id: string) => {
    launches.push(id);
  },
}));

describe.skipIf(!enabled)("dia sem agenda: lembrete e gravação automática (HTTP + Postgres)", async () => {
  vi.stubEnv("WORKING_DAYS", WORKING);
  vi.stubEnv("AUTO_ASSISTANT", "true");
  vi.stubEnv("AUTO_LOCAL_RECORDING", "true");
  vi.stubEnv("AGENT_OWNER", "ds-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { tick } = await import("../../src/recording/scheduler");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled } = await import("../../src/calendar/service");

  let user: User;
  let server: Server;
  let base = "";
  let cookie = "";

  const heartbeat = async () => {
    const res = await fetch(`${base}/api/agent/heartbeat`, {
      method: "POST",
      headers: AGENT,
      body: JSON.stringify({ version: "teste", capture: null, mode: "full" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { meetings: { id: string; noAlerts: boolean }[] };
  };

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  const schedule = (title: string, offsetMin: number, url: string | null) =>
    createScheduled(
      { title, start: minutesFromNow(offsetMin).toISOString(), durationMinutes: 30, url, skipRecording: false },
      user.id,
    );
  const statusOf = async (id: string) => (await pool.query(`SELECT status FROM meetings WHERE id = $1`, [id])).rows[0].status;

  beforeAll(async () => {
    await migrate(pool);
    user = await createUser("ds-dono", await hashPassword("senha-forte-123"), { role: "SUPER_ADMIN" });
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ds-dono", password: "senha-forte-123" }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });

  afterAll(async () => {
    server?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("a reunião de hoje vem marcada como dia sem agenda e segue na agenda", async () => {
    const m = await schedule("Avulsa em dia sem agenda", 10, teams("marca"));
    expect(m.status).toBe("scheduled");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(minutesFromNow(10));
    const agenda = await api("GET", `/agenda?date=${day}`);
    expect(agenda.json.meetings.find((x: { id: string }) => x.id === m.id)).toMatchObject({
      status: "scheduled", offDay: true, autoOnOffDay: false,
    });
  });

  it("o host-agent recebe noAlerts na reunião sem pedido e não recebe quando o usuário pede", async () => {
    const m = await schedule("Lembrete suprimido", 10, null);
    expect((await heartbeat()).meetings.find((x) => x.id === m.id)).toMatchObject({ noAlerts: true });

    expect((await api("POST", `/meetings/${m.id}/auto-off-day`, { enabled: true })).json).toMatchObject({
      id: m.id, autoOnOffDay: true, offDay: true,
    });
    expect((await heartbeat()).meetings.find((x) => x.id === m.id)).toMatchObject({ noAlerts: false });

    expect((await api("POST", `/meetings/${m.id}/auto-off-day`, { enabled: false })).json).toMatchObject({ autoOnOffDay: false });
    expect((await heartbeat()).meetings.find((x) => x.id === m.id)).toMatchObject({ noAlerts: true });
  });

  it("o agendador não põe o assistente nem grava pelo PC; com o pedido do usuário, passa a agir", async () => {
    const comLink = await schedule("Com link", -1, teams("auto"));
    const semLink = await schedule("Sem link", -1, null);
    await heartbeat(); // host-agent online, com desktop

    launches.length = 0;
    await tick();
    expect(launches).toEqual([]);
    expect(await statusOf(comLink.id)).toBe("scheduled");
    expect(await statusOf(semLink.id)).toBe("scheduled");

    // pedido explícito por reunião: o assistente entra na que tem link
    expect((await api("POST", `/meetings/${comLink.id}/auto-off-day`, { enabled: true })).status).toBe(200);
    launches.length = 0;
    await tick();
    expect(launches).toEqual([comLink.id]);
    expect(await statusOf(comLink.id)).toBe("joining");

    // e o PC grava a que não tem link
    await heartbeat();
    expect((await api("POST", `/meetings/${semLink.id}/auto-off-day`, { enabled: true })).status).toBe(200);
    await tick();
    expect(await statusOf(semLink.id)).toBe("recording");
  });

  it("'Enviar assistente agora' continua valendo em dia sem agenda, sem precisar do pedido", async () => {
    const m = await schedule("Envio manual", -1, teams("manual"));
    launches.length = 0;
    expect((await api("POST", `/meetings/${m.id}/assistant`)).status).toBe(202);
    expect(launches).toEqual([m.id]);
  });
});
