import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const AGENT = { authorization: `Bearer ${"teste-".repeat(8)}`, "content-type": "application/json" };
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

// O host-agent avisa a reunião sem link com base no que o heartbeat entrega: o tempo de antecedência e a agenda do
// dono com url nula (como vem da Aurora). O que sai daqui precisa trazer as duas coisas.
describe.skipIf(!enabled)("aviso de reunião sem link: o que o heartbeat entrega ao host-agent", async () => {
  vi.stubEnv("AGENT_OWNER", "sl-dono");
  vi.stubEnv("NO_LINK_ALERT_MINUTES", "7");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled } = await import("../../src/calendar/service");

  let ownerId = "";
  let server: Server;
  let base = "";

  const heartbeat = async () => {
    const res = await fetch(`${base}/api/agent/heartbeat`, {
      method: "POST",
      headers: AGENT,
      body: JSON.stringify({ version: "teste", capture: null, mode: "full" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      alerts: { minutesBefore: number[]; noLinkMinutes: number };
      meetings: { id: string; url: string | null; status: string; skipRecording: boolean }[];
    };
  };

  beforeAll(async () => {
    await migrate(pool);
    ownerId = (await createUser("sl-dono", await hashPassword("senha-forte-123"), { role: "SUPER_ADMIN" })).id;
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await pool.query(`DELETE FROM meetings WHERE created_by = $1`, [ownerId]);
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("informa a antecedência configurada e a reunião sem link com url nula", async () => {
    const semLink = await createScheduled(
      { title: "Sem link", start: minutesFromNow(8).toISOString(), durationMinutes: 30, skipRecording: false },
      ownerId,
    );
    const comLink = await createScheduled(
      {
        title: "Com link", start: minutesFromNow(9).toISOString(), durationMinutes: 30, skipRecording: false,
        url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_sl%40thread.v2/0",
      },
      ownerId,
    );
    const body = await heartbeat();
    expect(body.alerts).toMatchObject({ minutesBefore: [15, 5, 1], noLinkMinutes: 7 });
    const byId = new Map(body.meetings.map((m) => [m.id, m]));
    expect(byId.get(semLink.id)).toMatchObject({ url: null, status: "scheduled", skipRecording: false });
    expect(byId.get(comLink.id)?.url).toContain("teams.microsoft.com");
  });
});
