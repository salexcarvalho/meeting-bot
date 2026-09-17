import type { LiveClientMessage, LiveServerMessage } from "@meeting-bot/contracts";

type Handler = (msg: LiveServerMessage) => void;
type Topic = { topic: "agenda" } | { topic: "meeting"; meetingId: string };

// Cliente WebSocket único com reconexão. Ao reconectar, avisa os assinantes
// (onReconnect) para recarregarem o estado via REST.
class LiveClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectHandlers = new Set<() => void>();
  private topics = new Map<string, Topic>();
  private retry = 0;
  private timer: number | null = null;
  private stopped = true;
  private everConnected = false;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  subscribe(topic: Topic): () => void {
    const key = topic.topic === "agenda" ? "agenda" : `meeting:${topic.meetingId}`;
    this.topics.set(key, topic);
    this.send({ type: "subscribe", ...topic } as LiveClientMessage);
    return () => {
      this.topics.delete(key);
      if (topic.topic === "meeting") this.send({ type: "unsubscribe", topic: "meeting", meetingId: topic.meetingId });
    };
  }

  private send(msg: LiveClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/live`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const t of this.topics.values()) this.send({ type: "subscribe", ...t } as LiveClientMessage);
      if (this.everConnected) this.reconnectHandlers.forEach((fn) => fn());
      this.everConnected = true;
    };
    ws.onmessage = (ev) => {
      let msg: LiveServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handlers.forEach((fn) => fn(msg));
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped || ev.code === 4401) return;
      const delay = [1000, 2000, 5000, 10000][Math.min(this.retry++, 3)];
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }
}

export const live = new LiveClient();
