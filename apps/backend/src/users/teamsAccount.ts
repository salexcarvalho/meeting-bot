import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import type { TeamsAccountStatus } from "@meeting-bot/contracts";
import { identifiesRecorder } from "../bot/identity";
import { config } from "../config";
import { pool } from "../db";

// Conta Microsoft dedicada ao agente no Teams (constituição 2.2.0, princípio II). O sistema nunca vê
// nem guarda a senha: guarda só a sessão que o usuário abriu na própria máquina (cookies e
// localStorage do Playwright), cifrada com AES-256-GCM. A chave sai do AGENT_TOKEN.

export const MAX_SESSION_BYTES = 2 * 1024 * 1024;

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "meeting-bot", "teams-session-v1", 32));
}

export function seal(plain: Buffer, secret: string = config.agentToken): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Lança se o conteúdo foi alterado ou a chave mudou. */
export function unseal(sealed: Buffer, secret: string = config.agentToken): Buffer {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw new Error("sessão cifrada inválida");
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export class TeamsAccountError extends Error {}

export interface SessionState {
  cookies: Record<string, unknown>[];
  origins: Record<string, unknown>[];
}

const MICROSOFT_DOMAIN = /(^|\.)(microsoftonline|microsoft|live|office|skype)\.com$/i;

/** Confere que o arquivo é uma sessão do Playwright com cookies da Microsoft e guarda só cookies e localStorage. */
export function parseSession(raw: Buffer): SessionState {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TeamsAccountError("O arquivo não é um JSON válido. Gere-o com `npm run teams:login`.");
  }
  const state = json as { cookies?: unknown; origins?: unknown } | null;
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies)) {
    throw new TeamsAccountError("O arquivo não parece uma sessão do navegador. Gere-o com `npm run teams:login`.");
  }
  const cookies = state.cookies.filter(
    (c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { domain?: unknown }).domain === "string",
  );
  if (!cookies.some((c) => MICROSOFT_DOMAIN.test(String(c.domain).replace(/^\./, "")))) {
    throw new TeamsAccountError("A sessão não tem login da Microsoft. Entre na conta do agente antes de salvar.");
  }
  const origins = Array.isArray(state.origins)
    ? state.origins.filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    : [];
  return { cookies, origins };
}

/** O nome que aparece no Teams precisa dizer que é a ata (constituição, princípio II). */
export function validateAccountName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 60) throw new TeamsAccountError("Informe o nome da conta (2 a 60 caracteres).");
  if (!identifiesRecorder(trimmed)) {
    throw new TeamsAccountError('O nome da conta precisa dizer que é a ata (ex.: "Ata do Sérgio"). Ajuste o nome da conta na Microsoft.');
  }
  return trimmed;
}

export async function getTeamsAccountStatus(userId: string): Promise<TeamsAccountStatus> {
  const { rows } = await pool.query(
    `SELECT account_name, updated_at, expired_at FROM teams_accounts WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { connected: false, accountName: null, updatedAt: null, expired: false };
  return {
    connected: true,
    accountName: row.account_name,
    updatedAt: (row.updated_at as Date).toISOString(),
    expired: row.expired_at !== null,
  };
}

export async function saveTeamsAccount(userId: string, accountName: string, session: SessionState): Promise<void> {
  const sealed = seal(Buffer.from(JSON.stringify(session), "utf8"));
  await pool.query(
    `INSERT INTO teams_accounts (user_id, account_name, session_enc) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET account_name = $2, session_enc = $3, expired_at = NULL, updated_at = now()`,
    [userId, accountName, sealed],
  );
}

export interface TeamsAccount {
  userId: string;
  name: string;
  state: SessionState;
}

/** null quando não há conta ou a sessão não abre (chave trocada): o bot volta a entrar como convidado. */
export async function loadTeamsAccount(userId: string): Promise<TeamsAccount | null> {
  const { rows } = await pool.query(`SELECT account_name, session_enc FROM teams_accounts WHERE user_id = $1`, [userId]);
  if (!rows[0]) return null;
  try {
    const state = JSON.parse(unseal(rows[0].session_enc as Buffer).toString("utf8")) as SessionState;
    return { userId, name: rows[0].account_name, state };
  } catch {
    console.error(`[teams-account] sessão de ${userId} não abriu (AGENT_TOKEN mudou?); conecte a conta de novo`);
    return null;
  }
}

/** Guarda a sessão renovada pelo Teams na última entrada, para ela não vencer sozinha. */
export async function refreshTeamsSession(userId: string, session: SessionState): Promise<void> {
  const sealed = seal(Buffer.from(JSON.stringify(session), "utf8"));
  await pool.query(`UPDATE teams_accounts SET session_enc = $2, expired_at = NULL, updated_at = now() WHERE user_id = $1`, [userId, sealed]);
}

export async function markTeamsSessionExpired(userId: string): Promise<void> {
  await pool.query(`UPDATE teams_accounts SET expired_at = COALESCE(expired_at, now()) WHERE user_id = $1`, [userId]);
}

export async function removeTeamsAccount(userId: string): Promise<void> {
  await pool.query(`DELETE FROM teams_accounts WHERE user_id = $1`, [userId]);
}
