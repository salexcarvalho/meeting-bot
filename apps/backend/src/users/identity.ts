import type { IdentityChoice, UserProfile, UserSettings, AgentProfile } from "@meeting-bot/contracts";
import { buildBotDisplayName, type BotIdentity } from "../bot/identity";
import { config } from "../config";
import { profileFilePath } from "./files";
import { getAgent, getAgentFile, getProfile, getSettings } from "./repo";

export function botDisplayNameFor(
  profile: Pick<UserProfile, "name">,
  agent: Pick<AgentProfile, "name">,
  settings: UserSettings,
  choice?: IdentityChoice,
): string {
  const mode = choice?.mode ?? settings.meetings.displayIdentity;
  const customName = choice?.mode === "custom" ? (choice.customName ?? null) : settings.meetings.customDisplayName;
  return buildBotDisplayName({ mode, userName: profile.name, agentName: agent.name, customName });
}

/** Nome e ícone do bot para um usuário, com a escolha da reunião (se houver) sobre a configuração dele. */
export async function resolveBotIdentity(userId: string, choice?: IdentityChoice): Promise<BotIdentity> {
  const [profile, agent, settings, avatar] = await Promise.all([
    getProfile(userId),
    getAgent(userId),
    getSettings(userId),
    getAgentFile(userId, "avatar"),
  ]);
  if (!profile) return { name: config.botDisplayName, avatarPath: null };
  return {
    name: botDisplayNameFor(profile, agent, settings, choice),
    avatarPath: avatar ? profileFilePath(userId, avatar) : null,
  };
}
