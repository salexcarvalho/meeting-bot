import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import type { LiveClientMessage, LiveServerMessage } from "@meeting-bot/contracts";
import { hashToken, SESSION_COOKIE } from "../auth";
import { meetingAccess, meetingAudience } from "../authz";
import { findSessionUser } from "../db";
import type { User } from "../types";

// WebSocket UI ← backend (contracts/ws-live.md).

interface ClientState {
  userId: string;
  user: User;
  tokenHash: string;
  agenda: boolean;
  meetings: Set<string>;
  alive: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // cookie malformado: ignora
    }
  }
  return out;
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

class LiveHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Map<WebSocket, ClientState>();
  private timer: NodeJS.Timeout | null = null;

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    if (!sameOrigin(req)) return reject(socket, 403, "Forbidden");
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return reject(socket, 401, "Unauthorized");
    const tokenHash = hashToken(token);
    const user = await findSessionUser(tokenHash).catch(() => null);
    if (!user) return reject(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user, tokenHash));
  }

  start(): void {
    this.timer ??= setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.clients.keys()) ws.close(1001);
    this.wss.close();
  }

  get size(): number {
    return this.clients.size;
  }

  hasMeetingSubscribers(meetingId: string): boolean {
    for (const c of this.clients.values()) if (c.meetings.has(meetingId)) return true;
    return false;
  }

  publishAgenda(msg: LiveServerMessage): void {
    this.broadcast(msg, (c) => c.agenda);
  }

  publishToMeeting(meetingId: string, msg: LiveServerMessage): void {
    this.broadcast(msg, (c) => c.meetings.has(meetingId));
  }

  // Quem acompanha a reunião já teve o acesso checado no subscribe e recebe na hora (mantém a ordem);
  // a agenda só vai para quem é dono ou recebeu compartilhamento.
  publishBoth(meetingId: string, msg: LiveServerMessage): void {
    this.broadcast(msg, (c) => c.meetings.has(meetingId));
    if (![...this.clients.values()].some((c) => c.agenda && !c.meetings.has(meetingId))) return;
    void this.audienceOf(meetingId)
      .then((audience) =>
        this.broadcast(
          msg,
          (c) =>
            c.agenda &&
            !c.meetings.has(meetingId) &&
            (audience.has(c.userId) || c.user.permissions.includes("meetings.read_all")),
        ),
      )
      .catch((err) => console.error(`[live] falha ao resolver audiência de ${meetingId}:`, err));
  }

  invalidateAudience(meetingId: string): void {
    this.audiences.delete(meetingId);
  }

  private readonly audiences = new Map<string, { at: number; users: Promise<Set<string>> }>();

  private audienceOf(meetingId: string): Promise<Set<string>> {
    const cached = this.audiences.get(meetingId);
    if (cached && Date.now() - cached.at < 5_000) return cached.users;
    const users = meetingAudience(meetingId);
    this.audiences.set(meetingId, { at: Date.now(), users });
    users.catch(() => this.audiences.delete(meetingId));
    if (this.audiences.size > 200) this.audiences.delete(this.audiences.keys().next().value!);
    return users;
  }

  publishAll(msg: LiveServerMessage): void {
    this.broadcast(msg, () => true);
  }

  private broadcast(msg: LiveServerMessage, filter: (c: ClientState) => boolean): void {
    let data: string | null = null;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || !filter(state)) continue;
      data ??= JSON.stringify(msg);
      ws.send(data);
    }
  }

  private onConnection(ws: WebSocket, user: User, tokenHash: string): void {
    const state: ClientState = { userId: user.id, user, tokenHash, agenda: false, meetings: new Set(), alive: true };
    this.clients.set(ws, state);
    ws.on("pong", () => (state.alive = true));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => ws.terminate());
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003);
      let msg: LiveClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "subscribe" && msg.topic === "agenda") {
        state.agenda = true;
      } else if (msg.type === "subscribe" && msg.topic === "meeting" && UUID_RE.test(msg.meetingId)) {
        const meetingId = msg.meetingId;
        if (state.meetings.size >= 20) return;
        void meetingAccess(state.user, meetingId)
          .then((access) => {
            if (access && ws.readyState === WebSocket.OPEN && state.meetings.size < 20) state.meetings.add(meetingId);
          })
          .catch((err) => console.error(`[live] falha ao checar acesso à reunião ${meetingId}:`, err));
      } else if (msg.type === "unsubscribe" && msg.topic === "meeting") {
        state.meetings.delete(msg.meetingId);
      }
    });
  }

  // Ping para detectar conexões mortas e revalida a sessão (logout/expiração).
  private async sweep(): Promise<void> {
    for (const [ws, state] of this.clients) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
      const user = await findSessionUser(state.tokenHash).catch(() => undefined);
      if (user === null) {
        ws.close(4401, "sessão expirada");
        continue;
      }
      if (!user) continue;
      state.user = user;
      // Compartilhamento revogado: para de receber a reunião.
      for (const meetingId of state.meetings) {
        const access = await meetingAccess(user, meetingId).catch(() => undefined);
        if (access === null) state.meetings.delete(meetingId);
      }
    }
  }
}

export const hub = new LiveHub();
