import type { Response } from "express";
import {
  ShareChangeInput,
  ShareInput,
  ShareScope,
  type MeetingAccessEvent,
  type ShareAccess,
} from "@meeting-bot/contracts";
import { requirePermission } from "../authz";
import { meetingSelectFor, pool } from "../db";
import { features } from "../features";
import { hub } from "../live/hub";
import { toMeetingListItem } from "../meetings/summary";
import { parseBody, wrap } from "../routes";
import { audit } from "../security/audit";
import { getSelf } from "../users/repo";
import {
  changeShare,
  grantShare,
  leaveShare,
  listShares,
  markSeen,
  revokeShare,
  ShareError,
  type ShareChange,
} from "./service";

// Rotas de compartilhamento (specs/005-compartilhamento/contracts/rest-api.md).
// /meetings/:id/shares* passam pelo meetingParamGuard como "dono para qualquer método" (authz/ownerOnly.ts);
// cada função de serviço confere o dono de novo. As rotas do destinatário não têm :id de propósito: só tocam
// a linha do próprio usuário.

const ACCESS_EVENT = "meeting_access" as const;

function fail(res: Response, err: unknown): void {
  if (err instanceof ShareError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

/** Itens de lista da reunião vistos pelo destinatário (com o `access` dele), indexados por id. */
async function itemsFor(viewerId: string, meetingIds: string[]) {
  const { rows } = await pool.query(`${meetingSelectFor(1)} WHERE m.id = ANY($2::uuid[])`, [viewerId, meetingIds]);
  return new Map(rows.map((r) => [r.id as string, toMeetingListItem(r, viewerId)]));
}

/** Concessão ou mudança de nível: avisa só o destinatário (todas as abas). A reunião de referência fala; o resto é silencioso. */
async function notifyGranted(actorId: string, targetId: string, access: ShareAccess, change: ShareChange): Promise<void> {
  for (const meetingId of change.meetingIds) hub.invalidateAudience(meetingId);
  if (!change.share.active || change.meetingIds.length === 0) return;
  const [by, items] = await Promise.all([getSelf(actorId), itemsFor(targetId, change.meetingIds)]);
  const created = new Set(change.createdIds);
  const [first] = change.meetingIds;
  for (const meetingId of change.meetingIds) {
    const item = items.get(meetingId);
    if (!item) continue;
    const granted = created.has(meetingId);
    const msg: MeetingAccessEvent = {
      type: ACCESS_EVENT,
      meetingId,
      change: granted ? "granted" : "changed",
      access,
      by: by?.name ?? null,
      title: item.title,
      meeting: granted ? item : null,
    };
    if (meetingId !== first) msg.silent = true;
    hub.publishToUser(targetId, msg);
  }
}

features.authedRouters.push((router) => {
  router.get(
    "/meetings/:id/shares",
    wrap(async (req, res) => {
      try {
        res.json(await listShares(String(req.params.id), req.user!.id));
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.post(
    "/meetings/:id/shares",
    wrap(async (req, res) => {
      const body = parseBody(ShareInput, req, res);
      if (!body) return;
      const meetingId = String(req.params.id);
      try {
        const change = await grantShare(req.user!.id, meetingId, body);
        audit(
          "meeting_share_granted",
          { meetingId, target: body.userId, access: body.access, scope: body.scope, affected: change.affected },
          req.user!.id,
        );
        await notifyGranted(req.user!.id, body.userId, body.access, change);
        res.status(201).json({ share: change.share, affected: change.affected });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.put(
    "/meetings/:id/shares/:userId",
    wrap(async (req, res) => {
      const body = parseBody(ShareChangeInput, req, res);
      if (!body) return;
      const meetingId = String(req.params.id);
      const target = String(req.params.userId);
      try {
        const change = await changeShare(req.user!.id, meetingId, target, body);
        audit(
          "meeting_share_changed",
          { meetingId, target, from: change.from, to: body.access, scope: body.scope, affected: change.affected },
          req.user!.id,
        );
        await notifyGranted(req.user!.id, target, body.access, change);
        res.json({ share: change.share, affected: change.affected });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  router.delete(
    "/meetings/:id/shares/:userId",
    wrap(async (req, res) => {
      const scope = ShareScope.safeParse(req.query.scope ?? "occurrence");
      if (!scope.success) return res.status(400).json({ error: "scope: alcance inválido." });
      const meetingId = String(req.params.id);
      const target = String(req.params.userId);
      try {
        // O nome de quem revoga é buscado antes: depois do commit nada assíncrono pode separar o banco do corte do WebSocket.
        const by = (await getSelf(req.user!.id))?.name ?? null;
        const revoked = await revokeShare(req.user!.id, meetingId, target, scope.data);
        // Ordem do revoke (pesquisa D11): banco confirmado, audiência invalidada, assinatura removida, aviso.
        const [first] = revoked.meetingIds;
        for (const id of revoked.meetingIds) {
          const msg: MeetingAccessEvent = {
            type: ACCESS_EVENT,
            meetingId: id,
            change: "revoked",
            access: null,
            by,
            title: null,
            meeting: null,
          };
          if (id !== first) msg.silent = true;
          hub.revokeAccess(id, target, msg);
        }
        audit("meeting_share_revoked", { meetingId, target, scope: scope.data, affected: revoked.affected }, req.user!.id);
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  // ---------- destinatário ----------

  router.post(
    "/shared-with-me/:meetingId/seen",
    requirePermission("meetings.read"),
    wrap(async (req, res) => {
      if (!(await markSeen(req.user!.id, String(req.params.meetingId)))) {
        return res.status(404).json({ error: "Reunião não encontrada." });
      }
      res.status(204).end();
    }),
  );

  router.delete(
    "/shared-with-me/:meetingId",
    requirePermission("meetings.read"),
    wrap(async (req, res) => {
      const meetingId = String(req.params.meetingId);
      if (!(await leaveShare(req.user!.id, meetingId))) {
        return res.status(404).json({ error: "Reunião não encontrada." });
      }
      audit("meeting_share_left", { meetingId }, req.user!.id);
      hub.revokeAccess(meetingId, req.user!.id, {
        type: ACCESS_EVENT,
        meetingId,
        change: "revoked",
        access: null,
        by: null,
        title: null,
        meeting: null,
      });
      res.status(204).end();
    }),
  );
});
