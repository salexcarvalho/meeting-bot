import type { AuditPageValue, AuditQueryInput } from "@meeting-bot/contracts";
import { pool } from "../db";
import { decodeCursor, encodeCursor } from "../usage/cursor";
import { CursorError } from "../usage/queries";
import { project, userKinds, type Person, type RawEvent } from "./projection";

// Auditoria visível. Duas visões: o usuário vê só as linhas em que é ator ou alvo, de uma lista
// fechada de tipos (`userKinds`); quem tem `audit.read` vê o sistema. Nada sai sem passar pela
// projeção (lista permitida de campos): o `detail` cru nunca chega à resposta.

const DEFAULT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export type AuditScope = { kind: "me"; userId: string } | { kind: "admin"; viewerId: string };

interface Built {
  sql: string;
  params: unknown[];
}

function scopeFilters(scope: AuditScope, params: unknown[]): string[] {
  if (scope.kind === "admin") return [];
  const me = params.push(scope.userId);
  const kinds = params.push(userKinds());
  return [`a.kind = ANY($${kinds}::text[])`, `(a.user_id = $${me} OR (a.detail ? 'target' AND a.detail->>'target' = $${me}::text))`];
}

function build(scope: AuditScope, query: AuditQueryInput): Built {
  const params: unknown[] = [];
  const filters = scopeFilters(scope, params);
  const to = query.to ? new Date(query.to) : null;
  const from = query.from ? new Date(query.from) : new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS);
  filters.push(`a.at >= $${params.push(from)}`);
  if (to) filters.push(`a.at < $${params.push(to)}`);
  if (query.kind) filters.push(`a.kind = $${params.push(query.kind)}`);
  if (query.userId) {
    const id = params.push(query.userId);
    filters.push(`(a.user_id = $${id} OR (a.detail ? 'target' AND a.detail->>'target' = $${id}::text))`);
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) throw new CursorError();
    filters.push(`(a.at, a.id) < ($${params.push(cursor.at)}::timestamptz, $${params.push(cursor.id)}::bigint)`);
  }
  const limit = params.push(query.limit + 1);
  const sql = `SELECT a.id, a.at, a.at::text AS at_text, a.kind, a.detail, a.user_id
                 FROM audit_log a
                WHERE ${filters.join(" AND ")}
                ORDER BY a.at DESC, a.id DESC
                LIMIT $${limit}`;
  return { sql, params };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function usernames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT id, username FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id as string, r.username as string]));
}

function targetId(detail: Record<string, unknown>): string | null {
  const target = detail?.target;
  return typeof target === "string" && UUID.test(target) ? target : null;
}

export async function listAudit(scope: AuditScope, query: AuditQueryInput): Promise<AuditPageValue> {
  const { sql, params } = build(scope, query);
  const { rows } = await pool.query(sql, params);
  const page = rows.slice(0, query.limit);
  const names = await usernames([
    ...new Set(page.flatMap((r) => [r.user_id as string | null, targetId(r.detail)]).filter((v): v is string => Boolean(v))),
  ]);
  const person = (id: string | null): Person | null => (id ? { id, username: names.get(id) ?? null } : null);
  const viewerId = scope.kind === "me" ? scope.userId : scope.viewerId;
  const items = page.map((r) => {
    const event: RawEvent = {
      id: Number(r.id),
      at: r.at as Date,
      kind: r.kind as string,
      detail: r.detail as Record<string, unknown>,
      actor: person(r.user_id),
      target: person(targetId(r.detail)),
    };
    return project(event, viewerId);
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(String(last.at_text), String(last.id)) : null };
}
