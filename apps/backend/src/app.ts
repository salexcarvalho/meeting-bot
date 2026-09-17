import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import multer from "multer";

import { requireSameOrigin } from "./auth";
import { config } from "./config";
import { pool } from "./db";
import { features } from "./features";
import { buildRouter } from "./routes";
import "./modules";

// App HTTP sem efeitos colaterais de boot (usado pelo index e pelos testes de integração).
export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  if (config.trustProxy) {
    app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "blob:"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests": config.cookieSecure ? [] : null,
        },
      },
      strictTransportSecurity: config.cookieSecure,
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  app.get("/healthz", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  });

  // Rotas do host-agent (token Bearer) ficam fora do requireAuth por cookie.
  for (const mount of features.agentRouters) mount(app);
  app.use("/api", requireSameOrigin, buildRouter());
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Rota não encontrada." });
  });

  // SPA (build do React): arquivos estáticos + fallback para o index.html.
  app.use(express.static(config.publicDir, { index: "index.html", maxAge: "1h" }));
  app.get(/^\/(?!api\/|healthz).*/, (_req, res, next) => {
    res.sendFile(path.join(config.publicDir, "index.html"), (err) => err && next());
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "Arquivo maior que o limite permitido." : `Upload inválido: ${err.message}`;
      return res.status(status).json({ error: message });
    }
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ error: "Requisição inválida." });
    }
    console.error("[http] erro:", err);
    if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
  });
  return app;
}
