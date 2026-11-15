import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// Apoio dos E2E de tarefas (specs/002). Usam os usuários criados por plataforma.spec.ts (que roda antes, em
// ordem alfabética): Ana (dona), Bia ("Beatriz Lima", destinatária). O banco é o descartável do scripts/e2e.mjs.
export const ANA = { username: "e2e-ana", password: "senha-da-ana-123" };
export const BIA = { username: "e2e-bia", password: "senha-da-bia-123" };

export async function login(page: Page, user: { username: string; password: string }) {
  await page.goto("/");
  await page.getByLabel("Usuário").fill(user.username);
  await page.getByLabel("Senha", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  const shell = page.getByRole("navigation", { name: "Principal" }).or(page.getByRole("button", { name: "Abrir menu" }));
  await expect(shell.filter({ visible: true }).first()).toBeVisible();
}

export async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png`, fullPage: true });
}

export async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Dia civil (AAAA-MM-DD) daqui a `days` dias em São Paulo (o fuso do Playwright e do usuário). */
export function dayFromNow(days: number): string {
  const at = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(at);
}

export async function userId(username: string): Promise<string> {
  return withDb(async (db) => (await db.query(`SELECT id FROM users WHERE username = $1`, [username])).rows[0].id as string);
}

export async function seedMeeting(owner: string, title: string): Promise<string> {
  const ownerId = await userId(owner);
  return withDb(
    async (db) =>
      (
        await db.query(
          `INSERT INTO meetings (title, platform, status, source, created_by, scheduled_start, extract_items)
           VALUES ($1, 'none', 'done', 'manual', $2, now() - interval '1 hour', true) RETURNING id`,
          [title, ownerId],
        )
      ).rows[0].id as string,
  );
}

export async function seedItem(
  meetingId: string,
  item: { type?: string; description: string; owner?: string | null; due?: string | null; status?: string; quote?: string },
): Promise<string> {
  return withDb(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO meeting_items (meeting_id, type, description, owner, due, review_status, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'final') RETURNING id`,
      [meetingId, item.type ?? "pendencia", item.description, item.owner ?? null, item.due ?? null, item.status ?? "proposto"],
    );
    if (item.quote) {
      await db.query(
        `INSERT INTO item_evidence (item_id, segment_id, start_seconds, end_seconds, channel, quote) VALUES ($1, NULL, 1234.5, 1240, 'remote', $2)`,
        [rows[0].id, item.quote],
      );
    }
    return rows[0].id as string;
  });
}

export async function seedTask(
  owner: string,
  task: { title: string; status?: string; priority?: string; due?: string | null; assignee?: "self" | "other" | "none"; name?: string },
): Promise<string> {
  const ownerId = await userId(owner);
  const assignee = task.assignee ?? "self";
  return withDb(
    async (db) =>
      (
        await db.query(
          `INSERT INTO tasks (owner_id, title, status, priority, due_date, assignee_kind, assignee_name, origin, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', CASE WHEN $3::text = 'concluida' THEN now() END) RETURNING id`,
          [ownerId, task.title, task.status ?? "a_fazer", task.priority ?? "media", task.due ?? null, assignee, assignee === "other" ? (task.name ?? "Fulano") : null],
        )
      ).rows[0].id as string,
  );
}

export async function countTasks(owner: string, titleLike: string): Promise<number> {
  const ownerId = await userId(owner);
  return withDb(async (db) => (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1 AND title LIKE $2`, [ownerId, titleLike])).rows[0].n as number);
}

export async function apiJson<T = Record<string, any>>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
        method: m as string,
        headers: { "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    [method, url, body] as const,
  ) as Promise<{ status: number; json: T }>;
}

export async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate<boolean>("document.documentElement.scrollWidth > window.innerWidth")).toBe(false);
}
