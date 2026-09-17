import type { BotProgress, BotStage } from "@meeting-bot/contracts";

// Bots do Modo Agente em execução neste processo (separado do runner para evitar ciclos de import).

export interface ActiveBot {
  abort: AbortController;
  done: Promise<void>;
  urlKey: string;
  displayName: string;
  requestedAt: number;
  stage: BotStage;
  stageAt: number;
}

export const activeBots = new Map<string, ActiveBot>();

// Links com pedido em andamento (entre a validação e o registro do bot), contra clique duplo.
const pendingUrls = new Set<string>();

type ProgressListener = (meetingId: string, progress: BotProgress | null) => void;
let listener: ProgressListener = () => {};

export function onBotProgress(fn: ProgressListener): void {
  listener = fn;
}

export function activeBotCount(): number {
  return activeBots.size + pendingUrls.size;
}

export function isBotActive(meetingId: string): boolean {
  return activeBots.has(meetingId);
}

export function botProgress(meetingId: string): BotProgress | null {
  const bot = activeBots.get(meetingId);
  if (!bot || bot.stage === "in_call") return null;
  return { stage: bot.stage, elapsedMs: Date.now() - bot.requestedAt, displayName: bot.displayName };
}

/**
 * Chave do link sem query/fragmento: o mesmo Meet/Teams colado duas vezes vira a mesma chave.
 * (No Teams, o id da reunião fica no caminho; a query só traz contexto do tenant.)
 */
export function botUrlKey(url: string): string {
  const u = new URL(url);
  let pathname = u.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // mantém codificado
  }
  return `${u.hostname}${pathname.replace(/\/+$/, "")}`.toLowerCase();
}

export function botForUrl(urlKey: string): string | null {
  for (const [meetingId, bot] of activeBots) if (bot.urlKey === urlKey) return meetingId;
  return null;
}

/** Reserva o link; falso se já existe bot ou pedido em andamento para ele. */
export function reserveBotUrl(urlKey: string): boolean {
  if (pendingUrls.has(urlKey) || botForUrl(urlKey)) return false;
  pendingUrls.add(urlKey);
  return true;
}

export function releaseBotUrl(urlKey: string): void {
  pendingUrls.delete(urlKey);
}

export function removeBot(meetingId: string): void {
  if (activeBots.delete(meetingId)) listener(meetingId, null);
}

export function setBotStage(meetingId: string, stage: BotStage): void {
  const bot = activeBots.get(meetingId);
  if (!bot || bot.stage === stage) return;
  const now = Date.now();
  console.log(
    `[bot ${meetingId}] etapa=${stage} total_ms=${now - bot.requestedAt} etapa_anterior=${bot.stage} ms=${now - bot.stageAt}`,
  );
  bot.stage = stage;
  bot.stageAt = now;
  listener(meetingId, stage === "in_call" ? null : botProgress(meetingId));
}
