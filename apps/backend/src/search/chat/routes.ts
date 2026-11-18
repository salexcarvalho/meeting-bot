import type { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ChatRequest } from "@meeting-bot/contracts";
import { requirePermission } from "../../authz";
import { wrap } from "../../routes";
import { chatEnabled } from "../gate";
import { searchLimits } from "../limits";
import { answerQuestion, ChatUnavailableError } from "./service";

// POST /search/chat (specs/003-busca-chat/contracts/rest-api.md). Pergunta, resposta e trechos
// nunca vão para log nem para auditoria (FR-033). O corpo é estrito: `llm`, `provider` e qualquer
// campo desconhecido são recusados (o chat usa o provedor de LLM_GENERATION_PROVIDER).

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: () => searchLimits.chat,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `chat:${req.user?.id ?? "anon"}`,
  message: { error: "Muitas perguntas seguidas. Tente de novo em instantes." },
});

async function chat(req: Request, res: Response): Promise<void> {
  if (!chatEnabled()) {
    res.status(503).json({ error: "O chat está desligado neste servidor." });
    return;
  }
  const parsed = ChatRequest.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Pergunta inválida." });
    return;
  }
  try {
    res.json(await answerQuestion(req.user!, parsed.data));
  } catch (err) {
    if (!(err instanceof ChatUnavailableError)) throw err;
    res.status(503).json({ error: err.message });
  }
}

export function registerChatRoutes(router: Router): void {
  router.post("/search/chat", requirePermission("meetings.read"), chatLimiter, wrap(chat));
}
