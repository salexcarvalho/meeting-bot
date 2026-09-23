import { config } from "../config";
import { emitMeetingChanged, pool } from "../db";
import { resolveBotIdentity } from "../users/identity";
import { detectPlatform } from "./link";
import { isTransientNetworkError } from "./navigate";
import { activeBotCount, startBot } from "./runner";
import { botUrlKey, releaseBotUrl, reserveBotUrl } from "./state";

// Assistente nas reuniões da agenda (decisão do usuário em 2026-09-17): no horário, entra em toda
// reunião com link do Teams/Meet que não esteja marcada "Não gravar" e grava de dentro da chamada.
// O PC não grava sozinho (AUTO_LOCAL_RECORDING=false).

const AGENDA_SOURCES = ["ics", "manual"];
/** "Enviar agora" até este tempo antes do início também espera a admissão até o fim previsto */
const EARLY_MS = 15 * 60_000;

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Candidate {
  id: string;
  url: string | null;
  created_by: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  error_message?: string | null;
}

type LaunchResult = "started" | "link" | "same_link" | "limit" | "changed";

const NOTES: Partial<Record<LaunchResult, string>> = {
  link: "O assistente só entra em links https do Teams ou do Google Meet.",
  same_link: "Já existe um assistente nesta chamada; este aguarda ele sair.",
  limit: `Limite de ${config.maxConcurrentBots} assistentes simultâneos atingido; este entra quando um sair.`,
};

async function launch(m: Candidate, from: string[]): Promise<LaunchResult> {
  const requestedAt = Date.now();
  const target = detectPlatform(m.url);
  if (!target) return "link";
  const urlKey = botUrlKey(target.url);
  if (!reserveBotUrl(urlKey)) return "same_link";
  try {
    if (activeBotCount() > config.maxConcurrentBots) return "limit";
    const identity = m.created_by
      ? await resolveBotIdentity(m.created_by, undefined, target.platform)
      : { name: config.botDisplayName, avatarPath: null };
    const updated = await pool.query(
      `UPDATE meetings SET status = 'joining', skip_recording = false, error_message = NULL,
         started_at = NULL, ended_at = NULL, bot_display_name = $3
       WHERE id = $1 AND status = ANY($2)`,
      [m.id, from, identity.name],
    );
    if (updated.rowCount !== 1) return "changed";
    // Perto do horário, espera a admissão e não sai por estar sozinho antes do fim previsto.
    const now = Date.now();
    const start = m.scheduled_start?.getTime() ?? Infinity;
    const end = m.scheduled_end && start - EARLY_MS <= now && now < m.scheduled_end.getTime() ? m.scheduled_end : null;
    startBot(m.id, target.url, target.platform, { identity, urlKey, requestedAt, admitUntil: end, stayUntil: end });
    emitMeetingChanged(m.id);
    return "started";
  } finally {
    releaseBotUrl(urlKey);
  }
}

/** Explica na reunião por que o assistente ainda não entrou (só grava se a mensagem mudou). */
async function note(meetingId: string, message: string): Promise<void> {
  const r = await pool.query(
    `UPDATE meetings SET error_message = $2
     WHERE id = $1 AND status = 'scheduled' AND error_message IS DISTINCT FROM $2`,
    [meetingId, message],
  );
  if (r.rowCount) emitMeetingChanged(meetingId);
}

/** Nova tentativa depois de falha de rede: quantas vezes e quanto esperar entre elas. */
export const NETWORK_RETRIES = 3;
export const NETWORK_RETRY_WAIT_MS = 60_000;
const networkRetries = new Map<string, number>();

let ticking = false;

/** Ciclo do agendador: põe o assistente nas reuniões que começaram e ainda não terminaram. */
export async function tickAutoAssistant(now = new Date()): Promise<void> {
  if (!config.autoAssistant || ticking) return;
  ticking = true;
  try {
    const { rows } = await pool.query<Candidate>(
      `SELECT id, url, created_by, scheduled_start, scheduled_end FROM meetings
       WHERE source = ANY($1) AND status = 'scheduled' AND NOT skip_recording AND url IS NOT NULL
         AND scheduled_start <= $2 AND scheduled_end > $2
       ORDER BY scheduled_start, id`,
      [AGENDA_SOURCES, now],
    );
    for (const m of rows) {
      const result = await launch(m, ["scheduled"]);
      if (result === "started") console.log(`[assistente] entrando na reunião da agenda ${m.id}`);
      const message = NOTES[result];
      if (message) await note(m.id, message);
    }

    // Falha de rede ao abrir o link (sem ter entrado): tenta de novo enquanto a reunião dura.
    const { rows: failed } = await pool.query<Candidate>(
      `SELECT id, url, created_by, scheduled_start, scheduled_end, error_message FROM meetings
       WHERE source = ANY($1) AND status = 'error' AND NOT skip_recording AND url IS NOT NULL
         AND started_at IS NULL AND ended_at <= $3
         AND scheduled_start <= $2 AND scheduled_end > $2
         AND NOT EXISTS (SELECT 1 FROM meeting_audio a WHERE a.meeting_id = meetings.id)
       ORDER BY scheduled_start, id`,
      [AGENDA_SOURCES, now, new Date(now.getTime() - NETWORK_RETRY_WAIT_MS)],
    );
    for (const m of failed) {
      if (!isTransientNetworkError(m.error_message)) continue;
      const used = networkRetries.get(m.id) ?? 0;
      if (used >= NETWORK_RETRIES) continue;
      const result = await launch(m, ["error"]);
      if (result === "started") {
        networkRetries.set(m.id, used + 1);
        console.log(`[assistente] rede falhou; nova tentativa ${used + 1}/${NETWORK_RETRIES} na reunião ${m.id}`);
      }
    }
  } catch (err) {
    console.error("[assistente] erro no ciclo:", err);
  } finally {
    ticking = false;
  }
}

/** Botão "Enviar assistente agora" numa reunião da agenda. */
export async function sendAssistantNow(meetingId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT m.id, m.url, m.created_by, m.scheduled_start, m.scheduled_end, m.source, m.status,
            EXISTS (SELECT 1 FROM meeting_audio a WHERE a.meeting_id = m.id) AS has_audio
       FROM meetings m WHERE m.id = $1`,
    [meetingId],
  );
  const m = rows[0];
  if (!m) throw new AssistantError("Reunião não encontrada.", 404);
  if (!AGENDA_SOURCES.includes(m.source)) {
    throw new AssistantError("Só reuniões da agenda recebem o assistente por aqui.", 409);
  }
  if (!["scheduled", "skipped", "missed", "error"].includes(m.status) || m.has_audio) {
    throw new AssistantError("Esta reunião não pode receber o assistente agora.", 409);
  }
  const result = await launch(m, ["scheduled", "skipped", "missed", "error"]);
  if (result === "started") return;
  if (result === "changed") throw new AssistantError("A reunião mudou de estado; atualize a página.", 409);
  throw new AssistantError(NOTES[result]!, result === "link" ? 400 : 409);
}
