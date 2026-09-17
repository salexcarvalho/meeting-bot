import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { BOT_STAGE_LABELS, BOT_STAGES, type BotProgress as Progress, type BotStage } from "@meeting-bot/contracts";

// Etapas de entrada do bot (Modo Agente), com o tempo desde o pedido.
export function BotProgress({ progress, status }: { progress: Progress | null; status: string }) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => setReceivedAt(Date.now()), [progress]);
  useEffect(() => {
    if (!progress) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [progress]);

  const stage: BotStage | null = progress?.stage ?? (status === "in_call" ? "in_call" : null);
  if (!stage) return null;
  const current = BOT_STAGES.indexOf(stage);
  const elapsed = progress ? Math.round((progress.elapsedMs + Date.now() - receivedAt) / 1000) : null;

  return (
    <section className="card bot-progress" aria-live="polite">
      <div className="row between">
        <strong>{BOT_STAGE_LABELS[stage]}</strong>
        {elapsed !== null && <span className="muted small tabular">{elapsed} s</span>}
      </div>
      <ol className="stepper">
        {BOT_STAGES.map((s, i) => (
          <li key={s} className={i < current ? "done" : i === current ? "current" : ""} aria-current={i === current ? "step" : undefined}>
            <span className="stepper-dot" aria-hidden="true">{i < current ? <Check size={12} /> : i + 1}</span>
            <span className="stepper-label">{BOT_STAGE_LABELS[s].replace("…", "")}</span>
          </li>
        ))}
      </ol>
      {progress && (
        <p className="small muted">
          Entrando como <strong>{progress.displayName}</strong>
          {stage === "waiting_admission" && " — admita o assistente na sala de espera da reunião."}
        </p>
      )}
    </section>
  );
}
