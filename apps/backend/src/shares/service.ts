import type { PoolClient } from "pg";
import type { ShareAccess, ShareEntry, ShareListResponse, ShareScope } from "@meeting-bot/contracts";
import { pool, withTransaction } from "../db";

// Compartilhamento de reunião (specs/005-compartilhamento). Funções de banco sem Express: cada escrita roda
// numa transação, trava a reunião e confere o dono (defesa em profundidade além do guard da rota).
// Efeitos colaterais (auditoria, WebSocket) ficam nas rotas, depois do commit.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SERIES_CAP = 500;

export const SHARE_MESSAGES = {
  forbidden: "Você não tem permissão para esta ação.",
  meetingNotFound: "Reunião não encontrada.",
  invalidTarget: "Não foi possível compartilhar com este usuário.",
  readOnlyTarget: "Este usuário só pode receber leitura.",
  duplicate: "Esta reunião já está compartilhada com este usuário.",
  notSeries: "Esta reunião não pertence a uma série.",
  noShare: "Este usuário não tem acesso a esta reunião.",
} as const;

export class ShareError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface MeetingRef {
  id: string;
  createdBy: string | null;
  seriesId: string | null;
  icalUid: string | null;
  /** início efetivo (agenda ou criação), usado para "esta e as próximas" */
  when: Date;
}

interface TargetUser {
  id: string;
  active: boolean;
  canRead: boolean;
  canManage: boolean;
}

/** Reuniões que um ato com `scope` atinge, em ordem cronológica; a de referência sempre vem junto. */
export interface Batch {
  ref: MeetingRef;
  ids: string[];
}

/** Trava a reunião (FOR SHARE) e confere que `actorId` é o dono. */
async function lockOwned(client: PoolClient, meetingId: string, actorId: string): Promise<MeetingRef> {
  if (!UUID_RE.test(meetingId)) throw new ShareError(404, SHARE_MESSAGES.meetingNotFound);
  const { rows } = await client.query(
    `SELECT id, created_by, series_id, ical_uid, COALESCE(scheduled_start, created_at) AS "when"
       FROM meetings WHERE id = $1 FOR SHARE`,
    [meetingId],
  );
  const row = rows[0];
  if (!row) throw new ShareError(404, SHARE_MESSAGES.meetingNotFound);
  if (row.created_by !== actorId) throw new ShareError(403, SHARE_MESSAGES.forbidden);
  return { id: row.id, createdBy: row.created_by, seriesId: row.series_id, icalUid: row.ical_uid, when: row.when };
}

/** Série manual (`series_id`) ou convite .ics (`ical_uid`); sem nenhum dos dois, não há série. */
export function hasSeries(ref: Pick<MeetingRef, "seriesId" | "icalUid">): boolean {
  return Boolean(ref.seriesId ?? ref.icalUid);
}

/**
 * Ocorrências do mesmo dono e da mesma série, com início igual ou posterior ao da referência (a própria inclusive).
 * Passadas nunca entram no lote, a não ser a própria referência.
 */
export async function seriesOccurrences(client: Pick<PoolClient, "query">, ref: MeetingRef): Promise<string[]> {
  if (!hasSeries(ref)) return [ref.id];
  const byManual = ref.seriesId !== null;
  const { rows } = await client.query(
    `SELECT m.id FROM meetings m
      WHERE m.created_by = $1
        AND ${byManual ? "m.series_id = $2" : "m.ical_uid = $2"}
        AND COALESCE(m.scheduled_start, m.created_at) >= $3
        AND (m.id = $4 OR COALESCE(m.scheduled_start, m.created_at) >= now())
      ORDER BY COALESCE(m.scheduled_start, m.created_at), m.id
      LIMIT ${SERIES_CAP}`,
    [ref.createdBy, byManual ? ref.seriesId : ref.icalUid, ref.when, ref.id],
  );
  const ids = rows.map((r) => r.id as string);
  return ids.includes(ref.id) ? ids : [ref.id, ...ids];
}

async function resolveBatch(client: PoolClient, meetingId: string, actorId: string, scope: ShareScope): Promise<Batch> {
  const ref = await lockOwned(client, meetingId, actorId);
  if (scope === "occurrence") return { ref, ids: [ref.id] };
  if (!hasSeries(ref)) throw new ShareError(422, SHARE_MESSAGES.notSeries);
  return { ref, ids: await seriesOccurrences(client, ref) };
}

async function loadTarget(client: Pick<PoolClient, "query">, userId: string): Promise<TargetUser | null> {
  if (!UUID_RE.test(userId)) return null;
  const { rows } = await client.query(
    `SELECT u.id, u.active,
            EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                     WHERE ur.user_id = u.id AND rp.permission_key = 'meetings.read') AS can_read,
            EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                     WHERE ur.user_id = u.id AND rp.permission_key = 'meetings.manage') AS can_manage
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  return row ? { id: row.id, active: row.active, canRead: row.can_read, canManage: row.can_manage } : null;
}

function assertGrantable(target: TargetUser | null, actorId: string, access: ShareAccess): asserts target is TargetUser {
  if (!target || !target.active || !target.canRead || target.id === actorId) {
    throw new ShareError(422, SHARE_MESSAGES.invalidTarget);
  }
  if (access === "edit" && !target.canManage) throw new ShareError(422, SHARE_MESSAGES.readOnlyTarget);
}

const ENTRY_SELECT = `
  SELECT s.user_id, s.access, s.created_at, s.updated_at, s.seen_at,
         u.username, u.active,
         COALESCE(NULLIF(u.display_name, ''), NULLIF(u.real_name, ''), u.username) AS name,
         EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                  WHERE ur.user_id = u.id AND rp.permission_key = 'meetings.manage') AS can_manage
    FROM meeting_shares s
    JOIN users u ON u.id = s.user_id`;

function toEntry(r: Record<string, any>): ShareEntry {
  return {
    userId: r.user_id,
    username: r.username,
    name: r.name,
    access: r.access,
    effectiveAccess: r.access === "edit" && r.can_manage ? "edit" : "read",
    active: r.active,
    grantedAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    seen: r.seen_at !== null,
  };
}

async function entryOf(client: Pick<PoolClient, "query">, meetingId: string, userId: string): Promise<ShareEntry | null> {
  const { rows } = await client.query(`${ENTRY_SELECT} WHERE s.meeting_id = $1 AND s.user_id = $2`, [meetingId, userId]);
  return rows[0] ? toEntry(rows[0]) : null;
}

/** Lista de acessos (só o dono). Devolve também quantas ocorrências "esta e as próximas" atingiria. */
export async function listShares(meetingId: string, actorId: string): Promise<ShareListResponse> {
  return withTransaction(async (client) => {
    const ref = await lockOwned(client, meetingId, actorId);
    const { rows } = await client.query(`${ENTRY_SELECT} WHERE s.meeting_id = $1 ORDER BY u.username`, [meetingId]);
    const series = hasSeries(ref) ? { following: (await seriesOccurrences(client, ref)).length } : null;
    return { shares: rows.map(toEntry), series };
  });
}

export interface ShareChange {
  share: ShareEntry;
  /** linhas criadas, atualizadas ou removidas pelo ato */
  affected: number;
  /** reuniões que mudaram de fato (para os eventos ao vivo); a de referência vem primeiro quando está nelas */
  meetingIds: string[];
  /** nível anterior na reunião de referência (só em `changeShare`) */
  from: ShareAccess | null;
  /** subconjunto de `meetingIds` em que a linha foi criada agora (o resto só mudou de nível) */
  createdIds: string[];
}

function refFirst(ref: string, ids: string[]): string[] {
  return ids.includes(ref) ? [ref, ...ids.filter((id) => id !== ref)] : ids;
}

export async function grantShare(
  actorId: string,
  meetingId: string,
  input: { userId: string; access: ShareAccess; scope: ShareScope },
): Promise<ShareChange> {
  return withTransaction(async (client) => {
    const batch = await resolveBatch(client, meetingId, actorId, input.scope);
    const target = await loadTarget(client, input.userId);
    assertGrantable(target, actorId, input.access);
    if (input.scope === "occurrence" && (await entryOf(client, batch.ref.id, target.id))) {
      throw new ShareError(409, SHARE_MESSAGES.duplicate);
    }
    const { rows } = await client.query(
      `INSERT INTO meeting_shares (meeting_id, user_id, access, granted_by)
       SELECT id, $2, $3, $4 FROM unnest($1::uuid[]) AS id
       ON CONFLICT (meeting_id, user_id) DO UPDATE
         SET access = EXCLUDED.access, updated_at = now(),
             seen_at = CASE WHEN EXCLUDED.access = 'edit' THEN NULL ELSE meeting_shares.seen_at END
         WHERE meeting_shares.access <> EXCLUDED.access
       RETURNING meeting_id, (xmax = 0) AS created`,
      [batch.ids, target.id, input.access, actorId],
    );
    if (rows.length === 0) throw new ShareError(409, SHARE_MESSAGES.duplicate);
    const share = (await entryOf(client, batch.ref.id, target.id))!;
    return {
      share,
      affected: rows.length,
      meetingIds: refFirst(
        batch.ref.id,
        rows.map((r) => r.meeting_id as string),
      ),
      from: null,
      createdIds: rows.filter((r) => r.created).map((r) => r.meeting_id as string),
    };
  });
}

export async function changeShare(
  actorId: string,
  meetingId: string,
  targetUserId: string,
  input: { access: ShareAccess; scope: ShareScope },
): Promise<ShareChange> {
  return withTransaction(async (client) => {
    const batch = await resolveBatch(client, meetingId, actorId, input.scope);
    const current = await entryOf(client, batch.ref.id, targetUserId);
    if (!current) throw new ShareError(404, SHARE_MESSAGES.noShare);
    if (input.access === "edit") {
      const target = await loadTarget(client, targetUserId);
      if (!target?.canManage) throw new ShareError(422, SHARE_MESSAGES.readOnlyTarget);
    }
    const { rows } = await client.query(
      `UPDATE meeting_shares
          SET access = $3, updated_at = now(),
              seen_at = CASE WHEN $3 = 'edit' AND access = 'read' THEN NULL ELSE seen_at END
        WHERE meeting_id = ANY($1::uuid[]) AND user_id = $2 AND access <> $3
        RETURNING meeting_id`,
      [batch.ids, targetUserId, input.access],
    );
    const share = (await entryOf(client, batch.ref.id, targetUserId))!;
    return {
      share,
      affected: rows.length,
      meetingIds: refFirst(
        batch.ref.id,
        rows.map((r) => r.meeting_id as string),
      ),
      from: current.access,
      createdIds: [],
    };
  });
}

export interface ShareRevoke {
  affected: number;
  meetingIds: string[];
}

export async function revokeShare(
  actorId: string,
  meetingId: string,
  targetUserId: string,
  scope: ShareScope,
): Promise<ShareRevoke> {
  return withTransaction(async (client) => {
    const batch = await resolveBatch(client, meetingId, actorId, scope);
    if (!(await entryOf(client, batch.ref.id, targetUserId))) throw new ShareError(404, SHARE_MESSAGES.noShare);
    const { rows } = await client.query(
      `DELETE FROM meeting_shares WHERE meeting_id = ANY($1::uuid[]) AND user_id = $2 RETURNING meeting_id`,
      [batch.ids, targetUserId],
    );
    return {
      affected: rows.length,
      meetingIds: refFirst(
        batch.ref.id,
        rows.map((r) => r.meeting_id as string),
      ),
    };
  });
}

/** O destinatário abriu a reunião: some a marca "Nova". Só a linha dele. */
export async function markSeen(userId: string, meetingId: string): Promise<boolean> {
  if (!UUID_RE.test(meetingId)) return false;
  const { rowCount } = await pool.query(
    `UPDATE meeting_shares SET seen_at = COALESCE(seen_at, now()) WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** "Sair desta reunião": remove só a linha do próprio usuário. O dono nunca tem linha, então recebe false. */
export async function leaveShare(userId: string, meetingId: string): Promise<boolean> {
  if (!UUID_RE.test(meetingId)) return false;
  const { rowCount } = await pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1 AND user_id = $2`, [
    meetingId,
    userId,
  ]);
  return (rowCount ?? 0) > 0;
}
