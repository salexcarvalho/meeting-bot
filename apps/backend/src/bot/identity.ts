import type { DisplayIdentity } from "@meeting-bot/contracts";

// Nome com que o bot entra na reunião. Constituição, princípio II: o próprio nome diz que é o
// gravador da ata (ex.: "Ata do Sérgio"), sem sufixo. Nome que não diz isso ganha "Ata de" na
// frente, para ninguém achar que é uma pessoa ouvindo ao vivo.

const MAX_BASE = 30;
const RECORDER_PREFIX = "Ata de";

// Meet e Teams recusam (ou desabilitam o "Entrar" com) caracteres fora desta lista.
export function safeMeetingName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} \-'._@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** O nome já avisa que é gravação/ata? */
export function identifiesRecorder(name: string): boolean {
  return /(^|[\s\-'._@])atas?($|[\s\-'._@])|grava|record|transcri/iu.test(name);
}

/** Garante que o nome identifica o gravador, sem mexer no que já identifica. */
export function recorderName(name: string): string {
  const safe = safeMeetingName(name);
  return identifiesRecorder(safe) ? safe : `${RECORDER_PREFIX} ${safe || "Assistente"}`;
}

export interface IdentitySource {
  mode: DisplayIdentity;
  userName: string;
  agentName: string;
  customName: string | null;
}

export function botBaseName(src: IdentitySource): string {
  const raw = src.mode === "user" ? src.userName : src.mode === "custom" ? (src.customName ?? "") : src.agentName;
  const base = safeMeetingName(raw).slice(0, MAX_BASE).trim();
  if (base) return base;
  return safeMeetingName(src.agentName).slice(0, MAX_BASE).trim() || "Assistente";
}

export interface BotIdentity {
  /** nome na reunião, já identificando o gravador */
  name: string;
  /** ícone do agente para a câmera virtual (null = câmera desligada) */
  avatarPath: string | null;
}

export function buildBotDisplayName(src: IdentitySource): string {
  return recorderName(botBaseName(src));
}
