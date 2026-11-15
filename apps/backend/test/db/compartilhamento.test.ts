import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// O bot real abriria Chromium/PulseAudio: aqui nenhum teste o usa, mas o runner importa Playwright.
vi.mock("../../src/bot/runner", async (importOriginal) => importOriginal<typeof import("../../src/bot/runner")>());

const PASSWORD = "senha-forte-123";
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const SHARES = "shares";

type Json = any;

describe.skipIf(!enabled)("compartilhamento de reunião (HTTP + WebSocket + Postgres)", async () => {
  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { hub } = await import("../../src/live/hub");
  const { notifyMeeting } = await import("../../src/live/notify");
  const { buildRouter } = await import("../../src/routes");
  const { OWNER_ONLY_ROUTES } = await import("../../src/authz/ownerOnly");

  let server: Server;
  let base = "";
  let port = 0;
  const hash = await hashPassword(PASSWORD);
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  async function raw(who: string | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { origin: base };
    if (who) headers.cookie = cookies[who];
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  const call = (who: string | null, method: string, url: string, body?: unknown) => raw(who, method, `/api${url}`, body);

  async function login(username: string) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  async function meeting(who: string, title: string, hoursAhead = 48): Promise<string> {
    const start = new Date(Date.now() + hoursAhead * 3600_000).toISOString();
    const res = await call(who, "POST", "/meetings/scheduled", { title, start, durationMinutes: 30 });
    expect(res.status).toBe(201);
    return res.json.id as string;
  }

  const share = (who: string, id: string, user: string, access: string, scope?: string) =>
    call(who, "POST", `/meetings/${id}/${SHARES}`, { userId: ids[user], access, ...(scope ? { scope } : {}) });

  async function shareRows(meetingId: string): Promise<{ user_id: string; access: string; seen_at: Date | null }[]> {
    return (await pool.query(`SELECT user_id, access, seen_at FROM meeting_shares WHERE meeting_id = $1`, [meetingId])).rows;
  }

  const hasShare = async (meetingId: string, user: string) =>
    (await shareRows(meetingId)).find((r) => r.user_id === ids[user]) ?? null;

  async function waitAudit(kind: string, count: number) {
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query(`SELECT detail, user_id FROM audit_log WHERE kind = $1 ORDER BY id`, [kind]);
      if (rows.length >= count) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`auditoria ${kind} não chegou a ${count} registros`);
  }

  // ---- WebSocket ----

  interface Conn {
    ws: WebSocket;
    messages: Json[];
    send(msg: unknown): void;
    close(): void;
  }

  async function connect(who: string): Promise<Conn> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie: cookies[who], origin: base } });
    const messages: Json[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, messages, send: (msg) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
  }

  async function until(predicate: () => boolean, ms = 2000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return predicate();
  }

  /** Inscreve na reunião e espera o hub confirmar o acesso (checagem assíncrona) pelo primeiro evento que chega. */
  async function subscribe(conn: Conn, meetingId: string): Promise<void> {
    conn.send({ type: "subscribe", topic: "meeting", meetingId });
    const marker = `inscrito-${meetingId}-${conn.messages.length}`;
    const ok = await until(() => {
      hub.publishToMeeting(meetingId, { type: "summary", meetingId, text: marker, at: new Date().toISOString() });
      return conn.messages.some((m) => m.type === "summary" && m.text === marker);
    }, 3000);
    expect(ok, "inscrição na reunião").toBe(true);
  }

  const accessEvents = (conn: Conn, meetingId: string) =>
    conn.messages.filter((m) => m.type === "meeting_access" && m.meetingId === meetingId);

  beforeAll(async () => {
    await migrate(pool);
    const specs: [string, string, string | null][] = [
      ["cs-ana", "USER", "Ana Lima"],
      ["cs-bia", "USER", "Bia Souza"],
      ["cs-edu", "USER", "Edu Rocha"],
      ["cs-leo", "VIEWER", "Leo Viana"],
      ["cs-admin", "ADMIN", "Admin Geral"],
      ["cs-super", "SUPER_ADMIN", null],
      ["cs-zed", "USER", "Zed Estranho"],
      ["cs-off", "USER", "Off Desativado"],
      ["cs-dono", "USER", "Dono Temporário"],
      ["cs-rate", "USER", null],
      ["cs-jose", "USER", "José Conceição"],
      ["cs-inativo", "USER", "Inativo Antigo"],
    ];
    for (const [name, role, realName] of specs) {
      ids[name] = (await createUser(name, hash, { role: role as "USER", realName })).id;
    }
    for (let i = 1; i <= 10; i++) {
      const name = `cs-lote${String(i).padStart(2, "0")}`;
      ids[name] = (await createUser(name, hash, { role: "USER" })).id;
    }
    await pool.query(`UPDATE users SET active = false WHERE id = $1`, [ids["cs-inativo"]]);
    server = createApp().listen(0);
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/api/live")) void hub.handleUpgrade(req, socket, head);
    });
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    for (const name of Object.keys(ids)) {
      if (name === "cs-inativo") continue;
      const res = await login(name);
      expect(res.status, name).toBe(200);
      cookies[name] = res.cookie;
    }
  });

  afterAll(async () => {
    hub.close();
    server?.close();
    await pool.end();
  });

  // ---------------------------------------------------------------- migração

  describe("migração", () => {
    it("é idempotente: rodar de novo não remarca acessos como novos", async () => {
      const id = await meeting("cs-ana", "Migração idempotente");
      expect((await share("cs-ana", id, "cs-bia", "read")).status).toBe(201);
      expect((await hasShare(id, "cs-bia"))!.seen_at).toBeNull();
      await migrate(pool);
      await migrate(pool);
      expect((await hasShare(id, "cs-bia"))!.seen_at).toBeNull();
      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'meeting_shares' AND column_name IN ('seen_at', 'updated_at')`,
      );
      expect(cols.rowCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------- US1

  describe("US1: conceder", () => {
    let id = "";
    let itemId = "";

    beforeAll(async () => {
      id = await meeting("cs-ana", "Planejamento confidencial");
      const item = await call("cs-ana", "POST", `/meetings/${id}/items`, { type: "decisao", description: "Adotar a fila de mensagens" });
      expect(item.status).toBe(201);
      itemId = item.json.id;
    });

    it("concede leitura: o destinatário abre a reunião e não edita item", async () => {
      expect((await call("cs-bia", "GET", `/meetings/${id}`)).status).toBe(404);
      const res = await share("cs-ana", id, "cs-bia", "read");
      expect(res.status).toBe(201);
      expect(res.json.affected).toBe(1);
      expect(res.json.share).toMatchObject({
        userId: ids["cs-bia"],
        username: "cs-bia",
        name: "Bia Souza",
        access: "read",
        effectiveAccess: "read",
        active: true,
        seen: false,
      });
      const detail = await call("cs-bia", "GET", `/meetings/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ access: "read", ownerName: "Ana Lima" });
      expect((await call("cs-ana", "GET", `/meetings/${id}`)).json.ownerName).toBeNull();
      expect((await call("cs-bia", "PATCH", `/items/${itemId}`, { description: "Mudar a decisão sem permissão" })).status).toBe(403);
    });

    it("auditoria do grant guarda só ids, nível e alcance, nunca título", async () => {
      const rows = await waitAudit("meeting_share_granted", 2);
      const row = rows.find((r) => r.detail.meetingId === id)!;
      expect(row.user_id).toBe(ids["cs-ana"]);
      expect(row.detail).toEqual({ meetingId: id, target: ids["cs-bia"], access: "read", scope: "occurrence", affected: 1 });
      expect(JSON.stringify(rows)).not.toContain("Planejamento");
    });

    it("duplicado devolve 409 e não altera o nível", async () => {
      const again = await share("cs-ana", id, "cs-bia", "edit");
      expect(again.status).toBe(409);
      expect(again.json.error).toMatch(/já está compartilhada/);
      expect((await hasShare(id, "cs-bia"))!.access).toBe("read");
    });

    it("recusa o próprio dono, usuário inexistente e desativado com a mesma mensagem", async () => {
      const self = await share("cs-ana", id, "cs-ana", "read");
      const ghost = await call("cs-ana", "POST", `/meetings/${id}/${SHARES}`, { userId: ZERO_UUID, access: "read" });
      const off = await share("cs-ana", id, "cs-inativo", "read");
      for (const res of [self, ghost, off]) {
        expect(res.status).toBe(422);
        expect(res.json.error).toBe("Não foi possível compartilhar com este usuário.");
      }
      expect((await shareRows(id)).map((r) => r.user_id)).toEqual([ids["cs-bia"]]);
    });

    it("VIEWER só recebe leitura; edição é recusada (422)", async () => {
      const edit = await share("cs-ana", id, "cs-leo", "edit");
      expect(edit.status).toBe(422);
      expect(edit.json.error).toBe("Este usuário só pode receber leitura.");
      expect(await hasShare(id, "cs-leo")).toBeNull();
      const read = await share("cs-ana", id, "cs-leo", "read");
      expect(read.status).toBe(201);
      expect((await call("cs-leo", "GET", `/meetings/${id}`)).status).toBe(200);
    });

    it("corpo inválido devolve 400", async () => {
      for (const body of [{}, { userId: ids["cs-edu"] }, { userId: ids["cs-edu"], access: "owner" }, { userId: "bia", access: "read" }]) {
        expect((await call("cs-ana", "POST", `/meetings/${id}/${SHARES}`, body)).status).toBe(400);
      }
      expect((await share("cs-ana", id, "cs-edu", "read", "tudo")).status).toBe(400);
    });

    it("edição permite mexer no conteúdo; gravação, agenda, link e exclusão continuam do dono", async () => {
      expect((await share("cs-ana", id, "cs-edu", "edit")).status).toBe(201);
      const edited = await call("cs-edu", "PATCH", `/items/${itemId}`, { description: "Adotar fila com reprocessamento" });
      expect(edited.status).toBe(200);
      for (const route of OWNER_ONLY_ROUTES) {
        const method = ({ "/meetings/:id": "PATCH", "/meetings/:id/extract-items": "PUT" } as Record<string, string>)[route] ?? "POST";
        const url = route.replace(":id", id);
        expect((await call("cs-edu", method, url, {})).status, `${method} ${url}`).toBe(403);
      }
      expect((await call("cs-edu", "DELETE", `/meetings/${id}`)).status).toBe(403);
    });

    it("o destinatário não gerencia compartilhamento nem com edição: 403 em todos os métodos, inclusive GET", async () => {
      for (const who of ["cs-edu", "cs-bia", "cs-leo"]) {
        const target = ids["cs-zed"];
        expect((await call(who, "GET", `/meetings/${id}/${SHARES}`)).status, `${who} GET`).toBe(403);
        expect((await share(who, id, "cs-zed", "read")).status, `${who} POST`).toBe(403);
        expect((await call(who, "PUT", `/meetings/${id}/${SHARES}/${target}`, { access: "read" })).status, `${who} PUT`).toBe(403);
        expect((await call(who, "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`)).status, `${who} DELETE`).toBe(403);
      }
      expect(await hasShare(id, "cs-zed")).toBeNull();
      expect(await hasShare(id, "cs-bia")).not.toBeNull();
    });

    it("GET /shares não vaza a lista a quem só lê; o dono vê todos", async () => {
      const own = await call("cs-ana", "GET", `/meetings/${id}/${SHARES}`);
      expect(own.status).toBe(200);
      expect(own.json.shares.map((s: Json) => s.username).sort()).toEqual(["cs-bia", "cs-edu", "cs-leo"]);
      expect(own.json.series).toBeNull();
      const leak = await call("cs-bia", "GET", `/meetings/${id}/${SHARES}`);
      expect(leak.status).toBe(403);
      expect(JSON.stringify(leak.json)).not.toContain("cs-edu");
    });
  });

  // ---------------------------------------------------------------- busca

  describe("busca de usuário (/users/lookup)", () => {
    const lookup = (who: string, q: string) => call(who, "GET", `/users/lookup?q=${encodeURIComponent(q)}`);

    it("exige 3 caracteres e devolve só id, usuário, nome e canEdit", async () => {
      expect((await lookup("cs-ana", "bi")).status).toBe(400);
      expect((await lookup("cs-ana", "  ")).status).toBe(400);
      const res = await lookup("cs-ana", "cs-bia");
      expect(res.status).toBe(200);
      expect(res.json.users).toHaveLength(1);
      expect(Object.keys(res.json.users[0]).sort()).toEqual(["canEdit", "id", "name", "username"]);
      expect(res.json.users[0]).toEqual({ id: ids["cs-bia"], username: "cs-bia", name: "Bia Souza", canEdit: true });
    });

    it("acha por palavra do nome, sem acento e sem diferenciar maiúsculas", async () => {
      for (const q of ["souza", "SOU", "jose", "JOSÉ", "conce"]) {
        const res = await lookup("cs-ana", q);
        expect(res.status, q).toBe(200);
        expect(res.json.users.map((u: Json) => u.username), q).toContain(q.toLowerCase().includes("sou") ? "cs-bia" : "cs-jose");
      }
    });

    it("VIEWER aparece com canEdit falso; desativado, o próprio e quem não lê ficam de fora", async () => {
      const viewer = (await lookup("cs-ana", "cs-leo")).json.users;
      expect(viewer).toEqual([{ id: ids["cs-leo"], username: "cs-leo", name: "Leo Viana", canEdit: false }]);
      expect((await lookup("cs-ana", "cs-inativo")).json.users).toEqual([]);
      expect((await lookup("cs-ana", "cs-ana")).json.users).toEqual([]);
    });

    it("devolve no máximo 8 resultados", async () => {
      const res = await lookup("cs-ana", "cs-lote");
      expect(res.json.users).toHaveLength(8);
    });

    it("curingas do LIKE são literais: não listam o diretório", async () => {
      for (const q of ["%%%", "___", "cs_", "c%s", "\\\\\\"]) {
        const res = await lookup("cs-ana", q);
        expect(res.status, q).toBe(200);
        expect(res.json.users, q).toEqual([]);
      }
    });

    it("VIEWER (sem meetings.manage) recebe 403; sem sessão, 401", async () => {
      expect((await lookup("cs-leo", "cs-bia")).status).toBe(403);
      expect((await call(null, "GET", "/users/lookup?q=cs-bia")).status).toBe(401);
    });

    it("varrer o diretório por prefixos esbarra no limite de taxa (429) e a conta de outro usuário não é afetada", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await lookup("cs-rate", `cs-lote0${i % 10}`)).status);
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
      const blocked = await lookup("cs-rate", "cs-bia");
      expect(blocked.status).toBe(429);
      expect(blocked.json.error).toBe("Muitas buscas. Tente de novo em instantes.");
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect((await lookup("cs-ana", "cs-bia")).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- US2

  describe("US2: alterar e revogar", () => {
    let id = "";
    let itemId = "";

    beforeAll(async () => {
      id = await meeting("cs-ana", "Revisão trimestral");
      itemId = (await call("cs-ana", "POST", `/meetings/${id}/items`, { type: "pendencia", description: "Revisar o orçamento" })).json.id;
    });

    it("troca de leitura para edição e de volta; subir para edição zera 'visto'", async () => {
      expect((await share("cs-ana", id, "cs-bia", "read")).status).toBe(201);
      expect((await call("cs-bia", "POST", `/shared-with-me/${id}/seen`)).status).toBe(204);
      expect((await hasShare(id, "cs-bia"))!.seen_at).not.toBeNull();
      const up = await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`, { access: "edit" });
      expect(up.status).toBe(200);
      expect(up.json).toMatchObject({ affected: 1, share: { access: "edit", effectiveAccess: "edit", seen: false } });
      expect((await call("cs-bia", "PATCH", `/items/${itemId}`, { description: "Revisar o orçamento anual" })).status).toBe(200);
      await call("cs-bia", "POST", `/shared-with-me/${id}/seen`);
      const down = await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`, { access: "read" });
      expect(down.json.share).toMatchObject({ access: "read", seen: true });
      expect((await call("cs-bia", "PATCH", `/items/${itemId}`, { description: "Tentativa depois do rebaixamento" })).status).toBe(403);
    });

    it("PUT: 404 se o alvo não tem acesso; mesmos 422; nível igual não altera nada", async () => {
      expect((await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-edu"]}`, { access: "read" })).status).toBe(404);
      expect((await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ZERO_UUID}`, { access: "read" })).status).toBe(404);
      expect((await share("cs-ana", id, "cs-leo", "read")).status).toBe(201);
      const edit = await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-leo"]}`, { access: "edit" });
      expect(edit.status).toBe(422);
      expect(edit.json.error).toBe("Este usuário só pode receber leitura.");
      const same = await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`, { access: "read" });
      expect(same.status).toBe(200);
      expect(same.json.affected).toBe(0);
      expect((await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`, { access: "x" })).status).toBe(400);
    });

    it("auditoria de alterar guarda de/para e nunca o título", async () => {
      const rows = await waitAudit("meeting_share_changed", 2);
      const detail = rows.map((r) => r.detail).filter((d) => d.meetingId === id);
      expect(detail[0]).toEqual({ meetingId: id, target: ids["cs-bia"], from: "read", to: "edit", scope: "occurrence", affected: 1 });
      expect(JSON.stringify(rows)).not.toContain("Revisão");
    });

    it("revoga: a próxima requisição devolve 404, a reunião some da lista e a auditoria registra só ids", async () => {
      expect((await call("cs-bia", "GET", `/meetings/${id}`)).status).toBe(200);
      const res = await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`);
      expect(res.status).toBe(204);
      for (const url of [`/meetings/${id}`, `/meetings/${id}/items`, `/meetings/${id}/audio`, `/meetings/${id}/resumo`]) {
        expect((await call("cs-bia", "GET", url)).status, url).toBe(404);
      }
      expect((await call("cs-bia", "PATCH", `/items/${itemId}`, { description: "Depois de revogado" })).status).toBe(404);
      const list = await call("cs-bia", "GET", "/meetings?limit=200");
      expect(list.json.meetings.map((m: Json) => m.id)).not.toContain(id);
      const rows = await waitAudit("meeting_share_revoked", 1);
      expect(rows.at(-1)!.detail).toEqual({ meetingId: id, target: ids["cs-bia"], scope: "occurrence", affected: 1 });
      expect(JSON.stringify(rows)).not.toContain("Revisão");
    });

    it("revogar quem não tem acesso devolve 404; alcance inválido, 400", async () => {
      expect((await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`)).status).toBe(404);
      expect((await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-leo"]}?scope=tudo`)).status).toBe(400);
      expect((await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-leo"]}?scope=following`)).status).toBe(422);
      expect(await hasShare(id, "cs-leo")).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------- ao vivo

  describe("ao vivo: WebSocket direcionado e revogação imediata", () => {
    let id = "";
    let itemId = "";
    const conns: Conn[] = [];
    const open = async (who: string) => {
      const c = await connect(who);
      conns.push(c);
      return c;
    };

    beforeAll(async () => {
      id = await meeting("cs-ana", "Reunião ao vivo");
      itemId = (await call("cs-ana", "POST", `/meetings/${id}/items`, { type: "decisao", description: "Subir a versão nova" })).json.id;
    });

    afterAll(() => conns.forEach((c) => c.close()));

    it("granted chega a todas as abas do destinatário, inscritas ou não, e a mais ninguém", async () => {
      const bia1 = await open("cs-bia");
      const bia2 = await open("cs-bia");
      const edu = await open("cs-edu");
      const ana = await open("cs-ana");
      const res = await share("cs-ana", id, "cs-bia", "read");
      expect(res.status).toBe(201);
      expect(await until(() => accessEvents(bia1, id).length > 0 && accessEvents(bia2, id).length > 0)).toBe(true);
      const event = accessEvents(bia1, id)[0];
      expect(event).toMatchObject({ change: "granted", access: "read", by: "Ana Lima", title: "Reunião ao vivo" });
      expect(event.meeting).toMatchObject({ id, access: "read", ownerName: "Ana Lima", shareUnseen: true, shareCount: null });
      await new Promise((r) => setTimeout(r, 150));
      expect(accessEvents(edu, id)).toHaveLength(0);
      expect(accessEvents(ana, id)).toHaveLength(0);
    });

    it("changed mantém a inscrição e avisa o novo nível", async () => {
      const bia = await open("cs-bia");
      await subscribe(bia, id);
      const res = await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`, { access: "edit" });
      expect(res.status).toBe(200);
      expect(await until(() => accessEvents(bia, id).some((m) => m.change === "changed"))).toBe(true);
      expect(accessEvents(bia, id).find((m) => m.change === "changed")).toMatchObject({ access: "edit", meeting: null });
      hub.publishToMeeting(id, { type: "summary", meetingId: id, text: "depois-do-changed", at: new Date().toISOString() });
      expect(await until(() => bia.messages.some((m) => m.text === "depois-do-changed"))).toBe(true);
    });

    it("revogar corta a assinatura na hora (muito antes do sweep de 30 s) e o aviso é o último evento da reunião", async () => {
      const bia = await open("cs-bia");
      await subscribe(bia, id);
      const started = Date.now();
      expect((await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ids["cs-bia"]}`)).status).toBe(204);
      hub.publishToMeeting(id, { type: "summary", meetingId: id, text: "apos-revogar", at: new Date().toISOString() });
      await notifyMeeting(id);
      await call("cs-ana", "POST", `/meetings/${id}/items`, { type: "risco", description: "Risco registrado depois da revogação" });
      expect(await until(() => accessEvents(bia, id).some((m) => m.change === "revoked"))).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(accessEvents(bia, id).at(-1)).toMatchObject({ change: "revoked", access: null, title: null, meeting: null, by: "Ana Lima" });
      await new Promise((r) => setTimeout(r, 300));
      expect(bia.messages.some((m) => m.text === "apos-revogar")).toBe(false);
      expect(bia.messages.filter((m) => m.type !== "meeting_access" && m.meetingId === id && m.text !== undefined && m.text.startsWith("inscrito")).length).toBeGreaterThan(0);
      const afterRevoke = bia.messages.slice(bia.messages.findIndex((m) => m.type === "meeting_access" && m.change === "revoked") + 1);
      expect(afterRevoke.filter((m) => m.meetingId === id)).toEqual([]);
      expect((await call("cs-bia", "GET", `/meetings/${id}`)).status).toBe(404);
    });

    it("quem reassina uma reunião revogada é ignorado (a checagem de acesso falha)", async () => {
      const bia = await open("cs-bia");
      bia.send({ type: "subscribe", topic: "meeting", meetingId: id });
      await new Promise((r) => setTimeout(r, 200));
      hub.publishToMeeting(id, { type: "summary", meetingId: id, text: "reassinatura", at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 200));
      expect(bia.messages.some((m) => m.text === "reassinatura")).toBe(false);
    });

    it("o evento 'meeting' difundido não carrega campos por espectador", async () => {
      expect((await share("cs-ana", id, "cs-edu", "read")).status).toBe(201);
      const edu = await open("cs-edu");
      const ana = await open("cs-ana");
      await subscribe(edu, id);
      await subscribe(ana, id);
      await notifyMeeting(id);
      for (const conn of [edu, ana]) {
        expect(await until(() => conn.messages.some((m) => m.type === "meeting" && m.meeting.id === id))).toBe(true);
        const msg = conn.messages.find((m) => m.type === "meeting" && m.meeting.id === id);
        for (const key of ["access", "ownerName", "shareCount", "shareUnseen"]) {
          expect(Object.hasOwn(msg.meeting, key), key).toBe(false);
        }
      }
      expect((await call("cs-ana", "POST", `/meetings/${id}/items`, { type: "decisao", description: "Item publicado ao vivo" })).status).toBe(201);
      expect(await until(() => edu.messages.some((m) => m.type === "items"))).toBe(true);
      for (const m of edu.messages.filter((x) => x.type === "items" || x.type === "adrs")) {
        expect(JSON.stringify(m)).not.toMatch(/"(access|shareCount|shareUnseen)"/);
      }
      expect(itemId).toBeTruthy();
    });

    it("excluir a reunião avisa os destinatários (deleted) e corta a assinatura", async () => {
      const gone = await meeting("cs-ana", "Reunião que será excluída");
      expect((await share("cs-ana", gone, "cs-bia", "read")).status).toBe(201);
      const bia = await open("cs-bia");
      await subscribe(bia, gone);
      expect((await call("cs-ana", "DELETE", `/meetings/${gone}`)).status).toBe(204);
      expect(await until(() => accessEvents(bia, gone).some((m) => m.change === "deleted"))).toBe(true);
      expect(accessEvents(bia, gone).at(-1)).toMatchObject({ change: "deleted", access: null, by: null, title: null, meeting: null });
      expect((await call("cs-bia", "GET", `/meetings/${gone}`)).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- US3

  describe("US3: compartilhadas comigo, selos e sair", () => {
    let mine = "";
    let shared = "";
    let other = "";

    beforeAll(async () => {
      mine = await meeting("cs-bia", "Própria da Bia");
      shared = await meeting("cs-ana", "Da Ana para a Bia");
      other = await meeting("cs-ana", "Só da Ana");
      expect((await share("cs-ana", shared, "cs-bia", "read")).status).toBe(201);
      expect((await share("cs-ana", shared, "cs-edu", "edit")).status).toBe(201);
    });

    const idsOf = (res: { json: Json }) => res.json.meetings.map((m: Json) => m.id);

    it("scope=all|mine|shared|shared_by_me filtra e combina com projectId, status e before", async () => {
      const all = await call("cs-bia", "GET", "/meetings?limit=200");
      expect(idsOf(all)).toEqual(expect.arrayContaining([mine, shared]));
      expect(idsOf(all)).not.toContain(other);
      expect(idsOf(await call("cs-bia", "GET", "/meetings?scope=all&limit=200"))).toEqual(idsOf(all));
      const minhas = await call("cs-bia", "GET", "/meetings?scope=mine&limit=200");
      expect(idsOf(minhas)).toContain(mine);
      expect(idsOf(minhas)).not.toContain(shared);
      const comigo = await call("cs-bia", "GET", "/meetings?scope=shared&limit=200");
      expect(idsOf(comigo)).toContain(shared);
      expect(idsOf(comigo)).not.toContain(mine);
      const porMim = await call("cs-ana", "GET", "/meetings?scope=shared_by_me&limit=200");
      expect(idsOf(porMim)).toContain(shared);
      expect(idsOf(porMim)).not.toContain(other);
      expect(idsOf(await call("cs-bia", "GET", "/meetings?scope=shared_by_me&limit=200"))).not.toContain(shared);
      expect(idsOf(await call("cs-bia", "GET", `/meetings?scope=shared&status=scheduled&limit=200`))).toContain(shared);
      expect(idsOf(await call("cs-bia", "GET", `/meetings?scope=shared&status=done&limit=200`))).toEqual([]);
      expect(idsOf(await call("cs-bia", "GET", `/meetings?scope=shared&before=2000-01-01T00:00:00Z&limit=200`))).toEqual([]);
      expect(idsOf(await call("cs-bia", "GET", `/meetings?scope=shared&projectId=${ZERO_UUID}&limit=200`))).toEqual([]);
      expect((await call("cs-bia", "GET", "/meetings?scope=tudo")).status).toBe(400);
    });

    it("cada espectador recebe a própria projeção (acesso, dono, contagem, 'Nova')", async () => {
      const bia = (await call("cs-bia", "GET", "/meetings?scope=shared&limit=200")).json.meetings.find((m: Json) => m.id === shared);
      expect(bia).toMatchObject({ access: "read", ownerName: "Ana Lima", shareCount: null, shareUnseen: true });
      const edu = (await call("cs-edu", "GET", "/meetings?scope=shared&limit=200")).json.meetings.find((m: Json) => m.id === shared);
      expect(edu).toMatchObject({ access: "edit", ownerName: "Ana Lima", shareCount: null, shareUnseen: true });
      const ana = (await call("cs-ana", "GET", "/meetings?limit=200")).json.meetings.find((m: Json) => m.id === shared);
      expect(ana).toMatchObject({ access: "owner", ownerName: null, shareCount: 2, shareUnseen: false });
      const semCompartilhar = (await call("cs-ana", "GET", "/meetings?limit=200")).json.meetings.find((m: Json) => m.id === other);
      expect(semCompartilhar.shareCount).toBe(0);
      // a contagem do dono nunca vai para quem recebeu
      expect(JSON.stringify((await call("cs-bia", "GET", "/meetings?limit=200")).json)).not.toContain('"shareCount":2');
    });

    it("a agenda (Hoje) usa a mesma projeção", async () => {
      await pool.query(`UPDATE meetings SET scheduled_start = now(), scheduled_end = now() + interval '30 minutes' WHERE id = $1`, [shared]);
      const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      const agenda = await call("cs-bia", "GET", `/agenda?date=${day}`);
      expect(agenda.status).toBe(200);
      expect(agenda.json.meetings.find((m: Json) => m.id === shared)).toMatchObject({
        access: "read",
        ownerName: "Ana Lima",
        shareUnseen: true,
      });
      const owner = await call("cs-ana", "GET", `/agenda?date=${day}`);
      expect(owner.json.meetings.find((m: Json) => m.id === shared)).toMatchObject({ access: "owner", shareCount: 2 });
    });

    it("marcar como vista remove 'Nova' só para quem marcou", async () => {
      expect((await call("cs-bia", "POST", `/shared-with-me/${shared}/seen`)).status).toBe(204);
      const bia = (await call("cs-bia", "GET", "/meetings?scope=shared&limit=200")).json.meetings.find((m: Json) => m.id === shared);
      expect(bia.shareUnseen).toBe(false);
      const edu = (await call("cs-edu", "GET", "/meetings?scope=shared&limit=200")).json.meetings.find((m: Json) => m.id === shared);
      expect(edu.shareUnseen).toBe(true);
    });

    it("seen e sair: só a própria linha; dono e quem não tem acesso recebem 404", async () => {
      for (const who of ["cs-ana", "cs-zed", "cs-admin"]) {
        expect((await call(who, "POST", `/shared-with-me/${shared}/seen`)).status, `${who} seen`).toBe(404);
        expect((await call(who, "DELETE", `/shared-with-me/${shared}`)).status, `${who} sair`).toBe(404);
      }
      expect((await call("cs-bia", "POST", "/shared-with-me/nao-e-uuid/seen")).status).toBe(404);
      expect((await shareRows(shared)).length).toBe(2);
    });

    it("sair desta reunião remove o próprio acesso, audita e a reunião some", async () => {
      expect((await call("cs-bia", "DELETE", `/shared-with-me/${shared}`)).status).toBe(204);
      expect((await call("cs-bia", "GET", `/meetings/${shared}`)).status).toBe(404);
      expect(await hasShare(shared, "cs-bia")).toBeNull();
      expect(await hasShare(shared, "cs-edu")).not.toBeNull();
      const rows = await waitAudit("meeting_share_left", 1);
      expect(rows.at(-1)).toMatchObject({ detail: { meetingId: shared }, user_id: ids["cs-bia"] });
      expect(JSON.stringify(rows)).not.toContain("Da Ana");
    });
  });

  // ---------------------------------------------------------------- US4

  describe("US4: série recorrente", () => {
    let seriesIds: string[] = [];
    let total = 0;

    beforeAll(async () => {
      const first = await call("cs-ana", "POST", "/meetings/scheduled", {
        title: "Daily do time",
        start: new Date(Date.now() + 24 * 3600_000).toISOString(),
        durationMinutes: 15,
        recurrence: { freq: "daily", interval: 1 },
      });
      expect(first.status).toBe(201);
      const { rows } = await pool.query(
        `SELECT id FROM meetings WHERE series_id = (SELECT series_id FROM meetings WHERE id = $1) ORDER BY scheduled_start`,
        [first.json.id],
      );
      seriesIds = rows.map((r) => r.id);
      total = seriesIds.length;
      expect(total).toBeGreaterThan(10);
      // duas ocorrências passadas
      await pool.query(`UPDATE meetings SET scheduled_start = now() - interval '3 days' WHERE id = $1`, [seriesIds[0]]);
      await pool.query(`UPDATE meetings SET scheduled_start = now() - interval '2 days' WHERE id = $1`, [seriesIds[1]]);
      seriesIds = (await pool.query(`SELECT id FROM meetings WHERE id = ANY($1) ORDER BY scheduled_start`, [seriesIds])).rows.map((r) => r.id);
    });

    // A série diária fica fora do banco compartilhado: os outros testes rodam o job de extensão sobre todas as séries.
    afterAll(async () => {
      await pool.query(`DELETE FROM meetings WHERE series_id = (SELECT series_id FROM meetings WHERE id = $1)`, [seriesIds[2]]);
      await pool.query(`DELETE FROM meetings WHERE ical_uid = 'uid-cs-1@teste'`);
    });

    const withShare = async (user: string) =>
      (await pool.query(`SELECT meeting_id FROM meeting_shares WHERE user_id = $1 AND meeting_id = ANY($2)`, [ids[user], seriesIds])).rows.map((r) => r.meeting_id as string);

    it("GET /shares informa quantas ocorrências o lote atingiria (a própria e as futuras)", async () => {
      const res = await call("cs-ana", "GET", `/meetings/${seriesIds[2]}/${SHARES}`);
      expect(res.json.series).toEqual({ following: total - 2 });
      const past = await call("cs-ana", "GET", `/meetings/${seriesIds[0]}/${SHARES}`);
      expect(past.json.series).toEqual({ following: total - 1 });
    });

    it("'esta e as próximas' cria uma linha por ocorrência futura e deixa as passadas de fora", async () => {
      const res = await share("cs-ana", seriesIds[2], "cs-bia", "read", "following");
      expect(res.status).toBe(201);
      expect(res.json.affected).toBe(total - 2);
      const got = await withShare("cs-bia");
      expect(got).toHaveLength(total - 2);
      expect(got).not.toContain(seriesIds[0]);
      expect(got).not.toContain(seriesIds[1]);
      const rows = await waitAudit("meeting_share_granted", 1);
      const entry = rows.map((r) => r.detail).find((d) => d.scope === "following");
      expect(entry).toMatchObject({ meetingId: seriesIds[2], scope: "following", affected: total - 2 });
    });

    it("é idempotente: repetir o lote devolve 409 e não duplica nada", async () => {
      expect((await share("cs-ana", seriesIds[2], "cs-bia", "read", "following")).status).toBe(409);
      expect(await withShare("cs-bia")).toHaveLength(total - 2);
    });

    it("alterar o nível com 'following' muda só as futuras", async () => {
      const res = await call("cs-ana", "PUT", `/meetings/${seriesIds[2]}/${SHARES}/${ids["cs-bia"]}`, { access: "edit", scope: "following" });
      expect(res.status).toBe(200);
      expect(res.json.affected).toBe(total - 2);
      const rows = await pool.query(`SELECT DISTINCT access FROM meeting_shares WHERE user_id = $1 AND meeting_id = ANY($2)`, [ids["cs-bia"], seriesIds]);
      expect(rows.rows).toEqual([{ access: "edit" }]);
    });

    it("revogar só esta remove uma linha; revogar 'following' remove o resto", async () => {
      const one = await call("cs-ana", "DELETE", `/meetings/${seriesIds[3]}/${SHARES}/${ids["cs-bia"]}`);
      expect(one.status).toBe(204);
      expect(await withShare("cs-bia")).toHaveLength(total - 3);
      expect((await call("cs-ana", "DELETE", `/meetings/${seriesIds[2]}/${SHARES}/${ids["cs-bia"]}?scope=following`)).status).toBe(204);
      expect(await withShare("cs-bia")).toHaveLength(0);
      const rows = await waitAudit("meeting_share_revoked", 2);
      expect(rows.at(-1)!.detail).toMatchObject({ scope: "following", affected: total - 3 });
    });

    it("a ocorrência criada depois não herda o acesso", async () => {
      expect((await share("cs-ana", seriesIds[2], "cs-edu", "read", "following")).status).toBe(201);
      const created = await pool.query(
        `INSERT INTO meetings (title, platform, status, created_by, source, scheduled_start, series_id, recurrence_rule)
         SELECT title, platform, status, created_by, source, now() + interval '400 days', series_id, recurrence_rule
           FROM meetings WHERE id = $1 RETURNING id`,
        [seriesIds[2]],
      );
      expect(await hasShare(created.rows[0].id, "cs-edu")).toBeNull();
      expect((await call("cs-edu", "GET", `/meetings/${created.rows[0].id}`)).status).toBe(404);
    });

    it("com a referência no passado, a própria entra e as outras passadas não", async () => {
      expect((await share("cs-ana", seriesIds[0], "cs-zed", "read", "following")).status).toBe(201);
      const got = await withShare("cs-zed");
      expect(got).toContain(seriesIds[0]);
      expect(got).not.toContain(seriesIds[1]);
      expect(got).toHaveLength(total - 1);
    });

    it("convite .ics: série por (dono, ical_uid), sem tocar nas reuniões de outro dono", async () => {
      const insert = (owner: string, key: string, days: number) =>
        pool
          .query(
            `INSERT INTO meetings (title, platform, status, created_by, source, scheduled_start, ical_uid, recurrence_key)
             VALUES ('Convite recorrente', 'none', 'scheduled', $1, 'ics', now() + ($3 || ' days')::interval, 'uid-cs-1@teste', $2) RETURNING id`,
            [ids[owner], key, String(days)],
          )
          .then((r) => r.rows[0].id as string);
      const mine = [await insert("cs-ana", "a", 5), await insert("cs-ana", "b", 6), await insert("cs-ana", "c", 7), await insert("cs-ana", "d", 8)];
      const theirs = await insert("cs-admin", "a", 6);
      const res = await share("cs-ana", mine[1], "cs-bia", "read", "following");
      expect(res.status).toBe(201);
      expect(res.json.affected).toBe(3);
      expect(await hasShare(mine[0], "cs-bia")).toBeNull();
      for (const m of mine.slice(1)) expect(await hasShare(m, "cs-bia"), m).not.toBeNull();
      expect(await hasShare(theirs, "cs-bia")).toBeNull();
    });

    it("reunião sem série recusa 'following' (422) e nada é gravado", async () => {
      const single = await meeting("cs-ana", "Avulsa");
      const res = await share("cs-ana", single, "cs-bia", "read", "following");
      expect(res.status).toBe(422);
      expect(res.json.error).toBe("Esta reunião não pertence a uma série.");
      expect(await shareRows(single)).toEqual([]);
    });

    it("é atômico: uma falha no meio do lote não grava nada", async () => {
      const failing = seriesIds[4];
      await pool.query(`
        CREATE OR REPLACE FUNCTION cs_falha() RETURNS trigger AS $$
        BEGIN
          IF NEW.meeting_id = '${failing}' THEN RAISE EXCEPTION 'falha simulada'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER cs_falha_trg BEFORE INSERT ON meeting_shares FOR EACH ROW EXECUTE FUNCTION cs_falha()`);
      try {
        const res = await share("cs-ana", seriesIds[2], "cs-leo", "read", "following");
        expect(res.status).toBe(500);
        expect(await withShare("cs-leo")).toEqual([]);
      } finally {
        await pool.query(`DROP TRIGGER cs_falha_trg ON meeting_shares`);
        await pool.query(`DROP FUNCTION cs_falha()`);
      }
      expect((await share("cs-ana", seriesIds[2], "cs-leo", "read", "following")).status).toBe(201);
    });
  });

  // ---------------------------------------------------------------- US5

  describe("US5: isolamento e papéis", () => {
    let id = "";

    beforeAll(async () => {
      id = await meeting("cs-ana", "Isolamento total");
      expect((await share("cs-ana", id, "cs-bia", "read")).status).toBe(201);
      expect((await share("cs-ana", id, "cs-edu", "edit")).status).toBe(201);
      expect((await share("cs-ana", id, "cs-leo", "read")).status).toBe(201);
    });

    const MANAGE: [string, string, unknown?][] = [
      ["GET", `/${SHARES}`],
      ["POST", `/${SHARES}`, { userId: ZERO_UUID, access: "read" }],
      ["PUT", `/${SHARES}/${ZERO_UUID}`, { access: "read" }],
      ["DELETE", `/${SHARES}/${ZERO_UUID}`],
    ];
    const OWNER_ROUTES: [string, string, unknown?][] = [
      ["PATCH", ""],
      ["POST", "/record"],
      ["POST", "/end"],
      ["POST", "/assistant"],
      ["POST", "/reprocess", { step: "all" }],
      ["POST", "/skip", { skip: true }],
      ["POST", "/auto-off-day", { enabled: true }],
      ["POST", "/cancel"],
      ["PUT", "/extract-items", { enabled: true }],
      ["POST", "/adrs/generate", {}],
      ["DELETE", ""],
    ];

    // papel/vínculo -> status esperado nas rotas só do dono
    const EXPECTED: Record<string, number> = {
      "cs-edu": 403,
      "cs-bia": 403,
      "cs-leo": 403,
      "cs-admin": 404,
      "cs-super": 404,
      "cs-zed": 404,
    };

    it("matriz papel x nível x rota: só o dono passa; destinatário 403, sem acesso 404 (mais de 40 combinações)", async () => {
      let combos = 0;
      for (const [who, expected] of Object.entries(EXPECTED)) {
        for (const [method, suffix, body] of [...MANAGE, ...OWNER_ROUTES]) {
          const res = await call(who, method, `/meetings/${id}${suffix}`, body);
          expect(res.status, `${who} ${method} /meetings/:id${suffix}`).toBe(expected);
          combos++;
        }
      }
      expect(combos).toBeGreaterThanOrEqual(40);
      for (const [method, suffix, body] of MANAGE) {
        const res = await call(null, method, `/meetings/${id}${suffix}`, body);
        expect(res.status, `anônimo ${method}${suffix}`).toBe(401);
      }
      expect(await shareRows(id)).toHaveLength(3);
      expect((await call("cs-ana", "GET", `/meetings/${id}`)).status).toBe(200);
    });

    it("o dono passa pelo guard nas rotas de gestão", async () => {
      expect((await call("cs-ana", "GET", `/meetings/${id}/${SHARES}`)).status).toBe(200);
      expect((await call("cs-ana", "PUT", `/meetings/${id}/${SHARES}/${ZERO_UUID}`, { access: "read" })).status).toBe(404);
      expect((await call("cs-ana", "DELETE", `/meetings/${id}/${SHARES}/${ZERO_UUID}`)).status).toBe(404);
      expect((await share("cs-ana", id, "cs-ana", "read")).status).toBe(422);
    });

    it("maiúsculas, barras duplas e codificação não contornam o guard", async () => {
      const variants = [
        `/api/MEETINGS/${id}/${SHARES}`,
        `/api/Meetings/${id}/Shares`,
        `/api//meetings/${id}/${SHARES}`,
        `/api/meetings//${id}/${SHARES}`,
        `/api/meetings/${id}//${SHARES}`,
        `/api/meetings/${id}/${SHARES}/`,
        `/api/meetings/%6d${id.slice(1)}/${SHARES}`,
        `/api/meetings/${id}%2F${SHARES}`,
        `/api/meetings/${id}/%73hares`,
        `/api/meetings/${id.toUpperCase()}/${SHARES}`,
      ];
      for (const who of ["cs-bia", "cs-edu", "cs-admin", "cs-zed"]) {
        for (const url of variants) {
          const res = await raw(who, "GET", url);
          expect([403, 404], `${who} ${url}`).toContain(res.status);
          expect(JSON.stringify(res.json), `${who} ${url}`).not.toContain("cs-edu");
          const post = await raw(who, "POST", url, { userId: ids["cs-zed"], access: "read" });
          expect([403, 404], `${who} POST ${url}`).toContain(post.status);
        }
      }
      expect(await hasShare(id, "cs-zed")).toBeNull();
    });

    it("admin e super sem acesso: 404, sem conteúdo, e nenhuma rota /admin lista compartilhamentos", async () => {
      for (const who of ["cs-admin", "cs-super"]) {
        expect((await call(who, "GET", `/meetings/${id}`)).status, who).toBe(404);
        const list = await call(who, "GET", "/meetings?limit=200");
        expect(list.json.meetings.map((m: Json) => m.id), who).not.toContain(id);
        expect(JSON.stringify((await call(who, "GET", "/admin/users")).json), who).not.toContain("Isolamento");
        expect((await share(who, id, "cs-zed", "read")).status, who).toBe(404);
      }
      const paths: string[] = [];
      const collect = (stack: Json[]) => {
        for (const layer of stack) {
          if (layer.route?.path) paths.push(layer.route.path);
          if (layer.handle?.stack) collect(layer.handle.stack);
        }
      };
      collect((buildRouter() as unknown as { stack: Json[] }).stack);
      const related = paths.filter((p) => /share/i.test(p));
      expect(related.filter((p) => p.startsWith("/admin"))).toEqual([]);
      expect(related.sort()).toEqual(
        [
          "/meetings/:id/shares",
          "/meetings/:id/shares",
          "/meetings/:id/shares/:userId",
          "/meetings/:id/shares/:userId",
          "/shared-with-me/:meetingId",
          "/shared-with-me/:meetingId/seen",
        ].sort(),
      );
    });

    it("admin dono da própria reunião compartilha como qualquer dono", async () => {
      const adminMeeting = await meeting("cs-admin", "Reunião do admin");
      expect((await share("cs-admin", adminMeeting, "cs-ana", "read")).status).toBe(201);
      expect((await call("cs-ana", "GET", `/meetings/${adminMeeting}`)).json.ownerName).toBe("Admin Geral");
    });

    it("auditoria dos quatro tipos não contém títulos de reunião", async () => {
      const { rows } = await pool.query(`SELECT detail FROM audit_log WHERE kind LIKE 'meeting_share_%'`);
      expect(rows.length).toBeGreaterThan(5);
      const text = JSON.stringify(rows);
      for (const title of ["Isolamento", "Planejamento", "Revisão", "Daily", "Reunião do admin", "Reunião ao vivo"]) {
        expect(text).not.toContain(title);
      }
      for (const r of rows) {
        expect(Object.keys(r.detail).every((k) => ["meetingId", "target", "access", "from", "to", "scope", "affected"].includes(k))).toBe(true);
      }
    });

    it("usuário desativado: fora da busca, 422 no grant, aparece como Desativado ao dono, perde a sessão e volta ao reativar", async () => {
      const own = await meeting("cs-ana", "Reunião do usuário desativado");
      expect((await share("cs-ana", own, "cs-off", "read")).status).toBe(201);
      expect((await call("cs-off", "GET", `/meetings/${own}`)).status).toBe(200);
      const off = await call("cs-super", "PATCH", `/admin/users/${ids["cs-off"]}`, { active: false });
      expect(off.status).toBe(200);
      expect((await call("cs-off", "GET", `/meetings/${own}`)).status).toBe(401);
      expect((await login("cs-off")).status).toBe(403);
      const list = await call("cs-ana", "GET", `/meetings/${own}/${SHARES}`);
      expect(list.json.shares[0]).toMatchObject({ username: "cs-off", active: false });
      expect((await call("cs-ana", "GET", "/users/lookup?q=cs-off")).json.users).toEqual([]);
      expect((await share("cs-ana", id, "cs-off", "read")).status).toBe(422);
      expect((await call("cs-ana", "DELETE", `/meetings/${own}/${SHARES}/${ids["cs-off"]}`)).status).toBe(204);
      expect((await share("cs-ana", own, "cs-off", "read")).status).toBe(422);
      expect((await call("cs-super", "PATCH", `/admin/users/${ids["cs-off"]}`, { active: true })).status).toBe(200);
      expect((await share("cs-ana", own, "cs-off", "read")).status).toBe(201);
      const again = await login("cs-off");
      expect(again.status).toBe(200);
      cookies["cs-off"] = again.cookie;
      expect((await call("cs-off", "GET", `/meetings/${own}`)).status).toBe(200);
    });

    it("dono desativado: os destinatários mantêm o acesso (decisão Q5 = A)", async () => {
      const own = await meeting("cs-dono", "Reunião do dono desativado");
      expect((await share("cs-dono", own, "cs-bia", "read")).status).toBe(201);
      expect((await call("cs-super", "PATCH", `/admin/users/${ids["cs-dono"]}`, { active: false })).status).toBe(200);
      const res = await call("cs-bia", "GET", `/meetings/${own}`);
      expect(res.status).toBe(200);
      expect(res.json.ownerName).toBe("Dono Temporário");
      expect(res.json.access).toBe("read");
    });

    it("consumo de IA é só das reuniões do próprio usuário (não das compartilhadas)", async () => {
      const own = await meeting("cs-bia", "Reunião própria da Bia");
      const call1 = (meetingId: string, tokens: number) =>
        pool.query(
          `INSERT INTO audit_log (kind, detail, user_id) VALUES ('external_llm', $1, NULL)`,
          [{ meetingId, provider: "openrouter", model: "m", label: "ata", promptTokens: tokens, completionTokens: 1, cost: 0.5 }],
        );
      await call1(id, 1000);
      await call1(own, 7);
      const bia = await call("cs-bia", "GET", "/llm/usage");
      expect(bia.status).toBe(200);
      expect(bia.json.byMeeting.map((m: Json) => m.meetingId)).toEqual([own]);
      expect(bia.json.recent.map((r: Json) => r.meetingId)).toEqual([own]);
      expect(bia.json.totals.promptTokens).toBe(7);
      const ana = await call("cs-ana", "GET", "/llm/usage");
      expect(ana.json.byMeeting.map((m: Json) => m.meetingId)).toEqual([id]);
      expect(JSON.stringify(bia.json)).not.toContain("Isolamento");
    });
  });
});
