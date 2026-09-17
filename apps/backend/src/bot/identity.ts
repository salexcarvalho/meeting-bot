import type { DisplayIdentity } from "@meeting-bot/contracts";

// Nome com que o bot entra na reunião. Constituição, princípio II: sempre com o sufixo que
// o identifica como assistente gravando — não há opção para removê-lo.

const MAX_BASE = 30;

// Meet e Teams recusam (ou desabilitam o "Entrar" com) caracteres fora desta lista.
export function safeMeetingName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} \-'._@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

export function buildBotDisplayName(src: IdentitySource, suffix: string): string {
  return `${botBaseName(src)} - ${safeMeetingName(suffix)}`;
}
