import { forwardRef, useImperativeHandle, useRef } from "react";
import type { AudioChannelInfo, Channel } from "@meeting-bot/contracts";
import { formatClock } from "../format";

const LABEL: Record<Channel, string> = { mic: "Microfone", remote: "Áudio da reunião", mixed: "Áudio" };

export interface AudioPlayersHandle {
  seek: (channel: Channel, seconds: number) => void;
}

export const AudioPlayers = forwardRef<AudioPlayersHandle, { meetingId: string; audio: AudioChannelInfo[]; version: string }>(
  function AudioPlayers({ meetingId, audio, version }, ref) {
    const players = useRef(new Map<Channel, HTMLAudioElement>());
    const ready = audio.filter((a) => a.format !== "pcm_s16le_16k");

    useImperativeHandle(ref, () => ({
      seek(channel, seconds) {
        const el = players.current.get(channel) ?? players.current.values().next().value;
        if (!el) return;
        el.currentTime = Math.max(0, seconds - 0.5);
        void el.play().catch(() => {});
      },
    }));

    if (!audio.length) return <p className="muted">Sem áudio gravado.</p>;
    if (!ready.length) return <p className="muted">O áudio fica disponível quando a gravação terminar.</p>;
    return (
      <div className="grid-2">
        {ready.map((a) => (
          <div key={a.channel}>
            <div className="small muted">
              {LABEL[a.channel]}
              {a.durationSeconds ? ` · ${formatClock(a.durationSeconds)}` : ""}
            </div>
            <audio
              ref={(el) => {
                if (el) players.current.set(a.channel, el);
                else players.current.delete(a.channel);
              }}
              controls
              preload="metadata"
              style={{ width: "100%" }}
              src={`/api/meetings/${meetingId}/audio?channel=${a.channel}&v=${encodeURIComponent(version)}`}
            />
          </div>
        ))}
      </div>
    );
  },
);
