import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";
import { allKeys, assertNoMeetingData, seedUsage } from "./uso-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const MONTH = "2026-02";
const TITLE_A = "Reunião confidencial da Ana ua-1";
const TITLE_B = "Reunião confidencial da Bia ua-2";

// Painel de admin: agregados da instância, por usuário, sem nenhum dado de reunião (FR-013 a FR-015).
describe.skipIf(!enabled)("painel de uso do admin (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  let meetingA: string;
  let meetingB: string;
  const admin = (who: string, query = "") => h.call(who, "GET", `/admin/usage?month=${MONTH}${query}`);

  beforeAll(async () => {
    h = await startHarness([
      ["ua-ana", "USER", "Ana"],
      ["ua-bia", "USER", "Bia"],
      ["ua-leo", "VIEWER", "Leo"],
      ["ua-admin", "ADMIN", "Admin"],
      ["ua-super", "SUPER_ADMIN", "Super"],
    ]);
    meetingA = await h.seedMeeting("ua-ana", { title: TITLE_A });
    meetingB = await h.seedMeeting("ua-bia", { title: TITLE_B });
    // reunião cujo dono foi removido (created_by nulo): vira "usuário removido"
    meetingRemoved = (
      await h.pool.query(
        `INSERT INTO meetings (title, platform, status, source, created_by, extract_items) VALUES ('Reunião órfã ua-3', 'none', 'done', 'manual', NULL, true) RETURNING id`,
      )
    ).rows[0].id;
    await seedUsage(h.pool, { at: "2026-02-05T12:00:00Z", user: h.ids["ua-ana"], meeting: meetingA, provider: "openrouter", model: "m1", input: 1000, output: 100, cost: 0.2 });
    await seedUsage(h.pool, { at: "2026-02-06T12:00:00Z", user: h.ids["ua-ana"], meeting: meetingA, provider: "claude", model: "m2", input: 300, output: 30 });
    await seedUsage(h.pool, { at: "2026-02-06T13:00:00Z", user: h.ids["ua-bia"], meeting: meetingB, provider: "ollama", purpose: "itens", model: "m3", input: 50, output: 5, compute: 1000 });
    await seedUsage(h.pool, { at: "2026-02-07T12:00:00Z", user: h.ids["ua-bia"], meeting: meetingB, category: "asr", provider: "deepgram", audio: 120, cost: 0.03 });
    await seedUsage(h.pool, { at: "2026-02-07T14:00:00Z", purpose: "outro", provider: "ollama", input: 11, output: 1 });
    await seedUsage(h.pool, { at: "2026-02-08T14:00:00Z", meeting: meetingRemoved, provider: "ollama", input: 22, output: 2 });
  });

  let meetingRemoved = "";

  afterAll(async () => {
    await h.stop();
  });

  it("totais da instância e quebra por usuário fecham (mesma função de totais do painel pessoal)", async () => {
    const res = await admin("ua-admin");
    expect(res.status).toBe(200);
    expect(res.json.totals).toMatchObject({ calls: 6, inputTokens: 1383, outputTokens: 138, pricedCalls: 2 });
    expect(res.json.totals.costUsd).toBeCloseTo(0.23, 8);
    const sum = (key: string) => (res.json.byUser as Json[]).reduce((s, g) => s + g[key], 0);
    expect(sum("calls")).toBe(res.json.totals.calls);
    expect(sum("inputTokens")).toBe(res.json.totals.inputTokens);
    expect(sum("audioSeconds")).toBe(res.json.totals.audioSeconds);
    const labels = (res.json.byUser as Json[]).map((g) => g.label).sort();
    expect(labels).toEqual(["Instância", "Usuário removido", "ua-ana", "ua-bia"]);
    const ana = res.json.byUser.find((g: Json) => g.label === "ua-ana");
    expect(ana).toMatchObject({ key: h.ids["ua-ana"], calls: 2, inputTokens: 1300 });
    expect(res.json.byUser.find((g: Json) => g.label === "Instância").key).toBe("instance");
    expect(res.json.byUser.find((g: Json) => g.label === "Usuário removido").key).toBe("removed");
    expect(res.json.asr.external.audioSeconds).toBe(120);
  });

  it("a resposta não tem chave de reunião, título nem id (FR-014, SC-003)", async () => {
    const res = await admin("ua-super");
    expect(res.status).toBe(200);
    expect(() => assertNoMeetingData(res.json, [TITLE_A, TITLE_B, "Reunião órfã", meetingA, meetingB, meetingRemoved])).not.toThrow();
    expect([...allKeys(res.json)].some((k) => /meeting|title/i.test(k))).toBe(false);
  });

  it("mutação: o varredor percebe se uma lista por reunião entrar na resposta", async () => {
    const res = await admin("ua-admin");
    const leaked = { ...res.json, topMeetings: [{ meetingId: meetingA, title: TITLE_A }] };
    expect(() => assertNoMeetingData(leaked, [TITLE_A, meetingA])).toThrow(/reunião/);
    expect(() => assertNoMeetingData({ ...res.json, byUser: [{ label: TITLE_A }] }, [TITLE_A])).toThrow(/contém/);
  });

  it("usuário comum, leitor e anônimo não acessam", async () => {
    expect((await admin("ua-ana")).status).toBe(403);
    expect((await admin("ua-leo")).status).toBe(403);
    expect((await h.call(null, "GET", `/admin/usage?month=${MONTH}`)).status).toBe(401);
  });

  it("período inválido dá 400 e o mês sem consumo vem vazio", async () => {
    expect((await admin("ua-admin", "&from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z")).status).toBe(400);
    const empty = await h.call("ua-admin", "GET", "/admin/usage?month=2024-02");
    expect(empty.json.totals.calls).toBe(0);
    expect(empty.json.byUser).toEqual([]);
  });

  it("usuário desativado ou excluído continua nos totais históricos", async () => {
    const { rows } = await h.pool.query(
      `INSERT INTO users (username, password_hash) VALUES ('ua-saiu', 'x') RETURNING id`,
    );
    await seedUsage(h.pool, { at: "2026-02-09T10:00:00Z", user: rows[0].id, input: 5, output: 5 });
    const before = await admin("ua-admin");
    expect(before.json.byUser.some((g: Json) => g.label === "ua-saiu")).toBe(true);
    await h.pool.query(`DELETE FROM users WHERE id = $1`, [rows[0].id]);
    const after = await admin("ua-admin");
    expect(after.json.totals.calls).toBe(before.json.totals.calls);
    expect(after.json.totals.inputTokens).toBe(before.json.totals.inputTokens);
    expect(after.json.byUser.some((g: Json) => g.label === "ua-saiu")).toBe(false);
  });
});
