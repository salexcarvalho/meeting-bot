import type {
  Adr,
  CaptureState,
  GpuStats,
  Item,
  MeetingSummary,
  Segment,
  TranscriptPass,
} from "./domain";
import type { BotProgress } from "./platform";

// WebSocket UI ← backend (contracts/ws-live.md)

export type LiveClientMessage =
  | { type: "subscribe"; topic: "agenda" }
  | { type: "subscribe"; topic: "meeting"; meetingId: string }
  | { type: "unsubscribe"; topic: "meeting"; meetingId: string }
  | { type: "ping" };

export type ProcessingStep = "convertendo" | "transcrevendo" | "diarizando" | "analisando" | "ata" | "adrs";

export interface ChannelLiveState {
  state: CaptureState | "waiting";
  lastAudioAt: string | null;
}

export interface RecordingEvent {
  type: "recording";
  meetingId: string;
  elapsedSeconds: number;
  lastSpeechAt: string | null;
  lagSeconds: number;
  channels: { mic: ChannelLiveState; remote: ChannelLiveState };
  stopReason?: string;
}

export type LiveServerMessage =
  | { type: "meeting"; meeting: MeetingSummary }
  | { type: "segments"; meetingId: string; pass: TranscriptPass; segments: Segment[] }
  | { type: "transcript_replaced"; meetingId: string }
  | { type: "items"; meetingId: string; items: Item[] }
  | { type: "items_removed"; meetingId: string; ids: string[] }
  | { type: "adrs"; meetingId: string; adrs: Adr[] }
  | { type: "summary"; meetingId: string; text: string; at: string }
  | RecordingEvent
  | { type: "processing"; meetingId: string; step: ProcessingStep | null; progress?: number; error?: string; done?: string }
  | ({ type: "gpu" } & GpuStats)
  | { type: "host_agent"; online: boolean; lastSeenAt: string | null }
  | { type: "bot"; meetingId: string; progress: BotProgress | null }
  | { type: "pong" };

// WebSocket host-agent → backend (contracts/ws-audio.md)

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;
export const AUDIO_MAX_FRAME_BYTES = 64 * 1024;

export type AudioServerMessage =
  | { type: "ready"; offset: number; format: "s16le"; rate: 16000; channels: 1 }
  | { type: "ack"; offset: number }
  | { type: "ended"; offset: number }
  | { type: "error"; message: string; offset: number };

export type AudioClientMessage = { type: "end"; total: number };

export const AUDIO_CLOSE = {
  replaced: 4001,
  invalid: 4400,
  unauthorized: 4401,
  notFound: 4404,
  notRecording: 4409,
} as const;
