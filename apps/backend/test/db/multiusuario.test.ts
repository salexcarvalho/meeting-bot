import type { AddressInfo } from "net";
import type { Server } from "http";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// O bot real abriria Chromium/PulseAudio: aqui ele só se registra como ativo.
vi.mock("../../src/bot/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bot/runner")>();
  const state = await import("../../src/bot/state");
  return {
    ...original,
    startBot: (meetingId: string, _url: string, _platform: string, launch: { displayName: string; urlKey: string; requestedAt: number }) => {
      state.activeBots.set(meetingId, {
        abort: new AbortController(),
        done: Promise.resolve(),
        urlKey: launch.urlKey,
        displayName: launch.displayName,
        requestedAt: launch.requestedAt,
        stage: "preparing",
        stageAt: launch.requestedAt,
      });
    },
  };
});

const PASSWORD = "senha-forte-123";

describe.skipIf(!enabled)("plataforma multiusuário (HTTP + Postgres)", async () => {
  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { activeBots } = await import("../../src/bot/state");

  let server: Server;
  let base = "";
  const hash = await hashPassword(PASSWORD);
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  async function call(who: string | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (who) headers.cookie = cookies[who];
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  async function login(username: string, password = PASSWORD) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { status: res.status, cookie, json: await res.json() };
  }

  async function meeting(who: string, title: string) {
    const start = new Date(Date.now() + 3600_000).toISOString();
    const res = await call(who, "POST", "/meetings/scheduled", { title, start, durationMinutes: 30 });
    expect(res.status).toBe(201);
    return res.json.id as string;
  }

  const audit = async (kind: string) =>
    (await pool.query(`SELECT detail, user_id FROM audit_log WHERE kind = $1 ORDER BY id`, [kind])).rows;

  beforeAll(async () => {
    await migrate(pool);
    for (const [name, role] of [
      ["mu-super", "SUPER_ADMIN"],
      ["mu-admin", "ADMIN"],
      ["mu-ana", "USER"],
      ["mu-bia", "USER"],
      ["mu-leitor", "VIEWER"],
    ] as const) {
      ids[name] = (await createUser(name, hash, { role })).id;
    }
    server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const name of Object.keys(ids)) {
      const res = await login(name);
      expect(res.status).toBe(200);
      cookies[name] = res.cookie;
    }
  });

  afterAll(async () => {
    server?.close();
    await pool.end();
  });

  describe("RBAC", () => {
    it("bootstrap: base sem papéis dá SUPER_ADMIN ao usuário mais antigo e USER aos demais", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM user_roles");
        const { rbacSeedStatements } = await import("../../src/authz/matrix");
        for (const sql of rbacSeedStatements()) await client.query(sql);
        const { rows } = await client.query(
          `SELECT r.key, count(*)::int AS n,
                  bool_or(u.id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)) AS has_oldest
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
            GROUP BY r.key`,
        );
        const byRole = Object.fromEntries(rows.map((r) => [r.key, r]));
        expect(byRole.SUPER_ADMIN).toMatchObject({ n: 1, has_oldest: true });
        expect(Object.keys(byRole).sort()).toEqual(["SUPER_ADMIN", "USER"]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("sessão traz papéis e permissões", async () => {
      const me = await call("mu-leitor", "GET", "/auth/me");
      expect(me.json.roles).toEqual(["VIEWER"]);
      expect(me.json.permissions).toContain("meetings.read");
      expect(me.json.permissions).not.toContain("meetings.manage");
    });

    it("leitor não cria reunião nem importa convite; usuário comum não vê administração", async () => {
      const start = new Date().toISOString();
      expect((await call("mu-leitor", "POST", "/meetings/scheduled", { title: "x", start, durationMinutes: 30 })).status).toBe(403);
      expect((await call("mu-leitor", "POST", "/meetings", { url: "https://meet.google.com/aaa-bbbb-ccc" })).status).toBe(403);
      expect((await call("mu-ana", "GET", "/admin/users")).status).toBe(403);
      expect((await call("mu-ana", "PATCH", `/admin/users/${ids["mu-bia"]}`, { active: false })).status).toBe(403);
      expect((await call(null, "GET", "/meetings")).status).toBe(401);
    });

    it("projeto: usuário cria, só admin renomeia ou exclui", async () => {
      const created = await call("mu-ana", "POST", "/projects", { name: "Projeto MU" });
      expect(created.status).toBe(201);
      expect((await call("mu-ana", "PATCH", `/projects/${created.json.id}`, { name: "Outro" })).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/projects/${created.json.id}`, { name: "Projeto MU 2" })).status).toBe(200);
      expect((await call("mu-ana", "DELETE", `/projects/${created.json.id}`)).status).toBe(403);
      expect((await call("mu-admin", "DELETE", `/projects/${created.json.id}`)).status).toBe(204);
    });
  });

  describe("isolamento", () => {
    let anaMeeting = "";
    let itemId = "";

    beforeAll(async () => {
      anaMeeting = await meeting("mu-ana", "Reunião privada da Ana");
      const item = await call("mu-ana", "POST", `/meetings/${anaMeeting}/items`, {
        type: "decisao",
        description: "Usar filas na integração",
      });
      expect(item.status).toBe(201);
      itemId = item.json.id;
    });

    it("outro usuário não lista, não abre e não altera", async () => {
      const list = await call("mu-bia", "GET", "/meetings?limit=200");
      expect(list.json.meetings.map((m: { id: string }) => m.id)).not.toContain(anaMeeting);
      const day = new Date(Date.now() + 3600_000).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      const agenda = await call("mu-bia", "GET", `/agenda?date=${day}`);
      expect(agenda.json.meetings.map((m: { id: string }) => m.id)).not.toContain(anaMeeting);
      const own = await call("mu-ana", "GET", `/agenda?date=${day}`);
      expect(own.json.meetings.map((m: { id: string }) => m.id)).toContain(anaMeeting);

      for (const [method, url, body] of [
        ["GET", `/meetings/${anaMeeting}`],
        ["GET", `/meetings/${anaMeeting}/items`],
        ["GET", `/meetings/${anaMeeting}/ata`],
        ["GET", `/meetings/${anaMeeting}/resumo`],
        ["GET", `/meetings/${anaMeeting}/audio`],
        ["PATCH", `/meetings/${anaMeeting}`, { title: "hack" }],
        ["POST", `/meetings/${anaMeeting}/skip`, { skip: true }],
        ["DELETE", `/meetings/${anaMeeting}`],
        ["GET", `/items/${itemId}/history`],
        ["PATCH", `/items/${itemId}`, { description: "alterado por outra pessoa" }],
        ["POST", `/items/${itemId}/approve`],
      ] as [string, string, unknown?][]) {
        const res = await call("mu-bia", method, url, body);
        expect(res.status, `${method} ${url}`).toBe(404);
      }
      // rotas diferenciam maiúsculas: variações não chegam aos handlers nem pulam a checagem
      for (const [method, url] of [
        ["GET", `/Meetings/${anaMeeting}/audio`],
        ["GET", `/MEETINGS/${anaMeeting}/ata`],
        ["POST", `/Meetings/${anaMeeting}/reprocess`],
        ["DELETE", `/Meetings/${anaMeeting}`],
        ["PATCH", `/ITEMS/${itemId}`],
      ] as [string, string][]) {
        const res = await call("mu-bia", method, url, method === "PATCH" ? { description: "x" } : undefined);
        expect(res.status, `${method} ${url}`).toBe(404);
      }
      // nem o super administrador lê conteúdo alheio por padrão (Q2)
      expect((await call("mu-super", "GET", `/meetings/${anaMeeting}`)).status).toBe(404);
      expect((await call("mu-ana", "GET", `/meetings/${anaMeeting}`)).status).toBe(200);
      const resumo = await call("mu-ana", "GET", `/meetings/${anaMeeting}/resumo`);
      expect(resumo.status).toBe(200);
      // item manual nasce aprovado: entra no resumo
      expect(resumo.json).toMatchObject({ approved: 1, pending: 0 });
      expect(resumo.json.text).toContain("Decisões\n- Usar filas na integração");
    });

    it("compartilhamento de leitura libera só a leitura", async () => {
      await pool.query(
        `INSERT INTO meeting_shares (meeting_id, user_id, access, granted_by) VALUES ($1, $2, 'read', $3)`,
        [anaMeeting, ids["mu-leitor"], ids["mu-ana"]],
      );
      expect((await call("mu-leitor", "GET", `/meetings/${anaMeeting}`)).status).toBe(200);
      expect((await call("mu-leitor", "GET", `/items/${itemId}/history`)).status).toBe(200);
      const list = await call("mu-leitor", "GET", "/meetings?limit=200");
      expect(list.json.meetings.map((m: { id: string }) => m.id)).toContain(anaMeeting);
      expect((await call("mu-leitor", "PATCH", `/meetings/${anaMeeting}`, { title: "hack" })).status).toBe(403);
      expect((await call("mu-leitor", "POST", `/items/${itemId}/approve`)).status).toBe(403);
    });

    it("compartilhamento de edição permite editar o conteúdo; agenda, gravação e exclusão ficam com o dono", async () => {
      await pool.query(
        `INSERT INTO meeting_shares (meeting_id, user_id, access, granted_by) VALUES ($1, $2, 'edit', $3)`,
        [anaMeeting, ids["mu-bia"], ids["mu-ana"]],
      );
      for (const [method, url, body] of [
        ["PATCH", `/meetings/${anaMeeting}`, { title: "Ajustado pela Bia" }],
        ["POST", `/meetings/${anaMeeting}/skip`, { skip: true }],
        ["POST", `/meetings/${anaMeeting}/record`],
        ["POST", `/meetings/${anaMeeting}/end`],
        ["POST", `/meetings/${anaMeeting}/reprocess`, { step: "all" }],
      ] as [string, string, unknown?][]) {
        expect((await call("mu-bia", method, url, body)).status, `${method} ${url}`).toBe(403);
      }
      const edited = await call("mu-bia", "PATCH", `/items/${itemId}`, { description: "Usar filas com reprocessamento" });
      expect(edited.status).toBe(200);
      expect(edited.json.description).toBe("Usar filas com reprocessamento");
      expect((await call("mu-bia", "DELETE", `/meetings/${anaMeeting}`)).status).toBe(403);
    });

    it("status do sistema e agenda só citam reuniões visíveis", async () => {
      const { recordHeartbeat } = await import("../../src/recording/hostAgentState");
      recordHeartbeat({ version: "teste", capture: { meetingId: anaMeeting, channels: {} } });
      const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      for (const who of ["mu-admin", "mu-super"]) {
        const status = await call(who, "GET", "/system/status");
        expect(status.status).toBe(200);
        expect(status.json.hostAgent.online).toBe(true);
        expect(status.json.hostAgent.capture, who).toBeNull();
        const agenda = await call(who, "GET", `/agenda?date=${day}`);
        expect(agenda.json.hostAgent.capture, who).toBeNull();
      }
      const own = await call("mu-ana", "GET", "/system/status");
      expect(own.json.hostAgent.capture.meetingId).toBe(anaMeeting);
      recordHeartbeat({ version: "teste", capture: null });
    });

    it("dono do host-agent: primeiro usuário cadastrado; sem ele ativo, ninguém herda", async () => {
      const { hostAgentOwner, invalidateHostOwner } = await import("../../src/recording/owner");
      const { rows } = await pool.query(
        `SELECT u.id, u.active, EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                          WHERE ur.user_id = u.id AND r.key = 'SUPER_ADMIN') AS super
           FROM users u ORDER BY created_at, id LIMIT 1`,
      );
      const first = rows[0];
      invalidateHostOwner();
      expect((await hostAgentOwner())?.id ?? null).toBe(first.active && first.super ? first.id : null);
      await pool.query(`UPDATE users SET active = false WHERE id = $1`, [first.id]);
      try {
        invalidateHostOwner();
        expect(await hostAgentOwner()).toBeNull();
      } finally {
        await pool.query(`UPDATE users SET active = $2 WHERE id = $1`, [first.id, first.active]);
        invalidateHostOwner();
      }
    });

    it("mesmo convite importado por duas pessoas vira duas reuniões", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mu-ics-"));
      try {
        const out = path.join(dir, "convite.ics");
        execFileSync(path.join(__dirname, "../../../../scripts/fixture-ics.sh"), ["90", "30", out]);
        for (const who of ["mu-ana", "mu-bia"]) {
          const form = new FormData();
          form.append("files", new Blob([readFileSync(out)], { type: "text/calendar" }), "convite.ics");
          const res = await call(who, "POST", "/calendar/import", form);
          expect(res.status).toBe(200);
          expect(res.json.created).toBe(1);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("administração de usuários", () => {
    it("admin cria usuário comum, mas não administrador", async () => {
      const ok = await call("mu-admin", "POST", "/admin/users", {
        username: "mu-novo",
        password: PASSWORD,
        realName: "Novo Usuário",
        role: "USER",
      });
      expect(ok.status).toBe(201);
      expect(ok.json).toMatchObject({ username: "mu-novo", roles: ["USER"], name: "Novo Usuário" });
      ids["mu-novo"] = ok.json.id;
      expect((await call("mu-admin", "POST", "/admin/users", { username: "mu-x", password: PASSWORD, role: "SUPER_ADMIN" })).status).toBe(403);
      expect((await call("mu-admin", "POST", "/admin/users", { username: "mu-y", password: PASSWORD, role: "ADMIN" })).status).toBe(403);
      expect((await call("mu-admin", "POST", "/admin/users", { username: "mu-novo", password: PASSWORD })).status).toBe(409);
      expect((await call("mu-admin", "POST", "/admin/users", { username: "mu-z", password: "curta" })).status).toBe(400);
      const [entry] = await audit("admin_user_created");
      expect(entry).toMatchObject({ user_id: ids["mu-admin"], detail: { username: "mu-novo" } });
    });

    it("admin não mexe em administradores nem em si mesmo", async () => {
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-super"]}`, { active: false })).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-novo"]}`, { roles: ["ADMIN"] })).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-admin"]}`, { active: false })).status).toBe(403);
      expect((await call("mu-admin", "POST", `/admin/users/${ids["mu-super"]}/reset-password`, { password: PASSWORD })).status).toBe(403);
    });

    it("desativar derruba as sessões e bloqueia o login; reativar volta", async () => {
      const session = await login("mu-novo");
      cookies["mu-novo"] = session.cookie;
      expect((await call("mu-novo", "GET", "/me")).status).toBe(200);
      const off = await call("mu-admin", "PATCH", `/admin/users/${ids["mu-novo"]}`, { active: false });
      expect(off.status).toBe(200);
      expect(off.json.active).toBe(false);
      expect((await call("mu-novo", "GET", "/me")).status).toBe(401);
      expect((await login("mu-novo")).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-novo"]}`, { active: true })).status).toBe(200);
      expect((await login("mu-novo")).status).toBe(200);
      expect((await audit("admin_user_deactivated")).at(-1)?.detail).toEqual({ target: ids["mu-novo"] });
    });

    it("papéis: super promove, rebaixado perde acesso na hora, e sempre sobra um super ativo", async () => {
      expect((await call("mu-super", "PATCH", `/admin/users/${ids["mu-admin"]}`, { roles: ["SUPER_ADMIN"] })).status).toBe(200);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-admin"]}`, { roles: ["USER"] })).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-super"]}`, { roles: ["USER"] })).status).toBe(200);
      expect((await call("mu-super", "GET", "/admin/users")).status).toBe(403);
      expect((await call("mu-admin", "PATCH", `/admin/users/${ids["mu-super"]}`, { roles: ["SUPER_ADMIN"] })).status).toBe(200);

      // Dois supers se rebaixando ao mesmo tempo: a trava serializa e ao menos um continua.
      const activeSupers = async () =>
        (
          await pool.query(
            `SELECT u.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
              WHERE r.key = 'SUPER_ADMIN' AND u.active`,
          )
        ).rows.map((r) => r.id as string);
      const others = (await activeSupers()).filter((id) => id !== ids["mu-super"] && id !== ids["mu-admin"]);
      await pool.query(`UPDATE users SET active = false WHERE id = ANY($1)`, [others]);
      try {
        const [a, b] = await Promise.all([
          call("mu-super", "PATCH", `/admin/users/${ids["mu-admin"]}`, { roles: ["ADMIN"] }),
          call("mu-admin", "PATCH", `/admin/users/${ids["mu-super"]}`, { roles: ["ADMIN"] }),
        ]);
        expect([a.status, b.status]).toContain(200);
        expect((await activeSupers()).length).toBeGreaterThanOrEqual(1);
      } finally {
        await pool.query(`UPDATE users SET active = true WHERE id = ANY($1)`, [others]);
      }
      // estado final previsível para os próximos testes
      await pool.query(
        `DELETE FROM user_roles WHERE user_id = ANY($1);
         `.trim().replace(/;$/, ""),
        [[ids["mu-super"], ids["mu-admin"]]],
      );
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
           SELECT $1::uuid, id FROM roles WHERE key = 'SUPER_ADMIN'
           UNION ALL SELECT $2::uuid, id FROM roles WHERE key = 'ADMIN'`,
        [ids["mu-super"], ids["mu-admin"]],
      );
      const changes = await audit("admin_user_roles_changed");
      expect(changes.some((c) => c.detail.target === ids["mu-admin"] && c.user_id === ids["mu-super"])).toBe(true);
    });

    it("reset de senha troca a senha e encerra as sessões", async () => {
      const novo = await login("mu-novo");
      cookies["mu-novo"] = novo.cookie;
      const res = await call("mu-super", "POST", `/admin/users/${ids["mu-novo"]}/reset-password`, { password: "outra-senha-456" });
      expect(res.status).toBe(204);
      expect((await call("mu-novo", "GET", "/me")).status).toBe(401);
      expect((await login("mu-novo", PASSWORD)).status).toBe(401);
      expect((await login("mu-novo", "outra-senha-456")).status).toBe(200);
    });

    it("lista usuários com papéis e contagem de reuniões", async () => {
      const res = await call("mu-super", "GET", "/admin/users");
      expect(res.status).toBe(200);
      const ana = res.json.users.find((u: { username: string }) => u.username === "mu-ana");
      expect(ana).toMatchObject({ roles: ["USER"], active: true });
      expect(ana.meetingCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("perfil, agente e identidade do bot", () => {
    it("perfil e agente persistem e definem o nome do bot", async () => {
      const profile = await call("mu-ana", "PATCH", "/me/profile", {
        realName: "Ana Souza",
        displayName: "Ana",
        timezone: "America/Sao_Paulo",
      });
      expect(profile.status).toBe(200);
      expect(profile.json.profile).toMatchObject({ realName: "Ana Souza", displayName: "Ana", name: "Ana" });
      expect((await call("mu-ana", "PATCH", "/me/profile", { timezone: "Marte/Olympus" })).status).toBe(400);

      const agent = await call("mu-ana", "PATCH", "/me/agent", {
        name: "Orion",
        description: "Arquiteto de software",
        priorityTechnologies: ["Kafka", "Kafka", "PostgreSQL"],
        tone: "direto",
      });
      expect(agent.status).toBe(200);
      expect(agent.json.agent).toMatchObject({ name: "Orion", tone: "direto", priorityTechnologies: ["Kafka", "PostgreSQL"] });
      expect(agent.json.botDisplayName).toBe("Orion - assistente gravando");

      const settings = await call("mu-ana", "PATCH", "/me/settings", { meetings: { displayIdentity: "user" } });
      expect(settings.json.botDisplayName).toBe("Ana - assistente gravando");
      expect((await call("mu-ana", "PATCH", "/me/settings", { meetings: { displayIdentity: "custom" } })).status).toBe(400);
      expect((await call("mu-ana", "PATCH", "/me/settings", { meetings: { hack: 1 } })).status).toBe(400);

      const preview = await call("mu-ana", "POST", "/me/identity-preview", { mode: "custom", customName: "Sala <3>" });
      expect(preview.json.botDisplayName).toBe("Sala 3 - assistente gravando");

      // a sessão reflete o nome
      const me = await call("mu-ana", "GET", "/auth/me");
      expect(me.json).toMatchObject({ displayName: "Ana", agentName: "Orion" });
      // o de outro usuário não muda
      expect((await call("mu-bia", "GET", "/me")).json.agent.name).toBe("Assistente");
    });

    it("foto: aceita PNG real, recusa outro conteúdo e remove", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const bad = new FormData();
      bad.append("file", new Blob(["<svg/>"], { type: "image/png" }), "x.png");
      expect((await call("mu-ana", "PUT", "/me/avatar", bad)).status).toBe(400);

      const form = new FormData();
      form.append("file", new Blob([png], { type: "image/png" }), "foto.png");
      const up = await call("mu-ana", "PUT", "/me/avatar", form);
      expect(up.status).toBe(200);
      expect(up.json.profile.hasAvatar).toBe(true);

      const got = await fetch(`${base}/api/me/avatar?v=${up.json.profile.avatarVersion}`, { headers: { cookie: cookies["mu-ana"] } });
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("image/png");
      expect(got.headers.get("cache-control")).toContain("immutable");
      expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
      // outro usuário não tem foto (e não acessa a da Ana por esta rota)
      expect((await call("mu-bia", "GET", "/me/avatar")).status).toBe(404);

      const agentUp = new FormData();
      agentUp.append("file", new Blob([png], { type: "image/png" }), "agente.png");
      expect((await call("mu-ana", "PUT", "/me/agent/avatar", agentUp)).json.agent.hasAvatar).toBe(true);

      const del = await call("mu-ana", "DELETE", "/me/avatar");
      expect(del.json.profile.hasAvatar).toBe(false);
      expect((await call("mu-ana", "GET", "/me/avatar")).status).toBe(404);

      const big = new FormData();
      big.append("file", new Blob([Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])]), "grande.png");
      expect((await call("mu-ana", "PUT", "/me/avatar", big)).status).toBe(413);
    });

    it("voz do agente: converte, mede e limita a duração", async () => {
      const wav = (seconds: number) => {
        const data = Buffer.alloc(16000 * 2 * seconds);
        for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
        const header = Buffer.alloc(44);
        header.write("RIFF", 0, "latin1");
        header.writeUInt32LE(36 + data.length, 4);
        header.write("WAVEfmt ", 8, "latin1");
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(16000, 24);
        header.writeUInt32LE(32000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write("data", 36, "latin1");
        header.writeUInt32LE(data.length, 40);
        return Buffer.concat([header, data]);
      };
      const form = new FormData();
      form.append("file", new Blob([wav(3)], { type: "audio/wav" }), "voz.wav");
      const up = await call("mu-ana", "PUT", "/me/agent/voice", form);
      expect(up.status).toBe(200);
      expect(up.json.agent.hasVoice).toBe(true);
      expect(up.json.agent.voiceDurationSeconds).toBeCloseTo(3, 0);
      const got = await fetch(`${base}/api/me/agent/voice`, { headers: { cookie: cookies["mu-ana"] } });
      expect(got.headers.get("content-type")).toBe("audio/ogg");
      expect(Buffer.from(await got.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("OggS");

      const long = new FormData();
      long.append("file", new Blob([wav(62)], { type: "audio/wav" }), "longa.wav");
      const tooLong = await call("mu-ana", "PUT", "/me/agent/voice", long);
      expect(tooLong.status).toBe(400);
      expect(tooLong.json.error).toMatch(/60 segundos/);
      // a anterior continua
      expect((await call("mu-ana", "GET", "/me")).json.agent.hasVoice).toBe(true);
      expect((await call("mu-ana", "DELETE", "/me/agent/voice")).json.agent.hasVoice).toBe(false);
    });

    it("bot entra com a identidade escolhida e não duplica o mesmo link", async () => {
      const url = "https://meet.google.com/mux-abcd-efg";
      const first = await call("mu-ana", "POST", "/meetings", {
        url,
        title: "Com bot",
        identity: { mode: "agent" },
      });
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: "joining", botDisplayName: "Orion - assistente gravando", botActive: true });
      expect(first.json.botProgress).toMatchObject({ stage: "preparing" });

      const again = await call("mu-ana", "POST", "/meetings", { url: `${url}?authuser=0` });
      expect(again.status).toBe(409);
      expect(again.json.meetingId).toBe(first.json.id);

      // outra pessoa recebe o conflito sem o id da reunião alheia
      const other = await call("mu-bia", "POST", "/meetings", { url });
      expect(other.status).toBe(409);
      expect(other.json.meetingId).toBeNull();

      // cliques simultâneos: só um passa
      const url2 = "https://meet.google.com/muy-abcd-efg";
      const results = await Promise.all([1, 2, 3].map(() => call("mu-bia", "POST", "/meetings", { url: url2 })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);

      expect((await call("mu-ana", "POST", "/meetings", { url: "https://meet.google.com/muz", identity: { mode: "custom" } })).status).toBe(400);
      activeBots.clear();
    });
  });

  describe("gerar ata e ADR sob demanda", async () => {
    const { setAdrGeneration, isProcessing } = await import("../../src/pipeline");
    let id = "";
    const decision: Record<string, string> = {};
    const adrUrl = () => `/meetings/${id}/adrs/generate`;

    async function addItem(type: string, description: string) {
      const res = await call("mu-ana", "POST", `/meetings/${id}/items`, { type, description });
      expect(res.status).toBe(201);
      return res.json.id as string;
    }

    beforeAll(async () => {
      id = await meeting("mu-ana", "Revisão de arquitetura");
      await pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [id]);
      decision.livre = await addItem("decisao_arquitetural", "Adotar fila de mensagens entre os serviços");
      decision.aprovado = await addItem("decisao_arquitetural", "Usar PostgreSQL como banco principal");
      decision.comum = await addItem("decisao", "Reunião semanal às terças");
      await pool.query(
        `INSERT INTO adrs (item_id, meeting_id, title, context, problem, decision, consequences, status)
         VALUES ($1, $2, 'PostgreSQL', 'c', 'p', 'd', 'q', 'aprovado')`,
        [decision.aprovado, id],
      );
      await pool.query(
        `INSERT INTO meeting_shares (meeting_id, user_id, access, granted_by)
         VALUES ($1, $2, 'read', $4), ($1, $3, 'edit', $4)`,
        [id, ids["mu-leitor"], ids["mu-bia"], ids["mu-ana"]],
      );
    });

    it("exige transcrição final", async () => {
      const res = await call("mu-ana", "POST", adrUrl(), {});
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/Gere a ata primeiro/);
      await pool.query(
        `INSERT INTO transcript_segments (meeting_id, speaker, text, start_seconds, end_seconds, channel, pass)
         VALUES ($1, 'Sérgio', 'Vamos adotar fila de mensagens.', 0, 4, 'mic', 'final')`,
        [id],
      );
    });

    it("só o dono gera: leitor e edição recebem 403, quem não vê recebe 404", async () => {
      expect((await call("mu-leitor", "POST", adrUrl(), {})).status).toBe(403);
      expect((await call("mu-bia", "POST", adrUrl(), {})).status).toBe(403);
      expect((await call("mu-bia", "POST", `/meetings/${id}/reprocess`, { step: "analysis" })).status).toBe(403);
      expect((await call("mu-admin", "POST", adrUrl(), {})).status).toBe(404);
    });

    it("recusa escolha inválida, externo desligado, item errado e ADR já revisado", async () => {
      expect((await call("mu-ana", "POST", adrUrl(), { llm: "gpt" })).status).toBe(400);
      const external = await call("mu-ana", "POST", adrUrl(), { llm: "openrouter" });
      expect(external.status).toBe(400);
      expect(external.json.error).toMatch(/ALLOW_EXTERNAL_LLM/);
      const reprocess = await call("mu-ana", "POST", `/meetings/${id}/reprocess`, { step: "analysis", llm: "openrouter" });
      expect(reprocess.status).toBe(400);
      expect((await call("mu-ana", "POST", `/meetings/${id}/reprocess`, { step: "analysis", llm: "x" })).status).toBe(400);

      expect((await call("mu-ana", "POST", adrUrl(), { itemId: decision.comum })).status).toBe(400);
      expect((await call("mu-ana", "POST", adrUrl(), { itemId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
      const locked = await call("mu-ana", "POST", adrUrl(), { itemId: decision.aprovado });
      expect(locked.status).toBe(409);
      expect(locked.json.error).toMatch(/aprovad/i);

      const other = await meeting("mu-ana", "Sem decisões arquiteturais");
      await pool.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [other]);
      await pool.query(
        `INSERT INTO transcript_segments (meeting_id, text, start_seconds, end_seconds, channel, pass)
         VALUES ($1, 'nada', 0, 1, 'mic', 'final')`,
        [other],
      );
      expect((await call("mu-ana", "POST", `/meetings/${other}/adrs/generate`, {})).status).toBe(409);
      expect((await call("mu-ana", "POST", `/meetings/${other}/adrs/generate`, { itemId: decision.livre })).status).toBe(404);
      expect(isProcessing(id)).toBe(false);
    });

    it("enfileira com o provedor padrão, audita e não mexe no status da reunião", async () => {
      const runs: { meetingId: string; provider: string; itemId?: string }[] = [];
      setAdrGeneration(async (meetingId, _report, provider, itemId) => {
        runs.push({ meetingId, provider, itemId });
        return { generated: 1, skipped: 0, failed: 0 };
      });
      const res = await call("mu-ana", "POST", adrUrl(), { itemId: decision.livre });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ status: "queued", provider: expect.stringMatching(/^local:/) });
      await expect.poll(() => isProcessing(id)).toBe(false);
      expect(runs).toEqual([{ meetingId: id, provider: "local", itemId: decision.livre }]);

      const rows = (await audit("generation_requested")).filter((r) => r.detail.meetingId === id);
      expect(rows).toEqual([
        {
          user_id: ids["mu-ana"],
          detail: { meetingId: id, step: "adrs", itemId: decision.livre, provider: res.json.provider },
        },
      ]);
      const { rows: status } = await pool.query(`SELECT status FROM meetings WHERE id = $1`, [id]);
      expect(status[0].status).toBe("done");
    });

    it("reinício: quem estava gerando a ata retoma só a análise", async () => {
      const { recoverInterruptedMeetings } = await import("../../src/db");
      const transcribing = await meeting("mu-ana", "Transcrição interrompida");
      await pool.query(`UPDATE meetings SET status = 'generating_ata' WHERE id = $1`, [id]);
      await pool.query(`UPDATE meetings SET status = 'transcribing' WHERE id = $1`, [transcribing]);
      try {
        const resumed = await recoverInterruptedMeetings();
        expect(resumed).toEqual(expect.arrayContaining([{ id, step: "analysis" }, { id: transcribing, step: "all" }]));
      } finally {
        await pool.query(`UPDATE meetings SET status = 'done' WHERE id = ANY($1)`, [[id, transcribing]]);
      }
    });
  });
});
