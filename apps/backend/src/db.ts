import { EventEmitter } from "events";
import { Pool, PoolClient } from "pg";
import type { Attendee, Channel, ItemType, MeetingSource, MeetingStatus, Platform, RoleKey } from "@meeting-bot/contracts";
import { config } from "./config";
import { User } from "./types";

export const pool = new Pool({ connectionString: config.databaseUrl });

// "changed" (meetingId) sempre que o estado de uma reunião muda; o hub ao vivo escuta.
export const meetingEvents = new EventEmitter();
meetingEvents.setMaxListeners(50);

export function emitMeetingChanged(meetingId: string): void {
  meetingEvents.emit("changed", meetingId);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- usuários ----------

const USER_AUTHZ_SELECT = `
  SELECT u.id, u.username,
         COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
         COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id`;

export async function findUserAuthz(userId: string): Promise<User | null> {
  const { rows } = await pool.query(`${USER_AUTHZ_SELECT} WHERE u.id = $1 GROUP BY u.id`, [userId]);
  return rows[0] ?? null;
}

// Sem papel informado: o primeiro usuário da base vira SUPER_ADMIN, os demais USER.
export async function createUser(
  username: string,
  passwordHash: string,
  opts: { role?: RoleKey; realName?: string | null; displayName?: string | null; grantedBy?: string | null } = {},
): Promise<User> {
  const id = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(73100003)");
    const { rows } = await client.query(
      `INSERT INTO users (username, password_hash, real_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, passwordHash, opts.realName ?? null, opts.displayName ?? null],
    );
    const role =
      opts.role ??
      ((await client.query(`SELECT 1 FROM user_roles LIMIT 1`)).rowCount ? "USER" : "SUPER_ADMIN");
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, granted_by) SELECT $1, id, $3 FROM roles WHERE key = $2`,
      [rows[0].id, role, opts.grantedBy ?? null],
    );
    return rows[0].id as string;
  });
  return (await findUserAuthz(id))!;
}

export async function findUserByUsername(
  username: string,
): Promise<{ id: string; username: string; password_hash: string; active: boolean } | null> {
  const { rows } = await pool.query(`SELECT id, username, password_hash, active FROM users WHERE username = $1`, [
    username,
  ]);
  return rows[0] ?? null;
}

export async function getPasswordHash(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return rows[0]?.password_hash ?? null;
}

export async function updatePassword(userId: string, passwordHash: string): Promise<void> {
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
}

export async function deleteUser(userId: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function listUsers(): Promise<
  { id: string; username: string; active: boolean; roles: RoleKey[]; created_at: Date }[]
> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.active, u.created_at,
            COALESCE(array_agg(r.key ORDER BY r.id) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      GROUP BY u.id
      ORDER BY u.username`,
  );
  return rows;
}

// ---------- sessões ----------

export async function insertSession(tokenHash: string, userId: string, expiresAt: Date) {
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

export async function findSessionUser(tokenHash: string): Promise<User | null> {
  const { rows } = await pool.query(
    `${USER_AUTHZ_SELECT}
      JOIN sessions s ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active
     GROUP BY u.id`,
    [tokenHash],
  );
  const user: User | undefined = rows[0];
  if (user) {
    pool
      .query(
        `UPDATE users SET last_seen_at = now()
          WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
        [user.id],
      )
      .catch(() => {});
  }
  return user ?? null;
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

export async function deleteUserSessions(userId: string, exceptTokenHash?: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2`, [
    userId,
    exceptTokenHash ?? null,
  ]);
}

export async function purgeExpiredSessions(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
}

// ---------- reuniões ----------

export interface MeetingRow {
  id: string;
  title: string;
  platform: Platform;
  url: string | null;
  status: MeetingStatus;
  error_message: string | null;
  created_by: string | null;
  created_by_username: string | null;
  audio_path: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  transcribed_at: Date | null;
  transcription_provider: string | null;
  /** ASR escolhido para o próximo passe final (null = padrão do .env) */
  asr_provider: string | null;
  bot_display_name: string | null;
  ata_markdown: string | null;
  source: MeetingSource;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  organizer: string | null;
  attendees: Attendee[];
  description: string | null;
  location: string | null;
  ical_uid: string | null;
  recurrence_key: string;
  ical_sequence: number;
  project_id: string | null;
  project_name: string | null;
  project_suggested: boolean;
  skip_recording: boolean;
  stop_requested: boolean;
  last_speech_at: Date | null;
  live_summary: string | null;
  live_summary_at: Date | null;
  analysis: MeetingAnalysis | null;
  analyzed_at: Date | null;
  analysis_provider: string | null;
}

export interface MeetingAnalysis {
  objetivo: string;
  resumo_executivo: string;
  assuntos: { titulo: string; resumo: string }[];
  observacoes_arquiteto: string[];
}

export async function createMeeting(input: {
  title: string;
  platform: Platform;
  url: string | null;
  status: MeetingStatus;
  createdBy: string | null;
  source: MeetingSource;
  audioPath?: string;
  audioFormat?: string;
  asrProvider?: string | null;
  botDisplayName?: string | null;
}): Promise<string> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO meetings (title, platform, url, status, created_by, audio_path, source, asr_provider, bot_display_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        input.title,
        input.platform,
        input.url,
        input.status,
        input.createdBy,
        input.audioPath ?? null,
        input.source,
        input.asrProvider ?? null,
        input.botDisplayName ?? null,
      ],
    );
    const id: string = rows[0].id;
    if (input.audioPath) {
      await client.query(
        `INSERT INTO meeting_audio (meeting_id, channel, path, format) VALUES ($1, 'mixed', $2, $3)`,
        [id, input.audioPath, input.audioFormat ?? "original"],
      );
    }
    return id;
  });
}

export async function setMeetingStatus(id: string, status: MeetingStatus, errorMessage: string | null = null) {
  await pool.query(`UPDATE meetings SET status = $2, error_message = $3 WHERE id = $1`, [id, status, errorMessage]);
  emitMeetingChanged(id);
}

// Modo Agente: o bot grava um arquivo único (canal misto).
export async function setAudioPath(id: string, audioPath: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE meetings SET audio_path = $2 WHERE id = $1`, [id, audioPath]);
    await client.query(
      `INSERT INTO meeting_audio (meeting_id, channel, path, format) VALUES ($1, 'mixed', $2, 'ogg_opus')
       ON CONFLICT (meeting_id, channel) DO UPDATE SET path = EXCLUDED.path, format = EXCLUDED.format, updated_at = now()`,
      [id, audioPath],
    );
  });
}

export async function markStarted(id: string): Promise<void> {
  await pool.query(
    `UPDATE meetings SET status = 'in_call', started_at = now(), error_message = NULL WHERE id = $1`,
    [id],
  );
  emitMeetingChanged(id);
}

export async function markEnded(id: string): Promise<void> {
  await pool.query(`UPDATE meetings SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, [id]);
}

export async function markDone(id: string): Promise<void> {
  await pool.query(`UPDATE meetings SET status = 'done', error_message = NULL WHERE id = $1`, [id]);
  emitMeetingChanged(id);
}

export const meetingSelect = `
  SELECT m.*, u.username AS created_by_username, p.name AS project_name
  FROM meetings m
  LEFT JOIN users u ON u.id = m.created_by
  LEFT JOIN projects p ON p.id = m.project_id`;

export async function getMeeting(id: string): Promise<MeetingRow | null> {
  const { rows } = await pool.query(`${meetingSelect} WHERE m.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listMeetings(opts: {
  /** filtro de visibilidade: SQL com $1 = id do usuário (authz/visibleMeetingsSql) */
  visibleTo: { userId: string; sql: string };
  limit?: number;
  before?: Date | null;
  projectId?: string | null;
  status?: MeetingStatus[] | null;
}): Promise<MeetingRow[]> {
  const params: unknown[] = [opts.visibleTo.userId];
  const where: string[] = [opts.visibleTo.sql];
  // Histórico: reuniões que aconteceram ou vão acontecer, ordenadas pelo horário efetivo.
  const when = `COALESCE(m.started_at, m.scheduled_start, m.created_at)`;
  if (opts.before) {
    params.push(opts.before);
    where.push(`${when} < $${params.length}`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`m.project_id = $${params.length}`);
  }
  if (opts.status?.length) {
    params.push(opts.status);
    where.push(`m.status = ANY($${params.length})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const { rows } = await pool.query(
    `${meetingSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${when} DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function deleteMeeting(id: string): Promise<void> {
  await pool.query(`DELETE FROM meetings WHERE id = $1`, [id]);
}

// ---------- áudio por canal ----------

export interface AudioRow {
  channel: Channel;
  path: string;
  format: string;
  bytes: number;
  duration_seconds: number | null;
}

export async function listAudio(meetingId: string): Promise<AudioRow[]> {
  const { rows } = await pool.query(
    `SELECT channel, path, format, bytes, duration_seconds FROM meeting_audio
     WHERE meeting_id = $1 ORDER BY channel`,
    [meetingId],
  );
  return rows.map((r) => ({
    ...r,
    bytes: Number(r.bytes),
    duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
  }));
}

export async function upsertAudio(
  meetingId: string,
  channel: Channel,
  data: { path: string; format: string; bytes: number; durationSeconds?: number | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO meeting_audio (meeting_id, channel, path, format, bytes, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (meeting_id, channel) DO UPDATE
       SET path = EXCLUDED.path, format = EXCLUDED.format, bytes = EXCLUDED.bytes,
           duration_seconds = EXCLUDED.duration_seconds, updated_at = now()`,
    [meetingId, channel, data.path, data.format, data.bytes, data.durationSeconds ?? null],
  );
}

export async function setAudioBytes(meetingId: string, channel: Channel, bytes: number): Promise<void> {
  await pool.query(
    `UPDATE meeting_audio SET bytes = $3, updated_at = now() WHERE meeting_id = $1 AND channel = $2`,
    [meetingId, channel, bytes],
  );
}

// ---------- recuperação no boot ----------

// Após restart não há navegador/ffmpeg vivos. Assistente sem áudio: na agenda, ainda no horário,
// volta a `scheduled` e entra de novo; nos demais casos vira erro. Processamentos interrompidos
// voltam pra fila. Gravações locais (recording/stopping) continuam: o host-agent reconecta.
/**
 * Reuniões a retomar depois de um reinício. Quem já estava gerando a ata (transcrição final
 * pronta) retoma só a análise; o provedor é o automático (a escolha feita na tela não sobrevive).
 */
export async function recoverInterruptedMeetings(): Promise<{ id: string; step: "all" | "analysis" }[]> {
  await pool.query(
    `UPDATE meetings SET status = 'scheduled', started_at = NULL, error_message = NULL
     WHERE source IN ('ics', 'manual') AND status IN ('joining', 'waiting_admission', 'in_call')
       AND audio_path IS NULL AND NOT skip_recording AND scheduled_end > now()`,
  );
  await pool.query(
    `UPDATE meetings SET status = 'error', error_message = 'Serviço reiniciado antes de o assistente gravar a reunião.'
     WHERE status IN ('joining', 'waiting_admission', 'in_call') AND audio_path IS NULL`,
  );
  await pool.query(
    `UPDATE meetings SET ended_at = now()
     WHERE status IN ('joining', 'waiting_admission', 'in_call') AND started_at IS NOT NULL AND ended_at IS NULL`,
  );
  const { rows } = await pool.query(
    `SELECT m.id,
            m.status = 'generating_ata' AND EXISTS (
              SELECT 1 FROM transcript_segments s WHERE s.meeting_id = m.id AND s.pass = 'final'
            ) AS analysis_only
       FROM meetings m
      WHERE m.status IN ('queued', 'transcribing', 'generating_ata')
         OR m.status IN ('joining', 'waiting_admission', 'in_call')
      ORDER BY m.created_at`,
  );
  return rows.map((r) => ({ id: r.id, step: r.analysis_only ? "analysis" : "all" }));
}

export function isItemType(value: unknown, types: readonly ItemType[]): value is ItemType {
  return typeof value === "string" && (types as readonly string[]).includes(value);
}
