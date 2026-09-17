import { createHash, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { audit } from "../security/audit";

// Autenticação do host-agent: segredo local compartilhado (AGENT_TOKEN), só em /api/agent/*.

const digest = (value: string) => createHash("sha256").update(value).digest();
const expected = digest(config.agentToken);

const failures = new Map<string, { count: number; since: number }>();
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 20;

function clientKey(ip: string | undefined): string {
  return ip ?? "desconhecido";
}

function tooManyFailures(ip: string | undefined): boolean {
  const entry = failures.get(clientKey(ip));
  if (!entry) return false;
  if (Date.now() - entry.since > WINDOW_MS) {
    failures.delete(clientKey(ip));
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function registerFailure(ip: string | undefined, where: string): void {
  const key = clientKey(ip);
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.since > WINDOW_MS) failures.set(key, { count: 1, since: Date.now() });
  else entry.count++;
  audit("agent_auth_failed", { ip: key, where });
}

export function checkAgentToken(header: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1].trim()), expected);
}

export function requireAgent(req: Request, res: Response, next: NextFunction): void {
  if (tooManyFailures(req.ip)) {
    res.status(429).json({ error: "Muitas tentativas inválidas." });
    return;
  }
  if (!checkAgentToken(req.get("authorization"))) {
    registerFailure(req.ip, req.path);
    res.status(401).json({ error: "token do agente inválido" });
    return;
  }
  next();
}

export function authorizeAgentUpgrade(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress;
  if (tooManyFailures(ip)) return false;
  if (checkAgentToken(req.headers.authorization)) return true;
  registerFailure(ip, "ws:audio");
  return false;
}
