import type { IdentityChoice, MeetingSummary } from "@meeting-bot/contracts";
import { api, ApiError } from "./api";

// Pedidos de bot em andamento nesta aba, por link: clique duplo não gera dois pedidos.
const inFlight = new Map<string, Promise<SendBotResult>>();

export type SendBotResult =
  | { kind: "created"; meeting: MeetingSummary }
  | { kind: "duplicate"; meetingId: string | null; message: string };

function key(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return url.trim();
  }
}

export function sendBot(input: { url: string; title?: string; identity?: IdentityChoice }): Promise<SendBotResult> {
  const k = key(input.url);
  const pending = inFlight.get(k);
  if (pending) return pending;
  const started = performance.now();
  const request = api<MeetingSummary>("/meetings", { method: "POST", json: input })
    .then((meeting): SendBotResult => {
      console.debug(`[bot] pedido aceito em ${Math.round(performance.now() - started)} ms`);
      return { kind: "created", meeting };
    })
    .catch((err): SendBotResult => {
      if (err instanceof ApiError && err.status === 409) {
        const meetingId = typeof err.body.meetingId === "string" ? err.body.meetingId : null;
        return { kind: "duplicate", meetingId, message: err.message };
      }
      throw err;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, request);
  return request;
}
