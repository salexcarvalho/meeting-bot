import type { NextFunction, Request, Response } from "express";
import type { Permission } from "@meeting-bot/contracts";
import { pool } from "../db";
import type { User } from "../types";

// Autorização no backend (docs/analise/plataforma-multiusuario.md §8–9). O frontend só esconde botões.

export type MeetingAccess = "owner" | "edit" | "read";
export type AccessMode = "read" | "write" | "owner";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { error: "Reunião não encontrada." };
const FORBIDDEN = { error: "Você não tem permissão para esta ação." };

export function can(user: Pick<User, "permissions"> | undefined, permission: Permission): boolean {
  return Boolean(user?.permissions.includes(permission));
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (permissions.every((p) => can(req.user, p))) return next();
    res.status(403).json(FORBIDDEN);
  };
}

export async function meetingAccess(user: User, meetingId: string): Promise<MeetingAccess | null> {
  if (!UUID_RE.test(meetingId)) return null;
  const { rows } = await pool.query(
    `SELECT m.created_by = $2 AS owner, s.access
       FROM meetings m
       LEFT JOIN meeting_shares s ON s.meeting_id = m.id AND s.user_id = $2
      WHERE m.id = $1`,
    [meetingId, user.id],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.owner) return "owner";
  if (row.access === "edit" || row.access === "read") return row.access;
  return can(user, "meetings.read_all") ? "read" : null;
}

export function allows(access: MeetingAccess | null, mode: AccessMode): boolean {
  if (!access) return false;
  if (mode === "owner") return access === "owner";
  if (mode === "write") return access === "owner" || access === "edit";
  return true;
}

const PERMISSION_FOR_MODE: Record<AccessMode, Permission> = {
  read: "meetings.read",
  write: "meetings.manage",
  owner: "meetings.manage",
};

/**
 * Garante acesso à reunião. Sem nenhum acesso → 404 (não revela que ela existe);
 * com acesso de leitura mas pedindo escrita → 403.
 */
export async function checkMeeting(
  req: Request,
  res: Response,
  meetingId: string,
  mode: AccessMode,
  extra: Permission[] = [],
): Promise<boolean> {
  const user = req.user!;
  const access = await meetingAccess(user, meetingId);
  if (!access || !can(user, "meetings.read")) {
    res.status(404).json(NOT_FOUND);
    return false;
  }
  const needed = [PERMISSION_FOR_MODE[mode], ...extra];
  if (!allows(access, mode) || !needed.every((p) => can(user, p))) {
    res.status(403).json(FORBIDDEN);
    return false;
  }
  return true;
}

function modeFor(method: string): AccessMode {
  if (method === "GET" || method === "HEAD") return "read";
  return method === "DELETE" ? "owner" : "write";
}

/**
 * Padrão da rota registrada que casou (ex.: "/meetings/:id/audio"). Vem do código, não da URL digitada,
 * então não depende de maiúsculas, barras ou codificação. Sem rota (camada `use`) → null.
 */
export function routePattern(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : null;
}

export interface MeetingGuardOptions {
  /** Permissões extras exigidas nesta chamada. */
  extraFor?: (req: Request, pattern: string) => Permission[];
  /** Ações que só o dono pode fazer (gravar, parar, reagendar, reprocessar…). */
  ownerOnly?: (req: Request, pattern: string) => boolean;
}

/**
 * Callback de `router.param("id")` para rotas /meetings/:id/*: leitura em GET/HEAD, escrita no resto,
 * DELETE e as ações de `ownerOnly` só o dono. (No Express 5 o param dispara uma vez por requisição, antes do handler.)
 * Outras rotas com `:id` (ex.: /projects/:id) seguem sem checagem de reunião; camada sem rota falha fechada.
 */
export function meetingParamGuard(options: MeetingGuardOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction, value: unknown) => {
    const id = String(value);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: "Não encontrado." });
    const pattern = routePattern(req);
    if (pattern === null) return res.status(404).json({ error: "Não encontrado." });
    if (!pattern.startsWith("/meetings/:id")) return next();
    try {
      const mode = options.ownerOnly?.(req, pattern) ? "owner" : modeFor(req.method);
      if (await checkMeeting(req, res, id, mode, options.extraFor?.(req, pattern) ?? [])) next();
    } catch (err) {
      next(err);
    }
  };
}

export async function meetingIdOfItem(itemId: string): Promise<string | null> {
  if (!UUID_RE.test(itemId)) return null;
  const { rows } = await pool.query(`SELECT meeting_id FROM meeting_items WHERE id = $1`, [itemId]);
  return rows[0]?.meeting_id ?? null;
}

export async function meetingIdOfAdr(adrId: string): Promise<string | null> {
  if (!UUID_RE.test(adrId)) return null;
  const { rows } = await pool.query(`SELECT meeting_id FROM adrs WHERE id = $1`, [adrId]);
  return rows[0]?.meeting_id ?? null;
}

// Callback de `router.param("itemId")`: o acesso vem da reunião dona do item (/items) ou do ADR (/adrs).
export function childParamGuard() {
  return async (req: Request, res: Response, next: NextFunction, value: unknown) => {
    const id = String(value);
    const pattern = routePattern(req);
    if (pattern === null) return res.status(404).json({ error: "Não encontrado." });
    const isAdr = pattern.startsWith("/adrs/");
    const notFound = { error: isAdr ? "ADR não encontrado." : "Item não encontrado." };
    if (!UUID_RE.test(id)) return res.status(404).json(notFound);
    try {
      const meetingId = await (isAdr ? meetingIdOfAdr(id) : meetingIdOfItem(id));
      if (!meetingId) return res.status(404).json(notFound);
      if (await checkMeeting(req, res, meetingId, modeFor(req.method) === "owner" ? "write" : modeFor(req.method))) {
        next();
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Filtro SQL de reuniões visíveis; `alias` é o alias da tabela meetings e `param` o índice do user id. */
export function visibleMeetingsSql(user: User, alias: string, param: number): string {
  if (can(user, "meetings.read_all")) return "TRUE";
  return `(${alias}.created_by = $${param} OR EXISTS (
            SELECT 1 FROM meeting_shares ms WHERE ms.meeting_id = ${alias}.id AND ms.user_id = $${param}))`;
}

/** Devolve o id só se o usuário tiver acesso à reunião (para respostas que citam reuniões de terceiros). */
export async function visibleMeetingId(user: User, meetingId: string | null | undefined): Promise<string | null> {
  if (!meetingId) return null;
  return (await meetingAccess(user, meetingId)) ? meetingId : null;
}

/** Quem pode receber eventos de uma reunião pelo WebSocket. */
export async function meetingAudience(meetingId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT created_by AS user_id FROM meetings WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id FROM meeting_shares WHERE meeting_id = $1`,
    [meetingId],
  );
  return new Set(rows.map((r) => r.user_id as string));
}
