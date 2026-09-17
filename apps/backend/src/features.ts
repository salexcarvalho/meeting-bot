import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Express, Router } from "express";

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> | void;

// Registro das funcionalidades (user stories). Cada módulo em ./modules se registra aqui
// e o index monta tudo, sem imports circulares.
export const features = {
  /** Rotas autenticadas por cookie, montadas em /api depois do requireAuth. */
  authedRouters: [] as ((router: Router) => void)[],
  /** Rotas do host-agent (Bearer), montadas direto no app antes de /api. */
  agentRouters: [] as ((app: Express) => void)[],
  /** Handlers de upgrade WebSocket por pathname. */
  upgrades: {} as Record<string, UpgradeHandler>,
  starters: [] as (() => Promise<void> | void)[],
  stoppers: [] as (() => Promise<void>)[],
};
