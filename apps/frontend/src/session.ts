import { createContext, useCallback, useContext } from "react";
import type { AsrOptions, LlmOptions, Permission, RoleKey } from "@meeting-bot/contracts";

export interface Session {
  user: { id: string; username: string };
  displayName: string;
  avatarVersion: string | null;
  agentName: string;
  roles: RoleKey[];
  permissions: Permission[];
  asr: AsrOptions;
  llm: LlmOptions;
}

export const SessionContext = createContext<Session | null>(null);

/** Recarrega a sessão (nome, foto, permissões) depois de mudanças no perfil. */
export const SessionRefreshContext = createContext<() => Promise<void>>(async () => {});

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession fora da sessão");
  return session;
}

export function useRefreshSession(): () => Promise<void> {
  return useContext(SessionRefreshContext);
}

// Só esconde botões: quem decide é o backend.
export function useCan(): (permission: Permission) => boolean {
  const session = useContext(SessionContext);
  return useCallback((permission: Permission) => Boolean(session?.permissions.includes(permission)), [session]);
}

export const EXTERNAL_ASR_WARNING =
  "O áudio desta reunião será enviado ao OpenRouter (fora da máquina). Use só com áudio que a política da organização permite enviar.";

export function asrLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  if (provider.startsWith("openrouter:")) return `${provider.slice("openrouter:".length)} via OpenRouter (externo)`;
  if (provider === "worker-gpu") return "Whisper local";
  return provider;
}

export const EXTERNAL_LLM_WARNING =
  "A transcrição completa desta reunião será enviada ao OpenRouter (fora da máquina) para gerar os itens, a ata e os ADRs. Use só com conteúdo que a política da organização permite enviar.";

export const EXTERNAL_ADR_WARNING =
  "Os trechos da transcrição ligados a cada decisão e o resumo da reunião serão enviados ao OpenRouter (fora da máquina).";

export function isExternal(provider: string | null | undefined): boolean {
  return Boolean(provider?.startsWith("openrouter:"));
}

/** "local:qwen3.5:4b" → "qwen3.5:4b (local)"; "openrouter:x" → "x via OpenRouter (externo)" */
export function llmLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  if (provider.startsWith("openrouter:")) return `${provider.slice("openrouter:".length)} via OpenRouter (externo)`;
  if (provider.startsWith("local:")) return `${provider.slice("local:".length)} (local)`;
  return provider;
}
