import { mkdir, open, type FileHandle } from "fs/promises";
import type { IncomingMessage } from "http";
import path from "path";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AUDIO_CLOSE, AUDIO_MAX_FRAME_BYTES, type AudioServerMessage } from "@meeting-bot/contracts";
import { authorizeAgentUpgrade } from "../agent/agentAuth";
import { config } from "../config";
import { getMeeting, setAudioBytes, upsertAudio } from "../db";
import { liveSession } from "./liveSession";
import { isLocalChannel, runtimeFor, type LocalChannel } from "./runtime";

// WebSocket de áudio host-agent → backend (contracts/ws-audio.md).

export const PCM_FORMAT = "pcm_s16le_16k";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_INTERVAL_MS = 1_000;
const BYTES_DB_INTERVAL_MS = 15_000;

export const recordingDir = (meetingId: string) => path.join(config.dataDir, "audio", meetingId);
export const pcmPath = (meetingId: string, channel: LocalChannel) =>
  path.join(recordingDir(meetingId), `${channel}.pcm`);

const wss = new WebSocketServer({ noServer: true, maxPayload: AUDIO_MAX_FRAME_BYTES });

interface Connection {
  ws: WebSocket;
  closed: Promise<void>;
}
const connections = new Map<string, Connection>();
// Reuniões cuja gravação já foi fechada: recusam novas conexões durante a conversão.
const refused = new Map<string, number>();
const REFUSE_MS = 10 * 60_000;

export function allowIngest(meetingId: string): void {
  refused.delete(meetingId);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const send = (ws: WebSocket, msg: AudioServerMessage) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

export async function handleAudioUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  socket.on("error", () => socket.destroy());
  if (!authorizeAgentUpgrade(req)) return reject(socket, 401, "Unauthorized");
  const url = new URL(req.url ?? "/", "http://localhost");
  const meetingId = url.searchParams.get("meeting") ?? "";
  const channel = url.searchParams.get("channel");
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!UUID_RE.test(meetingId) || !isLocalChannel(channel)) {
      ws.close(AUDIO_CLOSE.invalid, "parâmetros inválidos");
      return;
    }
    void accept(ws, meetingId, channel).catch((err) => {
      console.error(`[audio ${meetingId}/${channel}] erro:`, err);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "erro interno");
    });
  });
}

// Fecha as conexões de uma reunião (antes de converter o áudio) e espera terminarem.
export async function closeIngest(meetingId: string, code: number = AUDIO_CLOSE.notRecording): Promise<void> {
  refused.set(meetingId, Date.now());
  for (const [id, at] of refused) if (Date.now() - at > REFUSE_MS) refused.delete(id);
  const waits: Promise<void>[] = [];
  for (const [key, conn] of connections) {
    if (!key.startsWith(`${meetingId}:`)) continue;
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code, "gravação encerrada");
    waits.push(conn.closed);
  }
  await Promise.all(waits);
}

export async function closeAllIngest(): Promise<void> {
  const waits = [...connections.values()].map((c) => {
    c.ws.close(1001, "servidor reiniciando");
    return c.closed;
  });
  await Promise.all(waits);
  wss.close();
}

async function accept(ws: WebSocket, meetingId: string, channel: LocalChannel): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return ws.close(AUDIO_CLOSE.notFound, "reunião inexistente");
  if (refused.has(meetingId) || !["ics", "manual"].includes(meeting.source) || !["recording", "stopping"].includes(meeting.status)) {
    return ws.close(AUDIO_CLOSE.notRecording, "reunião não está gravando");
  }

  // Uma conexão por canal: a nova substitui a anterior.
  const key = `${meetingId}:${channel}`;
  const previous = connections.get(key);
  let release!: () => void;
  const closed = new Promise<void>((resolve) => (release = resolve));
  connections.set(key, { ws, closed });
  if (previous) {
    previous.ws.close(AUDIO_CLOSE.replaced, "substituída");
    await previous.closed;
  }
  if (ws.readyState !== WebSocket.OPEN) {
    if (connections.get(key)?.ws === ws) connections.delete(key);
    release();
    return;
  }

  const file = pcmPath(meetingId, channel);
  await mkdir(path.dirname(file), { recursive: true });
  let fh: FileHandle;
  try {
    fh = await open(file, "a");
  } catch (err) {
    if (connections.get(key)?.ws === ws) connections.delete(key);
    release();
    throw err;
  }
  let written = (await fh.stat()).size;
  if (written % 2) {
    written -= 1;
    await fh.truncate(written);
  }
  await upsertAudio(meetingId, channel, { path: file, format: PCM_FORMAT, bytes: written });

  const rt = runtimeFor(meetingId).channels[channel];
  rt.connected = true;
  rt.ended = false;
  rt.bytes = written;
  const live = liveSession(meetingId, channel);
  live.resume(written);

  let synced = written;
  let dirty = false;
  let queue: Promise<void> = Promise.resolve();
  let failed = false;
  let lastDbWrite = Date.now();

  const sync = async () => {
    if (!dirty) return;
    dirty = false;
    await fh.sync();
    synced = written;
    send(ws, { type: "ack", offset: synced });
    if (Date.now() - lastDbWrite > BYTES_DB_INTERVAL_MS) {
      lastDbWrite = Date.now();
      await setAudioBytes(meetingId, channel, synced);
    }
  };
  const timer = setInterval(() => {
    queue = queue.then(sync).catch(fail);
  }, ACK_INTERVAL_MS);

  function fail(err: unknown): void {
    if (failed) return;
    failed = true;
    console.error(`[audio ${meetingId}/${channel}] falha de escrita:`, err);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, "falha de escrita");
  }

  const onData = async (data: Buffer) => {
    if (failed) return;
    if (data.length % 2) {
      ws.close(AUDIO_CLOSE.invalid, "frame ímpar");
      return;
    }
    await fh.write(data);
    written += data.length;
    dirty = true;
    rt.bytes = written;
    rt.lastAudioAt = new Date();
    live.push(data);
  };

  const onEnd = async (total: number) => {
    if (failed) return;
    if (total !== written) {
      await sync();
      send(ws, { type: "error", message: "incompleto", offset: synced });
      return;
    }
    dirty = true;
    await sync();
    live.finish();
    rt.ended = true;
    send(ws, { type: "ended", offset: written });
    ws.close(1000, "fim");
  };

  ws.on("message", (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
      queue = queue.then(() => onData(data)).catch(fail);
      return;
    }
    let msg: { type?: string; total?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(AUDIO_CLOSE.invalid, "mensagem inválida");
      return;
    }
    if (msg.type === "end" && Number.isSafeInteger(msg.total)) {
      const total = msg.total as number;
      queue = queue.then(() => onEnd(total)).catch(fail);
    } else {
      ws.close(AUDIO_CLOSE.invalid, "mensagem inválida");
    }
  });
  ws.on("error", () => ws.terminate());
  ws.on("close", () => {
    clearInterval(timer);
    queue = queue
      .then(async () => {
        if (dirty) await fh.sync().catch(() => {});
        await fh.close().catch(() => {});
        await setAudioBytes(meetingId, channel, written).catch(() => {});
      })
      .finally(() => {
        if (connections.get(key)?.ws === ws) {
          connections.delete(key);
          rt.connected = false;
        }
        release();
      });
  });

  send(ws, { type: "ready", offset: written, format: "s16le", rate: 16000, channels: 1 });
}
