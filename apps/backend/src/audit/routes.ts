import type { Response } from "express";
import { AuditQuery, type AuditKindInfoValue } from "@meeting-bot/contracts";
import { can, requirePermission } from "../authz";
import { features } from "../features";
import { wrap } from "../routes";
import { CursorError } from "../usage/queries";
import { isKnownKind, kindLabel, knownKinds, userKinds } from "./projection";
import { listAudit, type AuditScope } from "./queries";

// Auditoria visível (specs/004-uso-custo/contracts/audit-api.md). Só leitura; sempre projetada.

features.authedRouters.push((router) => {
  async function respond(res: Response, rawQuery: unknown, scope: AuditScope): Promise<void> {
    const query = AuditQuery.safeParse(rawQuery);
    if (!query.success || (query.data.kind !== undefined && !isKnownKind(query.data.kind))) {
      res.status(400).json({ error: "Filtro inválido." });
      return;
    }
    try {
      res.json(await listAudit(scope, query.data));
    } catch (err) {
      if (!(err instanceof CursorError)) throw err;
      res.status(400).json({ error: err.message });
    }
  }

  // O usuário só lê as linhas em que é ator ou alvo; o escopo vem da sessão, nunca da consulta.
  router.get(
    "/audit/me",
    wrap(async (req, res) => {
      await respond(res, { ...req.query, userId: undefined }, { kind: "me", userId: req.user!.id });
    }),
  );

  router.get(
    "/admin/audit",
    requirePermission("audit.read"),
    wrap(async (req, res) => respond(res, req.query, { kind: "admin", viewerId: req.user!.id })),
  );

  router.get(
    "/audit/kinds",
    wrap(async (req, res) => {
      const kinds = can(req.user, "audit.read") ? knownKinds() : userKinds();
      const items: AuditKindInfoValue[] = kinds.map((kind) => ({ kind, label: kindLabel(kind) }));
      res.json({ items });
    }),
  );
});
