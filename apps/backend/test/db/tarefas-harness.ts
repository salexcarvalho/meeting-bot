import type { Server } from "http";
import type { AddressInfo } from "net";

// Apoio dos testes de tarefas com Postgres: sobe o app real numa porta livre, cria usuários e semeia
// reuniões e itens direto no banco (o pipeline de IA não entra aqui). Só vale com TEST_DATABASE_URL.

export const PASSWORD = "senha-forte-123";
export type Json = any;
export type UserSpec = [name: string, role: "USER" | "ADMIN" | "SUPER_ADMIN" | "VIEWER", realName: string | null];

export interface MeetingSeed {
  title?: string;
  projectId?: string | null;
  extractItems?: boolean;
  scheduledStart?: Date;
}

export interface ItemSeed {
  type?: string;
  description: string;
  owner?: string | null;
  due?: string | null;
  status?: "proposto" | "aprovado" | "rejeitado";
  quote?: string | null;
}

export async function startHarness(specs: UserSpec[]) {
  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { hub } = await import("../../src/live/hub");

  await migrate(pool);
  const hash = await hashPassword(PASSWORD);
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  for (const [name, role, realName] of specs) {
    ids[name] = (await createUser(name, hash, { role, realName })).id;
  }
  const server: Server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [name] of specs) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login de ${name} falhou (${res.status})`);
    cookies[name] = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  async function call(who: string | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { origin: base };
    if (who) headers.cookie = cookies[who];
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  async function seedMeeting(owner: string, seed: MeetingSeed = {}): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO meetings (title, platform, status, source, created_by, scheduled_start, extract_items, project_id)
       VALUES ($1, 'none', 'done', 'manual', $2, $3, $4, $5) RETURNING id`,
      [
        seed.title ?? "Reunião de teste",
        ids[owner],
        seed.scheduledStart ?? new Date("2026-11-12T13:00:00Z"),
        seed.extractItems ?? true,
        seed.projectId ?? null,
      ],
    );
    return rows[0].id;
  }

  async function seedItem(meetingId: string, seed: ItemSeed): Promise<string> {
    const status = seed.status ?? "proposto";
    const { rows } = await pool.query(
      `INSERT INTO meeting_items (meeting_id, type, description, owner, due, review_status, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'final') RETURNING id`,
      [meetingId, seed.type ?? "pendencia", seed.description, seed.owner ?? null, seed.due ?? null, status],
    );
    const itemId: string = rows[0].id;
    if (seed.quote) {
      await pool.query(
        `INSERT INTO item_evidence (item_id, segment_id, start_seconds, end_seconds, channel, quote)
         VALUES ($1, NULL, 1234.5, 1240, 'remote', $2)`,
        [itemId, seed.quote],
      );
    }
    return itemId;
  }

  async function share(meetingId: string, user: string, access: "read" | "edit"): Promise<void> {
    await pool.query(`INSERT INTO meeting_shares (meeting_id, user_id, access) VALUES ($1, $2, $3)`, [meetingId, ids[user], access]);
  }

  async function stop(): Promise<void> {
    hub.close();
    server.close();
    await pool.end();
  }

  async function projectId(name: string): Promise<string> {
    const { rows } = await pool.query(`SELECT id FROM projects WHERE name = $1`, [name]);
    return rows[0].id;
  }

  return { pool, ids, call, seedMeeting, seedItem, share, stop, projectId };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;
