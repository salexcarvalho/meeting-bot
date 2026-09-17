import { createContext, useCallback, useContext } from "react";
import type { AsrOptions, LlmChoice, LlmOptions, Permission, RoleKey } from "@meeting-bot/contracts";

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

export type GenerationScope = "ata" | "adr";

const DESTINATION: Record<Exclude<LlmChoice, "local">, string> = {
  openrouter: "ao OpenRouter",
  claude: "à Anthropic pela sua assinatura pessoal do Claude",
  codex: "à OpenAI pela sua assinatura pessoal do ChatGPT/Codex",
};

/** Aviso antes de mandar conteúdo para fora da máquina (null = geração local). */
export function generationWarning(choice: LlmChoice, scope: GenerationScope): string | null {
  if (choice === "local") return null;
  const what =
    scope === "ata"
      ? "A transcrição completa desta reunião será enviada"
      : "Os trechos da transcrição ligados a cada decisão e o resumo da reunião serão enviados";
  const terms =
    choice === "openrouter"
      ? ""
      : " Plano pessoal segue os termos de consumidor: confira na sua conta se as conversas podem ser usadas para treino.";
  return `${what} ${DESTINATION[choice]} (fora da máquina).${terms} Use só com conteúdo que a política da organização permite enviar.`;
}

const PROVIDER_NAMES: Record<string, string> = { openrouter: "OpenRouter", claude: "Claude", codex: "Codex" };

/** "openrouter:x" → "OpenRouter"; null para geração local ou desconhecida. */
export function externalName(provider: string | null | undefined): string | null {
  const prefix = provider?.split(":", 1)[0] ?? "";
  return PROVIDER_NAMES[prefix] ?? null;
}

export function isExternal(provider: string | null | undefined): boolean {
  return externalName(provider) !== null;
}

/** "local:qwen3.5:4b" → "qwen3.5:4b (local)"; "claude:sonnet" → "sonnet via assinatura Claude (externo)" */
export function llmLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  const [prefix] = provider.split(":", 1);
  const model = provider.slice(prefix.length + 1);
  if (prefix === "openrouter") return `${model} via OpenRouter (externo)`;
  if (prefix === "claude" || prefix === "codex") return `${model} via assinatura ${PROVIDER_NAMES[prefix]} (externo)`;
  if (prefix === "local") return `${model} (local)`;
  return provider;
}
