import {
  DEFAULT_USER_SETTINGS,
  SETTINGS_SECTIONS,
  type AdminUser,
  type AgentPatch,
  type AgentProfile,
  type Language,
  type ProfilePatch,
  type RoleKey,
  type UserProfile,
  type UserSettings,
  type UserSettingsPatch,
} from "@meeting-bot/contracts";
import type { PoolClient } from "pg";
import { config } from "../config";
import { pool } from "../db";

// ---------- perfil ----------

interface UserRow {
  id: string;
  username: string;
  real_name: string | null;
  display_name: string | null;
  language: string;
  timezone: string | null;
  avatar_file: string | null;
  avatar_updated_at: Date | null;
  active: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  roles: RoleKey[];
  meeting_count?: string;
}

const PROFILE_SELECT = `
  SELECT u.id, u.username, u.real_name, u.display_name, u.language, u.timezone, u.avatar_file,
         u.avatar_updated_at, u.active, u.created_at, u.last_seen_at,
         COALESCE(array_agg(r.key ORDER BY r.id) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id`;

const version = (d: Date | null) => (d ? String(d.getTime()) : null);

export function effectiveName(row: { display_name: string | null; real_name: string | null; username: string }): string {
  return row.display_name || row.real_name || row.username;
}

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    displayName: row.display_name,
    name: effectiveName(row),
    language: row.language as Language,
    timezone: row.timezone ?? config.appTimezone,
    hasAvatar: Boolean(row.avatar_file),
    avatarVersion: version(row.avatar_updated_at),
    active: row.active,
    roles: row.roles,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const { rows } = await pool.query(`${PROFILE_SELECT} WHERE u.id = $1 GROUP BY u.id`, [userId]);
  return rows[0] ? toProfile(rows[0]) : null;
}

const PROFILE_COLUMNS: Record<keyof ProfilePatch, string> = {
  realName: "real_name",
  displayName: "display_name",
  language: "language",
  timezone: "timezone",
};

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [userId];
  for (const [key, column] of Object.entries(PROFILE_COLUMNS) as [keyof ProfilePatch, string][]) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return;
  await pool.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
}

export async function getAvatarFile(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT avatar_file FROM users WHERE id = $1`, [userId]);
  return rows[0]?.avatar_file ?? null;
}

export async function setAvatarFile(userId: string, file: string | null): Promise<void> {
  await pool.query(
    `UPDATE users SET avatar_file = $2, avatar_updated_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
            updated_at = now() WHERE id = $1`,
    [userId, file],
  );
}

// ---------- configurações ----------

// Valida seção por seção e campo por campo: valor salvo inválido (versão antiga) volta ao padrão.
export function mergeSettings(stored: unknown, patch: UserSettingsPatch = {}): UserSettings {
  const source = (stored && typeof stored === "object" ? stored : {}) as Record<string, Record<string, unknown>>;
  const out = structuredClone(DEFAULT_USER_SETTINGS) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, schema] of Object.entries(SETTINGS_SECTIONS)) {
    const merged = { ...source[section], ...(patch as Record<string, Record<string, unknown> | undefined>)[section] };
    for (const [field, fieldSchema] of Object.entries(schema.shape)) {
      if (!(field in merged)) continue;
      const parsed = (fieldSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }).safeParse(
        merged[field],
      );
      if (parsed.success) out[section][field] = parsed.data;
    }
  }
  return out as unknown as UserSettings;
}

export class SettingsError extends Error {}

export function validateSettings(settings: UserSettings): void {
  if (settings.meetings.displayIdentity === "custom" && !settings.meetings.customDisplayName) {
    throw new SettingsError("Informe o nome personalizado para usar a opção “Nome personalizado”.");
  }
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const { rows } = await pool.query(`SELECT data FROM user_settings WHERE user_id = $1`, [userId]);
  return mergeSettings(rows[0]?.data);
}

export async function updateSettings(userId: string, patch: UserSettingsPatch): Promise<UserSettings> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT data FROM user_settings WHERE user_id = $1 FOR UPDATE`, [userId]);
    const next = mergeSettings(rows[0]?.data, patch);
    validateSettings(next);
    await client.query(
      `INSERT INTO user_settings (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [userId, next],
    );
    await client.query("COMMIT");
    return next;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function resetSettings(userId: string, client: PoolClient | typeof pool = pool): Promise<void> {
  await client.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
}

// ---------- agente ----------

interface AgentRow {
  name: string;
  description: string | null;
  role: string | null;
  specialty: string | null;
  base_prompt: string | null;
  professional_context: string | null;
  priority_technologies: string[];
  highlight_decision_types: string[];
  doc_format: string;
  language: string;
  tone: string;
  detail_level: string;
  avatar_file: string | null;
  avatar_updated_at: Date | null;
  voice_file: string | null;
  voice_seconds: string | null;
  voice_updated_at: Date | null;
  updated_at: Date | null;
}

export function defaultAgent(): AgentProfile {
  return {
    name: config.defaultAgentName,
    description: null,
    role: null,
    specialty: null,
    basePrompt: null,
    professionalContext: null,
    priorityTechnologies: [],
    highlightDecisionTypes: [],
    docFormat: "markdown",
    language: "pt-BR",
    tone: "neutro",
    detailLevel: "normal",
    hasAvatar: false,
    avatarVersion: null,
    hasVoice: false,
    voiceVersion: null,
    voiceDurationSeconds: null,
    updatedAt: null,
  };
}

function toAgent(row: AgentRow): AgentProfile {
  return {
    name: row.name,
    description: row.description,
    role: row.role,
    specialty: row.specialty,
    basePrompt: row.base_prompt,
    professionalContext: row.professional_context,
    priorityTechnologies: row.priority_technologies,
    highlightDecisionTypes: row.highlight_decision_types,
    docFormat: row.doc_format as AgentProfile["docFormat"],
    language: row.language as Language,
    tone: row.tone as AgentProfile["tone"],
    detailLevel: row.detail_level as AgentProfile["detailLevel"],
    hasAvatar: Boolean(row.avatar_file),
    avatarVersion: version(row.avatar_updated_at),
    hasVoice: Boolean(row.voice_file),
    voiceVersion: version(row.voice_updated_at),
    voiceDurationSeconds: row.voice_seconds === null ? null : Number(row.voice_seconds),
    updatedAt: row.updated_at?.toISOString() ?? null,
  };
}

export async function getAgent(userId: string): Promise<AgentProfile> {
  const { rows } = await pool.query(`SELECT * FROM agents WHERE owner_id = $1`, [userId]);
  return rows[0] ? toAgent(rows[0]) : defaultAgent();
}

const AGENT_COLUMNS: Record<keyof AgentPatch, string> = {
  name: "name",
  description: "description",
  role: "role",
  specialty: "specialty",
  basePrompt: "base_prompt",
  professionalContext: "professional_context",
  priorityTechnologies: "priority_technologies",
  highlightDecisionTypes: "highlight_decision_types",
  docFormat: "doc_format",
  language: "language",
  tone: "tone",
  detailLevel: "detail_level",
};

async function ensureAgent(userId: string): Promise<void> {
  await pool.query(`INSERT INTO agents (owner_id, name) VALUES ($1, $2) ON CONFLICT (owner_id) DO NOTHING`, [
    userId,
    config.defaultAgentName,
  ]);
}

export async function updateAgent(userId: string, patch: AgentPatch): Promise<AgentProfile> {
  await ensureAgent(userId);
  const sets: string[] = [];
  const values: unknown[] = [userId];
  for (const [key, column] of Object.entries(AGENT_COLUMNS) as [keyof AgentPatch, string][]) {
    if (patch[key] === undefined) continue;
    const value = patch[key];
    values.push(Array.isArray(value) ? [...new Set(value)] : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length) {
    await pool.query(`UPDATE agents SET ${sets.join(", ")}, updated_at = now() WHERE owner_id = $1`, values);
  }
  return getAgent(userId);
}

export type AgentFileKind = "avatar" | "voice";

export async function getAgentFile(userId: string, kind: AgentFileKind): Promise<string | null> {
  const { rows } = await pool.query(`SELECT ${kind}_file AS file FROM agents WHERE owner_id = $1`, [userId]);
  return rows[0]?.file ?? null;
}

export async function setAgentFile(
  userId: string,
  kind: AgentFileKind,
  file: string | null,
  seconds: number | null = null,
): Promise<void> {
  await ensureAgent(userId);
  const extra = kind === "voice" ? ", voice_seconds = $3" : "";
  const values: unknown[] = [userId, file];
  if (kind === "voice") values.push(seconds);
  await pool.query(
    `UPDATE agents SET ${kind}_file = $2,
            ${kind}_updated_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END${extra},
            updated_at = now()
      WHERE owner_id = $1`,
    values,
  );
}

// ---------- administração ----------

export async function listAdminUsers(): Promise<AdminUser[]> {
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT count(*) FROM meetings m WHERE m.created_by = p.id) AS meeting_count
       FROM (${PROFILE_SELECT} GROUP BY u.id) p
      ORDER BY p.active DESC, p.username`,
  );
  return rows.map((row: UserRow) => ({
    ...toProfile(row),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    meetingCount: Number(row.meeting_count ?? 0),
  }));
}

export async function countActiveWithRole(role: RoleKey, client: PoolClient | typeof pool = pool): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
      WHERE r.key = $1 AND u.active`,
    [role],
  );
  return rows[0].n;
}

export async function getRoles(userId: string, client: PoolClient | typeof pool = pool): Promise<RoleKey[]> {
  const { rows } = await client.query(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.id`,
    [userId],
  );
  return rows.map((r) => r.key);
}

export async function setRoles(client: PoolClient, userId: string, roles: RoleKey[], grantedBy: string): Promise<void> {
  await client.query(
    `DELETE FROM user_roles ur USING roles r WHERE ur.role_id = r.id AND ur.user_id = $1 AND NOT (r.key = ANY($2))`,
    [userId, roles],
  );
  await client.query(
    `INSERT INTO user_roles (user_id, role_id, granted_by)
       SELECT $1, id, $3 FROM roles WHERE key = ANY($2)
     ON CONFLICT DO NOTHING`,
    [userId, roles, grantedBy],
  );
}
