import type { Channel } from "@meeting-bot/contracts";

// Estado em memória das gravações locais (data-model.md, "Estado em memória").

export type LocalChannel = Extract<Channel, "mic" | "remote">;
export const LOCAL_CHANNELS: LocalChannel[] = ["mic", "remote"];

export interface ChannelRuntime {
  connected: boolean;
  ended: boolean;
  lastAudioAt: Date | null;
  bytes: number;
  lagSeconds: number;
}

export interface MeetingRuntime {
  channels: Record<LocalChannel, ChannelRuntime>;
  lastSpeechAt: Date | null;
  stoppingSince: number | null;
  stopReason: string | null;
}

const runtimes = new Map<string, MeetingRuntime>();

const emptyChannel = (): ChannelRuntime => ({
  connected: false,
  ended: false,
  lastAudioAt: null,
  bytes: 0,
  lagSeconds: 0,
});

export function runtimeFor(meetingId: string): MeetingRuntime {
  let rt = runtimes.get(meetingId);
  if (!rt) {
    rt = {
      channels: { mic: emptyChannel(), remote: emptyChannel() },
      lastSpeechAt: null,
      stoppingSince: null,
      stopReason: null,
    };
    runtimes.set(meetingId, rt);
  }
  return rt;
}

export function peekRuntime(meetingId: string): MeetingRuntime | undefined {
  return runtimes.get(meetingId);
}

export function dropRuntime(meetingId: string): void {
  runtimes.delete(meetingId);
}

export function isLocalChannel(value: unknown): value is LocalChannel {
  return value === "mic" || value === "remote";
}
