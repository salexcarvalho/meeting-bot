import type { GpuStats, MeetingSummary, ProcessingStep, RecordingEvent } from "@meeting-bot/contracts";
import { formatClock, formatTime } from "../format";
import { useNow } from "../hooks";

const STEP_LABEL: Record<ProcessingStep, string> = {
  convertendo: "Salvando o áudio",
  transcrevendo: "Transcrição final",
  diarizando: "Identificando falantes",
  analisando: "Analisando a reunião",
  ata: "Gerando a ata",
  adrs: "Sugerindo ADRs",
};

const CHANNEL_STATE: Record<string, { text: string; tone: string }> = {
  recording: { text: "gravando", tone: "ok" },
  restarting: { text: "reconectando", tone: "warn" },
  unavailable: { text: "indisponível", tone: "error" },
  waiting: { text: "aguardando", tone: "" },
};

export interface ProcessingState {
  step: ProcessingStep | null;
  progress?: number;
}

function ChannelStat({ label, state, lastAudioAt, now }: { label: string; state: string; lastAudioAt: string | null; now: number }) {
  const info = CHANNEL_STATE[state] ?? CHANNEL_STATE.waiting;
  const silentFor = lastAudioAt ? Math.round((now - new Date(lastAudioAt).getTime()) / 1000) : null;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        <span className={`badge ${info.tone}`}>{info.text}</span>
      </div>
      {silentFor !== null && silentFor > 10 && <div className="small muted">sem dados há {silentFor}s</div>}
    </div>
  );
}

export function LivePanel({
  meeting,
  recording,
  processing,
  gpu,
}: {
  meeting: MeetingSummary;
  recording: RecordingEvent | null;
  processing: ProcessingState | null;
  gpu: GpuStats | null;
}) {
  const now = useNow(1000);
  const live = meeting.status === "recording" || meeting.status === "stopping";
  const started = meeting.startedAt ? new Date(meeting.startedAt).getTime() : null;
  const elapsed = live && started ? Math.max(0, Math.round((now - started) / 1000)) : (recording?.elapsedSeconds ?? 0);
  const lastSpeech = recording?.lastSpeechAt ? Math.round((now - new Date(recording.lastSpeechAt).getTime()) / 1000) : null;
  const gpuPct = gpu ? Math.round((gpu.memoryUsedMb / Math.max(gpu.memoryTotalMb, 1)) * 100) : 0;

  return (
    <section className="card">
      <div className="stats">
        {live && (
          <div className="stat">
            <div className="stat-label">Tempo</div>
            <div className="stat-value" style={{ fontSize: "1.4rem" }}>{formatClock(meeting.status === "stopping" ? (recording?.elapsedSeconds ?? elapsed) : elapsed)}</div>
            {meeting.scheduledEnd && <div className="small muted">fim previsto {formatTime(meeting.scheduledEnd)}</div>}
          </div>
        )}
        {live && (
          <>
            <ChannelStat label="Microfone" state={recording?.channels.mic.state ?? "waiting"} lastAudioAt={recording?.channels.mic.lastAudioAt ?? null} now={now} />
            <ChannelStat label="Áudio da reunião" state={recording?.channels.remote.state ?? "waiting"} lastAudioAt={recording?.channels.remote.lastAudioAt ?? null} now={now} />
            <div className="stat">
              <div className="stat-label">Atraso</div>
              <div className="stat-value">{recording ? `${Math.round(recording.lagSeconds)} s` : "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Última fala</div>
              <div className="stat-value">{lastSpeech === null ? "—" : lastSpeech < 5 ? "agora" : `há ${formatClock(lastSpeech)}`}</div>
            </div>
          </>
        )}
        {processing?.step && (
          <div className="stat" style={{ minWidth: 200 }}>
            <div className="stat-label">Processamento</div>
            <div className="stat-value">{STEP_LABEL[processing.step]}</div>
            {processing.progress !== undefined && (
              <div className="meter" role="progressbar" aria-valuenow={Math.round(processing.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(processing.progress * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {gpu && (
          <div className="stat" style={{ minWidth: 160 }}>
            <div className="stat-label">GPU</div>
            <div className="stat-value">
              {gpu.utilization}% · {(gpu.memoryUsedMb / 1024).toFixed(1)}/{(gpu.memoryTotalMb / 1024).toFixed(1)} GB
            </div>
            <div className="meter"><span style={{ width: `${gpuPct}%` }} /></div>
          </div>
        )}
      </div>
      {recording?.stopReason && <p className="small muted" style={{ marginTop: 8 }}>{recording.stopReason}. Enviando o restante do áudio…</p>}
    </section>
  );
}
