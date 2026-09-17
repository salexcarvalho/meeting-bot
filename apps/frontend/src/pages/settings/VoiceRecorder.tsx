import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Upload } from "lucide-react";
import { useToast } from "../../components/Toast";

const MAX_SECONDS = 60;
const AUDIO_TYPES = "audio/webm,audio/ogg,audio/wav,audio/x-wav,audio/mp4,audio/mpeg";

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
}

// Grava a voz/nome do agente no navegador (MediaRecorder) ou recebe um arquivo pronto.
export function VoiceRecorder({
  src,
  duration,
  busy,
  onSave,
  onRemove,
}: {
  src: string | null;
  duration: number | null;
  busy: boolean;
  onSave: (blob: Blob, filename: string) => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(pickMime());

  const stopTimer = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(
    () => () => {
      stopTimer();
      if (recorder.current?.state === "recording") recorder.current.stop();
    },
    [],
  );

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("Sem acesso ao microfone. Libere a permissão no navegador.", "error");
      return;
    }
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopTimer();
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size === 0) return toast("A gravação ficou vazia.", "error");
      onSave(blob, rec.mimeType.includes("ogg") ? "voz.ogg" : "voz.webm");
    };
    recorder.current = rec;
    rec.start(250);
    setSeconds(0);
    setRecording(true);
    const startedAt = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && rec.state === "recording") rec.stop();
    }, 250);
  }

  return (
    <div className="voice-recorder">
      {src ? (
        <div className="stack" style={{ gap: 6 }}>
          <audio controls preload="none" src={src} aria-label="Gravação atual do agente" />
          {duration !== null && <span className="field-hint">{duration.toLocaleString("pt-BR")} s</span>}
        </div>
      ) : (
        <p className="muted small">Nenhuma gravação ainda.</p>
      )}
      <div className="row">
        {supported &&
          (recording ? (
            <button type="button" className="danger solid small" onClick={() => recorder.current?.stop()}>
              <Square aria-hidden="true" /> Parar ({seconds}s / {MAX_SECONDS}s)
            </button>
          ) : (
            <button type="button" className="small" disabled={busy} onClick={() => void start()}>
              <Mic aria-hidden="true" /> {src ? "Regravar" : "Gravar"}
            </button>
          ))}
        <button type="button" className="small" disabled={busy || recording} onClick={() => fileInput.current?.click()}>
          <Upload aria-hidden="true" /> Enviar arquivo
        </button>
        {src && (
          <button type="button" className="small danger" disabled={busy || recording} onClick={onRemove}>
            <Trash2 aria-hidden="true" /> Remover
          </button>
        )}
      </div>
      {recording && (
        <div className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (seconds / MAX_SECONDS) * 100)}%` }} />
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={AUDIO_TYPES}
        aria-label="Arquivo de áudio do agente"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.size > 4 * 1024 * 1024) return toast("O arquivo passa de 4 MB.", "error");
          onSave(file, file.name);
        }}
      />
    </div>
  );
}
