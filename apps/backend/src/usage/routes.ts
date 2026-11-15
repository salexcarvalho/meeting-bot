import type { Request, Response } from "express";
import { UsageCallsQuery } from "@meeting-bot/contracts";
import { requirePermission } from "../authz";
import { features } from "../features";
import { wrap } from "../routes";
import { adminUsageReport } from "./adminQueries";
import { PeriodError, resolvePeriod, type UsagePeriod } from "./period";
import { CursorError, usageCalls, usageReport } from "./queries";

// Rotas de uso e custo de IA (specs/004-uso-custo/contracts/usage-api.md). Só leitura.
// /usage/me lê SEMPRE o usuário da sessão: nenhum parâmetro de consulta escolhe de quem são os dados.

function periodOf(req: Request, res: Response): UsagePeriod | null {
  try {
    return resolvePeriod(req.query);
  } catch (err) {
    if (err instanceof PeriodError) {
      res.status(400).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

features.authedRouters.push((router) => {
  router.get(
    "/usage/me",
    wrap(async (req, res) => {
      const period = periodOf(req, res);
      if (period) res.json(await usageReport(req.user!.id, period));
    }),
  );

  router.get(
    "/usage/me/calls",
    wrap(async (req, res) => {
      const period = periodOf(req, res);
      if (!period) return;
      const query = UsageCallsQuery.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: "Filtro inválido." });
      try {
        res.json(await usageCalls(req.user!.id, period, query.data));
      } catch (err) {
        if (!(err instanceof CursorError)) throw err;
        res.status(400).json({ error: err.message });
      }
    }),
  );

  router.get(
    "/admin/usage",
    requirePermission("ai_usage.read"),
    wrap(async (req, res) => {
      const period = periodOf(req, res);
      if (period) res.json(await adminUsageReport(period));
    }),
  );
});
