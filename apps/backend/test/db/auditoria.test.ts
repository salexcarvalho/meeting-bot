import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, type Harness, type Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TITLE = "Reunião sigilosa da auditoria au-1";

// Auditoria visível: o usuário vê só o que é dele, o admin vê o sistema, sempre por projeção (specs/004, US5).
describe.skipIf(!enabled)("auditoria visível (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  let meeting: string;

  const mine = (who: string, query = "") => h.call(who, "GET", `/audit/me${query}`);
  const system = (who: string, query = "") => h.call(who, "GET", `/admin/audit${query}`);
  const titles = (res: { json: Json }) => (res.json.items as Json[]).map((e) => e.title);
  const kinds = (res: { json: Json }) => (res.json.items as Json[]).map((e) => e.kind);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** O audit() grava sem esperar; dá tempo de a linha chegar ao banco. */
  async function settled(who: string, expectKind: string, fetcher: (w: string) => Promise<{ json: Json }>) {
    for (let i = 0; i < 40; i++) {
      const res = await fetcher(who);
      if (kinds(res).includes(expectKind)) return res;
      await wait(25);
    }
    return fetcher(who);
  }

  beforeAll(async () => {
    h = await startHarness([
      ["au-ana", "USER", "Ana"],
      ["au-bia", "USER", "Bia"],
      ["au-sai", "USER", "Saída"],
      ["au-alvo", "USER", "Alvo"],
      ["au-admin", "ADMIN", "Admin"],
      ["au-super", "SUPER_ADMIN", "Super"],
    ]);
    meeting = await h.seedMeeting("au-ana", { title: TITLE });
    const addAudit = (kind: string, detail: Json, user: string | null) =>
      h.pool.query(`INSERT INTO audit_log (kind, detail, user_id) VALUES ($1, $2, $3)`, [kind, detail, user ? h.ids[user] : null]);
    await addAudit("external_llm", { meetingId: meeting, label: "extração final au 1/2", provider: "openrouter", model: "m", purpose: "ata", success: true, promptTokens: 10 }, "au-ana");
    await addAudit("external_asr", { meetingId: meeting, channel: "remote", seconds: 600, model: "deepgram/nova-3", purpose: "asr_final", phase: "start" }, "au-ana");
    await addAudit("external_llm", { meetingId: meeting, label: "da Bia", provider: "claude", purpose: "adr", success: true }, "au-bia");
    await addAudit("meeting_share_granted", { meetingId: meeting, target: h.ids["au-bia"], access: "read" }, "au-ana");
    await addAudit("tipo_futuro_sem_regra", { segredo: "valor-secreto", meetingId: meeting }, "au-ana");
    await addAudit("egress_blocked", { host: "evil.example", method: "GET", protocol: "https:" }, null);
    await addAudit("retention_pruned", { table: "ai_usage_logs", deleted: 12, olderThanDays: 730 }, null);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("login errado, entrada, troca de senha e saída viram eventos do próprio usuário, com IP só na falha", async () => {
    const bad = await h.call(null, "POST", "/auth/login", { username: "au-ana", password: "senha-errada-123" });
    expect(bad.status).toBe(401);
    const unknown = await h.call(null, "POST", "/auth/login", { username: "nao-existe-au", password: "senha-errada-123" });
    expect(unknown.status).toBe(401);
    const ok = await h.call(null, "POST", "/auth/login", { username: "au-ana", password: PASSWORD });
    expect(ok.status).toBe(200);
    const change = await h.call("au-ana", "POST", "/auth/password", { currentPassword: PASSWORD, newPassword: "outra-senha-forte-1" });
    expect(change.status).toBe(204);

    const res = await settled("au-ana", "auth_password_changed", (w) => mine(w));
    expect(kinds(res)).toEqual(expect.arrayContaining(["auth_login_failed", "auth_login", "auth_password_changed"]));
    const failed = (res.json.items as Json[]).find((e) => e.kind === "auth_login_failed")!;
    expect(failed.fields.ip).toEqual(expect.any(String));
    expect(failed.title).toBe("Tentativa de entrada recusada");
    const login = (res.json.items as Json[]).find((e) => e.kind === "auth_login")!;
    expect(login.fields).toEqual({});
    const changed = (res.json.items as Json[]).find((e) => e.kind === "auth_password_changed")!;
    expect(changed.fields.sessionsRevoked).toEqual(expect.any(Number));
    // o nome digitado errado nunca é gravado
    const { rows } = await h.pool.query(`SELECT detail::text AS d FROM audit_log WHERE kind = 'auth_login_failed'`);
    expect(rows.map((r) => r.d).join(" ")).not.toContain("nao-existe-au");
    expect(rows.map((r) => r.d).join(" ")).not.toContain("senha-errada");
  });

  it("saída da conta é auditada com o dono da sessão", async () => {
    expect((await h.call("au-sai", "POST", "/auth/logout")).status).toBe(204);
    const { rows } = await h.pool.query(`SELECT user_id FROM audit_log WHERE kind = 'auth_logout' AND user_id = $1`, [h.ids["au-sai"]]);
    expect(rows).toHaveLength(1);
  });

  it("ação de admin sobre a conta aparece para o alvo com o nome do admin", async () => {
    const patch = await h.call("au-super", "PATCH", `/admin/users/${h.ids["au-bia"]}`, { displayName: "Bia Nova" });
    expect(patch.status).toBe(200);
    const bia = await settled("au-bia", "admin_user_updated", (w) => mine(w));
    const event = (bia.json.items as Json[]).find((e) => e.kind === "admin_user_updated")!;
    expect(event.title).toBe("Administrador au-super alterou seu perfil");
    expect(event.actor.username).toBe("au-super");
    expect(event.target.username).toBe("au-bia");
    const sergio = await settled("au-super", "admin_user_updated", (w) => mine(w));
    expect(titles(sergio)).toContain("Você alterou o perfil de au-bia");
  });

  it("redefinição de senha pelo admin: o alvo perde as sessões e o admin vê o evento", async () => {
    const reset = await h.call("au-super", "POST", `/admin/users/${h.ids["au-alvo"]}/reset-password`, { password: "senha-nova-do-admin-1" });
    expect(reset.status).toBe(204);
    const admin = await settled("au-admin", "admin_user_password_reset", (w) => system(w, `?userId=${h.ids["au-alvo"]}`));
    expect(titles(admin)).toContain("Au-super redefiniu a senha de au-alvo");
  });

  it("envios externos aparecem para o dono, sem título, sem id de reunião e sem rótulo interno", async () => {
    const ana = await mine("au-ana");
    const ext = (ana.json.items as Json[]).filter((e) => e.kind === "external_llm" || e.kind === "external_asr");
    expect(ext.map((e) => e.title)).toEqual(expect.arrayContaining(["Texto enviado ao OpenRouter (ata)", "Áudio enviado para transcrição externa"]));
    const text = JSON.stringify(ana.json);
    for (const hidden of [TITLE, meeting, "extração final", "valor-secreto", "promptTokens"]) expect(text).not.toContain(hidden);
  });

  it("o usuário não vê eventos de outro nem tipos de sistema ou desconhecidos", async () => {
    const bia = await mine("au-bia");
    const text = JSON.stringify(bia.json);
    expect(text).not.toContain("openrouter");
    expect(titles(bia)).not.toContain("Texto enviado ao OpenRouter (ata)");
    expect(kinds(bia)).not.toContain("egress_blocked");
    expect(kinds(bia)).not.toContain("retention_pruned");
    expect(kinds(bia)).not.toContain("tipo_futuro_sem_regra");
    expect(kinds(bia)).not.toContain("meeting_share_granted");
    expect(kinds(await mine("au-ana"))).not.toContain("tipo_futuro_sem_regra");
  });

  it("parâmetro userId em /audit/me não troca de usuário", async () => {
    const spoof = await mine("au-bia", `?userId=${h.ids["au-ana"]}`);
    expect(JSON.stringify(spoof.json)).not.toContain("Texto enviado ao OpenRouter (ata)");
  });

  it("o admin vê o sistema por projeção: sem meetingId, sem título, tipo desconhecido só com tipo e data", async () => {
    const res = await system("au-admin", "?limit=100");
    expect(res.status).toBe(200);
    expect(kinds(res)).toEqual(expect.arrayContaining(["egress_blocked", "retention_pruned", "external_llm", "tipo_futuro_sem_regra", "auth_login"]));
    const text = JSON.stringify(res.json);
    for (const hidden of [TITLE, meeting, "valor-secreto", "extração final", "segredo"]) expect(text).not.toContain(hidden);
    const unknown = (res.json.items as Json[]).find((e) => e.kind === "tipo_futuro_sem_regra")!;
    expect(unknown).toMatchObject({ title: "tipo_futuro_sem_regra", actor: null, target: null, fields: {} });
    const pruned = (res.json.items as Json[]).find((e) => e.kind === "retention_pruned")!;
    expect(pruned.fields).toEqual({ table: "ai_usage_logs", deleted: 12, olderThanDays: 730 });
    expect((res.json.items as Json[]).find((e) => e.kind === "egress_blocked")!.fields.host).toBe("evil.example");
  });

  it("filtros por tipo, usuário e período; paginação sem repetir", async () => {
    const byKind = await system("au-admin", "?kind=external_llm&limit=100");
    expect(new Set(kinds(byKind))).toEqual(new Set(["external_llm"]));
    const byUser = await system("au-admin", `?userId=${h.ids["au-bia"]}&limit=100`);
    expect(kinds(byUser)).toEqual(expect.arrayContaining(["external_llm", "admin_user_updated"]));
    expect(JSON.stringify(byUser.json)).not.toContain("OpenRouter");
    const future = await system("au-admin", "?from=2099-01-01T00:00:00Z");
    expect(future.json.items).toEqual([]);

    const seen: number[] = [];
    let cursor = "";
    for (let i = 0; i < 40; i++) {
      const page = await system("au-admin", `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...(page.json.items as Json[]).map((e) => e.id));
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(8);
  });

  it("usuário comum não acessa a auditoria do sistema e os filtros inválidos dão 400", async () => {
    expect((await system("au-ana")).status).toBe(403);
    expect((await h.call(null, "GET", "/admin/audit")).status).toBe(401);
    expect((await system("au-admin", "?kind=nao_existe")).status).toBe(400);
    expect((await system("au-admin", "?cursor=lixo")).status).toBe(400);
    expect((await system("au-admin", "?userId=ana")).status).toBe(400);
    expect((await mine("au-ana", "?limit=1000")).status).toBe(400);
  });

  it("os tipos conhecidos para os filtros respeitam o papel", async () => {
    const user = await h.call("au-ana", "GET", "/audit/kinds");
    const admin = await h.call("au-admin", "GET", "/audit/kinds");
    const userKinds = (user.json.items as Json[]).map((k) => k.kind);
    const adminKinds = (admin.json.items as Json[]).map((k) => k.kind);
    expect(userKinds).toContain("auth_login");
    expect(userKinds).not.toContain("egress_blocked");
    expect(adminKinds).toEqual(expect.arrayContaining([...userKinds, "egress_blocked", "retention_pruned"]));
  });

  it("limite de tentativas também é auditado, na conta que foi alvo", async () => {
    for (let i = 0; i < 12; i++) await h.call(null, "POST", "/auth/login", { username: "au-bia", password: `errada-numero-${i}-xx` });
    const blocked = await h.call(null, "POST", "/auth/login", { username: "au-bia", password: "errada-de-novo-xx" });
    expect(blocked.status).toBe(429);
    const bia = await settled("au-super", "auth_login_failed", (w) => system(w, `?userId=${h.ids["au-bia"]}&kind=auth_login_failed&limit=100`));
    expect((bia.json.items as Json[]).some((e) => e.fields.rateLimited === true)).toBe(true);
  });
});
