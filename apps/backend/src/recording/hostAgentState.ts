import type { HeartbeatInput, HostAgentCapture, HostAgentStatus } from "@meeting-bot/contracts";
import { visibleMeetingId } from "../authz";
import { hub } from "../live/hub";
import type { User } from "../types";

// Estado do host-agent em memória (heartbeat a cada 5 s).
const ONLINE_WINDOW_MS = 15_000;

let lastSeenAt: Date | null = null;
let version: string | null = null;
let capture: HostAgentCapture | null = null;
let lastPublishedOnline = false;

export function isHostAgentOnline(now = Date.now()): boolean {
  return lastSeenAt !== null && now - lastSeenAt.getTime() < ONLINE_WINDOW_MS;
}

export function hostAgentLastSeen(): Date | null {
  return lastSeenAt;
}

export function hostAgentStatus(): HostAgentStatus {
  const online = isHostAgentOnline();
  return {
    online,
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    version,
    capture: online ? capture : null,
  };
}

/** Status para a interface: a captura só aparece para quem tem acesso à reunião capturada. */
export async function hostAgentStatusFor(user: User): Promise<HostAgentStatus> {
  const status = hostAgentStatus();
  if (!status.capture) return status;
  const visible = await visibleMeetingId(user, status.capture.meetingId);
  return { ...status, capture: visible ? status.capture : null };
}

export function hostAgentCapture(): HostAgentCapture | null {
  return isHostAgentOnline() ? capture : null;
}

function publishIfChanged(): void {
  const online = isHostAgentOnline();
  if (online === lastPublishedOnline) return;
  lastPublishedOnline = online;
  hub.publishAll({ type: "host_agent", online, lastSeenAt: lastSeenAt?.toISOString() ?? null });
}

export function recordHeartbeat(input: HeartbeatInput): void {
  lastSeenAt = new Date();
  version = input.version;
  capture = input.capture;
  publishIfChanged();
}

// Detecta quando o host-agent some (chamado pelo scheduler).
export function checkHostAgentTimeout(): void {
  publishIfChanged();
}
