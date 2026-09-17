// Links aceitos pelo assistente convidado (Modo Agente).
export function detectPlatform(raw: unknown): { platform: "meet" | "teams"; url: string } | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "meet.google.com") return { platform: "meet", url: url.toString() };
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) {
    return { platform: "teams", url: url.toString() };
  }
  return null;
}
