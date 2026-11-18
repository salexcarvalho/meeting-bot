import type { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { SearchQuery, SearchReindexInput } from "@meeting-bot/contracts";
import { normalizeText } from "../agent/text";
import { requirePermission } from "../authz";
import { wrap } from "../routes";
import { searchLimits } from "./limits";
import { meetingIndexStatus, reindexOwn, runSearch, searchStatus } from "./service";

// Rotas da busca (specs/003-busca-chat/contracts/rest-api.md). Só rotas de UI (cookie).
// Nada de texto de busca em log nem em auditoria (FR-033): a consulta só vai ao banco, como parâmetro.

const INVALID = { error: "Consulta inválida." };

function perUser(name: string, windowMs: number, limit: () => number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${req.user?.id ?? "anon"}`,
    message: { error: message },
  });
}

const searchLimiter = perUser("search", 60_000, () => searchLimits.search, "Muitas buscas. Tente de novo em instantes.");
const reindexLimiter = perUser("reindex", 3_600_000, () => searchLimits.reindex, "Muitos pedidos de reindexação. Tente de novo mais tarde.");

async function search(req: Request, res: Response): Promise<void> {
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success || !normalizeText(parsed.data.q)) {
    res.status(400).json(INVALID);
    return;
  }
  res.json(await runSearch(req.user!, parsed.data));
}

async function status(req: Request, res: Response): Promise<void> {
  const raw = req.query.meetingId;
  if (raw === undefined) {
    res.json(await searchStatus(req.user!));
    return;
  }
  const one = typeof raw === "string" ? await meetingIndexStatus(req.user!, raw) : null;
  if (!one) {
    res.status(404).json({ error: "Reunião não encontrada." });
    return;
  }
  res.json(one);
}

async function reindex(req: Request, res: Response): Promise<void> {
  const parsed = SearchReindexInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Pedido inválido." });
    return;
  }
  const queued = await reindexOwn(req.user!, parsed.data.meetingId);
  if (queued === null) {
    res.status(404).json({ error: "Reunião não encontrada." });
    return;
  }
  res.status(202).json({ queued });
}

export function registerSearchRoutes(router: Router): void {
  router.get("/search", requirePermission("meetings.read"), searchLimiter, wrap(search));
  router.get("/search/status", requirePermission("meetings.read"), wrap(status));
  router.post("/search/reindex", requirePermission("meetings.manage"), reindexLimiter, wrap(reindex));
}
