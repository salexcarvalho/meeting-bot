import { config } from "../config";
import { pool } from "../db";

// Dono da máquina onde roda o host-agent: só as reuniões dele são gravadas por aqui.
// AGENT_OWNER (username) no .env. Vazio = primeiro usuário cadastrado, se ainda for SUPER_ADMIN ativo.
// O dono nunca passa sozinho para outra pessoa: rebaixar ou desativar o dono deixa a máquina sem dono
// (não grava nada) até alguém definir AGENT_OWNER.

export interface HostOwner {
  id: string;
  name: string;
}

const TTL_MS = 60_000;
let cached: { at: number; owner: HostOwner | null } | null = null;

export function invalidateHostOwner(): void {
  cached = null;
}

export async function hostAgentOwner(): Promise<HostOwner | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.owner;
  const { rows } = config.agentOwner
    ? await pool.query(
        `SELECT id, COALESCE(display_name, real_name, username) AS name FROM users WHERE username = $1 AND active`,
        [config.agentOwner],
      )
    : await pool.query(
        `SELECT u.id, COALESCE(u.display_name, u.real_name, u.username) AS name
           FROM (SELECT * FROM users ORDER BY created_at, id LIMIT 1) u
          WHERE u.active AND EXISTS (
            SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id AND r.key = 'SUPER_ADMIN')`,
      );
  const owner: HostOwner | null = rows[0] ?? null;
  if (!owner) console.warn("[host-agent] nenhum dono resolvido: defina AGENT_OWNER com um usuário ativo");
  cached = { at: Date.now(), owner };
  return owner;
}
