import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const PASSWORD = "senha-forte-123";
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

// O bot real abriria Chromium/PulseAudio: aqui nenhum teste o usa, mas o runner importa Playwright.
vi.mock("../../src/bot/runner", async (importOriginal) => importOriginal<typeof import("../../src/bot/runner")>());

type Json = any;

// Rotas dos nomes dos falantes (spec 006, US4): renomear grava manual, voltar, reaplicar e quem pode.
describe.skipIf(!enabled)("nomes dos falantes pela API (HTTP + Postgres)", async () => {
  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const transcripts = await import("../../src/repo/transcripts");
  const activity = await import("../../src/repo/speakerActivity");

  let server: Server;
  let base = "";
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let meetingId = "";

  async function call(who: string | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { origin: base };
    if (who) headers.cookie = cookies[who];
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
  }

  async function login(username: string) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    cookies[username] = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword(PASSWORD);
    for (const [name, role] of [["fl-dono", "USER"], ["fl-outro", "USER"], ["fl-leitor", "VIEWER"]] as const) {
      ids[name] = (await createUser(name, hash, { role })).id;
    }
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const name of Object.keys(ids)) await login(name);

    meetingId = (
      await pool.query(
        `INSERT INTO meetings (title, platform, status, source, created_by) VALUES ('Falantes', 'teams', 'done', 'bot', $1) RETURNING id`,
        [ids["fl-dono"]],
      )
    ).rows[0].id;
    const segments = [];
    const intervals = [];
    let t = 10;
    for (let round = 0; round < 5; round++) {
      for (const [label, key, name] of [["Speaker 1", "id:a", "Maria Souza"], ["Speaker 2", "id:b", "João Lima"]]) {
        segments.push({ channel: "mixed" as const, speaker: label, text: "fala", start: t + 0.2, end: t + 7.8 });
        intervals.push({ key, name, start: t, end: t + 8 });
        t += 9;
      }
    }
    await transcripts.replaceWithFinal(meetingId, segments);
    await activity.insertActivity(meetingId, "teams", intervals);
    await activity.writeTimelineMeta(meetingId, { status: "ok", people: 2, intervals: intervals.length });
    expect((await call("fl-dono", "POST", `/meetings/${meetingId}/shares`, { userId: ids["fl-leitor"], access: "read" })).status).toBe(201);
  });

  afterAll(async () => {
    server?.close();
    await pool.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
    await pool.end();
  });

  it("reaplicar nomes da chamada responde applied/skipped e a reunião passa a mostrar origem, confiança e estado", async () => {
    const res = await call("fl-dono", "POST", `/meetings/${meetingId}/speakers/apply-call-names`);
    expect(res).toMatchObject({ status: 200, json: { applied: 2, skipped: 0 } });
    const detail = (await call("fl-dono", "GET", `/meetings/${meetingId}`)).json;
    const maria = detail.speakers.find((s: Json) => s.label === "Speaker 1");
    expect(maria).toMatchObject({ displayName: "Maria Souza", nameSource: "call" });
    expect(maria.nameConfidence).toBeGreaterThanOrEqual(0.75);
    expect(detail.speakerTimeline).toEqual({ status: "ok", people: 2 });
    expect(detail.segments.find((s: Json) => s.speaker === "Speaker 1").speakerName).toBe("Maria Souza");
  });

  it("renomear grava origem manual; reaplicar respeita; 'voltar ao rótulo' devolve o padrão", async () => {
    const renamed = await call("fl-dono", "PATCH", `/meetings/${meetingId}/speakers/Speaker%202`, { displayName: "Dr. Paulo" });
    expect(renamed).toMatchObject({ status: 200, json: { displayName: "Dr. Paulo", nameSource: "manual" } });
    expect((await call("fl-dono", "POST", `/meetings/${meetingId}/speakers/apply-call-names`)).json).toMatchObject({ applied: 1, skipped: 1 });
    expect((await call("fl-dono", "GET", `/meetings/${meetingId}`)).json.speakers.find((s: Json) => s.label === "Speaker 2").displayName).toBe("Dr. Paulo");

    const back = await call("fl-dono", "PATCH", `/meetings/${meetingId}/speakers/Speaker%202`, { displayName: "Speaker 2" });
    expect(back.json).toMatchObject({ displayName: "Speaker 2", nameSource: null });
    expect((await call("fl-dono", "POST", `/meetings/${meetingId}/speakers/apply-call-names`)).json).toMatchObject({ applied: 2 });
  });

  it("quem não vê a reunião recebe 404; quem só lê recebe recusa e continua vendo os nomes; sem login, 401", async () => {
    const url = `/meetings/${meetingId}/speakers/apply-call-names`;
    expect((await call("fl-outro", "POST", url)).status).toBe(404);
    expect((await call("fl-leitor", "POST", url)).status).toBe(403);
    expect((await call("fl-leitor", "PATCH", `/meetings/${meetingId}/speakers/Speaker%201`, { displayName: "X" })).status).toBe(403);
    const seen = await call("fl-leitor", "GET", `/meetings/${meetingId}`);
    expect(seen.status).toBe(200);
    expect(seen.json.speakers.map((s: Json) => s.displayName)).toContain("Maria Souza");
    expect((await call(null, "POST", url)).status).toBe(401);
    expect((await call("fl-dono", "POST", `/meetings/${ZERO_UUID}/speakers/apply-call-names`)).status).toBe(404);
  });

  it("reunião sem linha do tempo: reaplicar não muda nada e a reunião não mostra estado", async () => {
    const plain = (
      await pool.query(`INSERT INTO meetings (title, platform, status, source, created_by) VALUES ('Sem leitura', 'none', 'done', 'manual', $1) RETURNING id`, [ids["fl-dono"]])
    ).rows[0].id;
    await transcripts.replaceWithFinal(plain, [{ channel: "remote", speaker: "Speaker 1", text: "oi", start: 1, end: 5 }]);
    expect((await call("fl-dono", "POST", `/meetings/${plain}/speakers/apply-call-names`)).json).toEqual({ applied: 0, skipped: 0 });
    const detail = (await call("fl-dono", "GET", `/meetings/${plain}`)).json;
    expect(detail.speakerTimeline).toBeNull();
    expect(detail.speakers[0]).toMatchObject({ displayName: "Speaker 1", nameSource: null, nameConfidence: null });
    await pool.query(`DELETE FROM meetings WHERE id = $1`, [plain]);
  });
});
