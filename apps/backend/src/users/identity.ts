import type { IdentityChoice, UserProfile, UserSettings, AgentProfile } from "@meeting-bot/contracts";
import { buildBotDisplayName } from "../bot/identity";
import { config } from "../config";
import { getAgent, getProfile, getSettings } from "./repo";

export function botDisplayNameFor(
  profile: Pick<UserProfile, "name">,
  agent: Pick<AgentProfile, "name">,
  settings: UserSettings,
  choice?: IdentityChoice,
): string {
  const mode = choice?.mode ?? settings.meetings.displayIdentity;
  const customName = choice?.mode === "custom" ? (choice.customName ?? null) : settings.meetings.customDisplayName;
  return buildBotDisplayName(
    { mode, userName: profile.name, agentName: agent.name, customName },
    config.botIdentitySuffix,
  );
}

/** Nome do bot para um usuário, com a escolha da reunião (se houver) sobre a configuração dele. */
export async function resolveBotDisplayName(userId: string, choice?: IdentityChoice): Promise<string> {
  const [profile, agent, settings] = await Promise.all([getProfile(userId), getAgent(userId), getSettings(userId)]);
  if (!profile) return config.botDisplayName;
  return botDisplayNameFor(profile, agent, settings, choice);
}
