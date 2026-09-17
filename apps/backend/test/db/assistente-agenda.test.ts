import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const PASSWORD = "senha-forte-123";
const AGENT = { authorization: `Bearer ${"teste-".repeat(8)}`, "content-type": "application/json" };
const teams = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;

// O navegador do bot não sobe no teste: registra só o pedido.
const launches = vi.hoisted(() => [] as { id: string; url: string; admitUntil: Date | null; stayUntil: Date | null }[]);
vi.mock("../../src/bot/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/bot/runner")>()),
  startBot: (id: string, url: string, _platform: string, launch: { admitUntil?: Date | null; stayUntil?: Date | null }) => {
    launches.push({ id, url, admitUntil: launch.admitUntil ?? null, stayUntil: launch.stayUntil ?? null });
  },
}));

// Decisão de 2026-09-17: no horário o assistente entra nas reuniões da agenda com link; o PC não grava sozinho.
describe.skipIf(!enabled)("assistente nas reuniões da agenda (HTTP + Postgres)", async () => {
  vi.stubEnv("AUTO_ASSISTANT", "true");
  vi.stubEnv("AUTO_LOCAL_RECORDING", "false");
  vi.stubEnv("AGENT_OWNER", "aa-dono");

  const { pool, createUser, recoverInterruptedMeetings } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { tick } = await import("../../src/recording/scheduler");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { activeBots, botUrlKey } = await import("../../src/bot/state");

  let server: Server;
  let base = "";
  const cookies: Record<string, string> = {};

  async function call(who: string, method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: { cookie: cookies[who], ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function scheduled(title: string, startOffsetMin: number, url: string | null) {
    const start = new Date(Date.now() + startOffsetMin * 60_000).toISOString();
    const res = await call("aa-dono", "POST", "/meetings/scheduled", { title, start, durationMinutes: 30, url });
    expect(res.status).toBe(201);
    return res.json.id as string;
  }

  const row = async (id: string) =>
    (await pool.query(`SELECT status, error_message, bot_display_name, scheduled_end, skip_recording FROM meetings WHERE id = $1`, [id]))
      .rows[0];

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword(PASSWORD);
    await createUser("aa-dono", hash, { role: "SUPER_ADMIN" });
    await createUser("aa-outra", hash, { role: "USER" });
    invalidateHostOwner();
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const name of ["aa-dono", "aa-outra"]) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name, password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      cookies[name] = res.headers.get("set-cookie")!.split(";")[0];
    }
    // host-agent online: mesmo assim o PC não pode começar a gravar sozinho
    const hb = await fetch(`${base}/api/agent/heartbeat`, {
      method: "POST",
      headers: AGENT,
      body: JSON.stringify({ version: "teste", capture: null }),
    });
    expect(hb.status).toBe(200);
  });

  afterAll(async () => {
    server?.close();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("no horário entra só nas reuniões com link do Teams/Meet e sem 'Não gravar'; o PC não grava", async () => {
    const withLink = await scheduled("Daily com link", -1, teams("a1"));
    const noLink = await scheduled("Daily sem link", -1, null);
    const skipped = await scheduled("Daily não gravar", -1, teams("a2"));
    expect((await call("aa-dono", "POST", `/meetings/${skipped}/skip`, { skip: true })).status).toBe(200);
    const future = await scheduled("Daily de mais tarde", 60, teams("a3"));
    const zoom = await scheduled("Reunião no Zoom", -1, "https://zoom.us/j/123456");

    launches.length = 0;
    await tick();

    expect(launches.map((l) => l.id)).toEqual([withLink]);
    const joined = await row(withLink);
    expect(joined.status).toBe("joining");
    expect(joined.bot_display_name).toMatch(/assistente gravando$/);
    // espera a admissão e fica até o fim previsto
    expect(launches[0].admitUntil?.getTime()).toBe(new Date(joined.scheduled_end).getTime());
    expect(launches[0].stayUntil?.getTime()).toBe(new Date(joined.scheduled_end).getTime());

    for (const id of [noLink, future]) {
      expect((await row(id)).status).toBe("scheduled");
    }
    expect((await row(skipped)).status).toBe("skipped");
    expect(await row(zoom)).toMatchObject({ status: "scheduled", error_message: expect.stringMatching(/Teams ou do Google Meet/) });

    // novo ciclo não manda outro assistente
    await tick();
    expect(launches).toHaveLength(1);
  });

  it("mesmo link com assistente: espera, explica e entra quando o outro sai", async () => {
    const url = teams("b1");
    const id = await scheduled("Refinamento com link repetido", -1, url);
    activeBots.set("outra-reuniao", {
      abort: new AbortController(),
      done: Promise.resolve(),
      urlKey: botUrlKey(url),
      displayName: "Outro - assistente gravando",
      requestedAt: Date.now(),
      stage: "in_call",
      stageAt: Date.now(),
    });
    launches.length = 0;
    await tick();
    expect(launches).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "scheduled", error_message: expect.stringMatching(/Já existe um assistente/) });

    activeBots.delete("outra-reuniao");
    await tick();
    expect(launches.map((l) => l.id)).toEqual([id]);
    expect(await row(id)).toMatchObject({ status: "joining", error_message: null });
  });

  it("enviar assistente agora: só o dono, só com link e só se ainda não gravou", async () => {
    const later = await scheduled("Reunião de amanhã", 24 * 60, teams("c1"));
    const noLink = await scheduled("Conversa sem link", 24 * 60, null);

    expect((await call("aa-outra", "POST", `/meetings/${later}/assistant`)).status).toBe(404);
    const bad = await call("aa-dono", "POST", `/meetings/${noLink}/assistant`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Teams ou do Google Meet/);

    launches.length = 0;
    const sent = await call("aa-dono", "POST", `/meetings/${later}/assistant`);
    expect(sent.status).toBe(202);
    expect(sent.json.status).toBe("joining");
    expect(launches.map((l) => l.id)).toEqual([later]);
    // reunião de amanhã: não fica um dia na sala de espera (vale o limite padrão)
    expect(launches[0].admitUntil).toBeNull();

    const again = await call("aa-dono", "POST", `/meetings/${later}/assistant`);
    expect(again.status).toBe(409);

    // depois de uma falha sem áudio dá para mandar de novo; com áudio, não
    await pool.query(`UPDATE meetings SET status = 'error', error_message = 'Não fui admitido' WHERE id = $1`, [later]);
    expect((await call("aa-dono", "POST", `/meetings/${later}/assistant`)).status).toBe(202);
    await pool.query(`UPDATE meetings SET status = 'error' WHERE id = $1`, [later]);
    await pool.query(
      `INSERT INTO meeting_audio (meeting_id, channel, path, format) VALUES ($1, 'mixed', '/tmp/x.ogg', 'ogg_opus')`,
      [later],
    );
    expect((await call("aa-dono", "POST", `/meetings/${later}/assistant`)).status).toBe(409);
  });

  it("reinício: assistente da agenda sem áudio volta a entrar enquanto ainda é horário", async () => {
    const inWindow = await scheduled("Reunião que caiu no meio", -2, teams("d1"));
    const over = await scheduled("Reunião que já acabou", -2, teams("d2"));
    const recorded = await scheduled("Reunião com áudio", -2, teams("d3"));
    await pool.query(`UPDATE meetings SET status = 'waiting_admission' WHERE id = $1`, [inWindow]);
    await pool.query(
      `UPDATE meetings SET status = 'joining', scheduled_end = now() - interval '1 minute' WHERE id = $1`,
      [over],
    );
    await pool.query(`UPDATE meetings SET status = 'in_call', started_at = now(), audio_path = '/tmp/d3.ogg' WHERE id = $1`, [
      recorded,
    ]);

    const resumed = await recoverInterruptedMeetings();

    expect((await row(inWindow)).status).toBe("scheduled");
    expect(await row(over)).toMatchObject({ status: "error", error_message: expect.stringMatching(/reiniciado/) });
    expect(resumed).toContainEqual({ id: recorded, step: "all" });
    expect(resumed.map((r) => r.id)).not.toContain(inWindow);

    // (as reuniões dos testes anteriores, ainda no horário, também voltam)
    launches.length = 0;
    await tick();
    expect(launches.map((l) => l.id)).toContain(inWindow);
    expect(launches.map((l) => l.id)).not.toContain(over);
    expect((await row(inWindow)).status).toBe("joining");
  });
});
