import { useEffect, useLayoutEffect, useRef } from "react";
import type { Channel, Segment } from "@meeting-bot/contracts";
import { formatClock } from "../format";

export function Transcript({
  segments,
  onSeek,
  highlight,
  follow = false,
  full = false,
  emptyText = "Transcrição ainda não disponível.",
}: {
  segments: Segment[];
  onSeek?: (channel: Channel, seconds: number) => void;
  highlight?: Set<number>;
  follow?: boolean;
  full?: boolean;
  emptyText?: string;
}) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  // Rolagem automática só enquanto o usuário está no fim da lista.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (follow && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments, follow]);

  useEffect(() => {
    if (!highlight?.size) return;
    const first = ref.current?.querySelector("li.highlight");
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);

  if (!segments.length) {
    return <p className="muted">{emptyText}</p>;
  }
  return (
    <ol ref={ref} className={`transcript ${full ? "full" : ""}`} aria-live={follow ? "polite" : undefined}>
      {segments.map((s) => (
        <li key={s.id} id={`seg-${s.id}`} className={highlight?.has(s.id) ? "highlight" : undefined}>
          <span className="ts">
            {onSeek ? (
              <button type="button" className="link" onClick={() => onSeek(s.channel, s.start)} title="Ouvir este trecho">
                {formatClock(s.start)}
              </button>
            ) : (
              formatClock(s.start)
            )}
          </span>
          <span>
            {s.speakerName && (
              <span className={`speaker ${s.channel === "mic" ? "user" : ""}`}>{s.speakerName}</span>
            )}
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
