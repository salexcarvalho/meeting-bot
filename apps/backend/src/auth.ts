import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { deleteSession, findSessionUser, insertSession } from "./db";
import { User } from "./types";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const SESSION_COOKIE = "mb_session";
export const MIN_PASSWORD_LENGTH = 10;

// Formato: scrypt$N$r$p$saltB64$hashB64
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hash fixo usado quando o usuário não existe, pra login com usuário
// inexistente levar o mesmo tempo que senha errada (evita enumeração).
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function validatePasswordStrength(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password.length > 200) return "Senha longa demais.";
  return null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function startSession(res: Response, userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const maxAgeMs = config.sessionTtlHours * 3600_000;
  await insertSession(hashToken(token), userId, new Date(Date.now() + maxAgeMs));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge: maxAgeMs,
    path: "/",
  });
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") await deleteSession(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionTokenHash?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !token) {
    return res.status(401).json({ error: "não autenticado" });
  }
  const tokenHash = hashToken(token);
  const user = await findSessionUser(tokenHash);
  if (!user) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.status(401).json({ error: "sessão expirada" });
  }
  req.user = user;
  req.sessionTokenHash = tokenHash;
  next();
}

function sameHost(url: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(url).host === host;
  } catch {
    return false;
  }
}

// Defesa extra contra CSRF além do SameSite=Lax: requisições que mudam
// estado precisam vir da mesma origem. Sem Origin (navegador antigo ou proxy),
// vale Sec-Fetch-Site e, na falta dele, o Referer. Sem nenhum dos três é um
// cliente fora do navegador (curl), que não carrega cookie de terceiros.
export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const host = req.get("x-forwarded-host") || req.get("host");
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  const referer = req.get("referer");
  let allowed: boolean;
  if (origin) allowed = sameHost(origin, host);
  else if (fetchSite) allowed = fetchSite === "same-origin" || fetchSite === "none";
  else if (referer) allowed = sameHost(referer, host);
  else allowed = true;
  if (allowed) return next();
  res.status(403).json({ error: "origem não permitida" });
}
