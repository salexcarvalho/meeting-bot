import type { Request, RequestHandler } from "express";
import { rateLimit, type RateLimitInfo } from "express-rate-limit";

// Limite de tentativas de login por IP. Só a primeira requisição que estoura o limite em cada janela
// dispara `onFirstBlock` (auditoria); as seguintes recebem 429 direto, sem consulta nem escrita no banco,
// para um flood não gerar uma linha de auditoria por requisição.

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
const BLOCKED_MESSAGE = "Muitas tentativas de login. Tente de novo em alguns minutos.";

export function createLoginLimiter(
  onFirstBlock: (req: Request) => Promise<void> | void,
  options: { limit?: number; windowMs?: number } = {},
): RequestHandler {
  const limit = options.limit ?? LOGIN_LIMIT;
  return rateLimit({
    windowMs: options.windowMs ?? LOGIN_WINDOW_MS,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: async (req, res, next) => {
      try {
        if ((req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.used === limit + 1) await onFirstBlock(req);
        res.status(429).json({ error: BLOCKED_MESSAGE });
      } catch (err) {
        next(err);
      }
    },
  });
}
