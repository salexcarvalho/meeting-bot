import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { AgentLlmResult } from "@meeting-bot/contracts";
import { requireAgent } from "../agent/agentAuth";
import { features } from "../features";
import { parseBody, wrap } from "../routes";
import { hostJobs } from "./hostJobs";

// Pedidos de geração para o CLI da assinatura (host-agent, token Bearer).
const MAX_WAIT_S = 30;

features.agentRouters.push((app) => {
  const router = express.Router({ caseSensitive: true });
  // Só nestas rotas: as demais de /api/agent seguem para o próximo router sem checagem dobrada.
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });

  // Long-poll: devolve o próximo pedido ou 204 depois de `wait` segundos.
  router.get(
    "/llm/next",
    limiter,
    requireAgent,
    wrap(async (req: Request, res: Response) => {
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), MAX_WAIT_S) * 1000;
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const job = await hostJobs.next(wait, abort.signal);
      if (!job) return void (abort.signal.aborted ? undefined : res.status(204).end());
      if (abort.signal.aborted) return hostJobs.release(job.id);
      res.json(job);
    }),
  );

  router.post(
    "/llm/:id/result",
    limiter,
    requireAgent,
    wrap(async (req: Request, res: Response) => {
      const body = parseBody(AgentLlmResult, req, res);
      if (!body) return;
      if (!hostJobs.complete(String(req.params.id), body)) {
        return res.status(404).json({ error: "Pedido não encontrado ou expirado." });
      }
      res.json({ ok: true });
    }),
  );

  app.use("/api/agent", router);
});
