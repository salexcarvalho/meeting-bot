import type { ProbeConfig } from "./probe";
import { meetProbe } from "./meet";
import { teamsProbe } from "./teams";

export type SpeakerPlatform = "meet" | "teams";
export type SpeakerProfile = "guest" | "account";

/** Configuração do leitor de cada plataforma; plataforma sem leitor devolve null (nada é instalado). */
export function probeFor(platform: string, profile: SpeakerProfile): ProbeConfig | null {
  if (platform === "meet") return meetProbe();
  if (platform === "teams") return teamsProbe(profile);
  return null;
}
