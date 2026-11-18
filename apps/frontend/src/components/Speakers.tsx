import { useState, type FormEvent } from "react";
import type { ApplyCallNamesResult, Speaker, SpeakerTimelineInfo } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { useToast } from "./Toast";

const HIGH_CONFIDENCE = 0.75;
const HELP_TEXT = "Os nomes vêm da tela da chamada (só com o assistente na reunião) e ficam só nesta máquina.";

/** Aviso curto quando a leitura da tela da chamada não rendeu nomes; null quando não há o que avisar. */
export function timelineNotice(timeline: SpeakerTimelineInfo | null | undefined): string | null {
  if (!timeline) return null;
  if (timeline.status === "unavailable") {
    return "Os nomes da chamada não estavam disponíveis nesta reunião; os falantes continuam como Speaker N.";
  }
  if (timeline.status !== "partial") return null;
  if (timeline.reason === "low_correlation") return "Os nomes da chamada não bateram com o áudio e não foram aplicados.";
  return "A leitura de quem fala na tela falhou parcialmente; os nomes da chamada não foram usados.";
}

function SourceBadge({ speaker }: { speaker: Speaker }) {
  if (speaker.nameSource === "manual") return <span className="badge">manual</span>;
  if (speaker.nameSource !== "call") return null;
  const high = (speaker.nameConfidence ?? 0) >= HIGH_CONFIDENCE;
  return (
    <>
      <span className="badge info">da chamada</span>{" "}
      <span className={high ? "badge ok" : "badge warn"} title={high ? undefined : "Confira se o nome está certo"}>
        {high ? "alta" : "conferir"}
      </span>
    </>
  );
}

function SpeakerRow({
  speaker,
  readOnly,
  onEdit,
  onRevert,
}: {
  speaker: Speaker;
  readOnly: boolean;
  onEdit: () => void;
  onRevert: () => void;
}) {
  const canRevert = speaker.nameSource !== null && !speaker.isUser;
  return (
    <div className="row between">
      <span>
        <strong>{speaker.displayName}</strong>
        {speaker.displayName !== speaker.label && (
          <span className="muted small"> ({speaker.isUser ? "microfone" : speaker.label})</span>
        )}{" "}
        <SourceBadge speaker={speaker} />
      </span>
      {!readOnly && (
        <span className="row">
          {canRevert && (
            <button type="button" className="small" onClick={onRevert}>Voltar a {speaker.label}</button>
          )}
          <button type="button" className="small" onClick={onEdit}>Renomear</button>
        </span>
      )}
    </div>
  );
}

export function Speakers({
  meetingId,
  speakers,
  onRenamed,
  readOnly = false,
  timeline = null,
}: {
  meetingId: string;
  speakers: Speaker[];
  onRenamed: () => void;
  readOnly?: boolean;
  timeline?: SpeakerTimelineInfo | null;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rename(label: string, displayName: string, okMessage: string) {
    try {
      await api(`/meetings/${meetingId}/speakers/${encodeURIComponent(label)}`, { method: "PATCH", json: { displayName } });
      setEditing(null);
      toast(okMessage);
      onRenamed();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  function save(label: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const displayName = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    void rename(label, displayName, "Falante renomeado.");
  }

  async function reapply() {
    setBusy(true);
    try {
      const res = await api<ApplyCallNamesResult>(`/meetings/${meetingId}/speakers/apply-call-names`, { method: "POST" });
      toast(res.applied > 0 ? `${res.applied} ${res.applied === 1 ? "nome aplicado" : "nomes aplicados"}` : "Nenhum nome novo");
      onRenamed();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!speakers.length) return <p className="muted small">Os falantes aparecem depois da transcrição final.</p>;
  const notice = timelineNotice(timeline);
  const canReapply = !readOnly && (timeline?.status === "ok" || timeline?.status === "partial");
  return (
    <>
      {notice && <p className="banner warn small">{notice}</p>}
      <ul className="history">
        {speakers.map((s) => (
          <li key={s.label}>
            {editing === s.label ? (
              <form className="row" onSubmit={(e) => save(s.label, e)}>
                <input name="name" defaultValue={s.displayName} required maxLength={80} autoFocus aria-label={`Nome de ${s.label}`} />
                <button className="small primary">Salvar</button>
                <button type="button" className="small" onClick={() => setEditing(null)}>Cancelar</button>
              </form>
            ) : (
              <SpeakerRow
                speaker={s}
                readOnly={readOnly}
                onEdit={() => setEditing(s.label)}
                onRevert={() => void rename(s.label, s.label, `Voltou a ${s.label}.`)}
              />
            )}
          </li>
        ))}
      </ul>
      {canReapply && (
        <button type="button" className="small" disabled={busy} onClick={() => void reapply()}>
          Reaplicar nomes da chamada
        </button>
      )}
      {timeline && timeline.status !== "off" && <p className="muted small">{HELP_TEXT}</p>}
    </>
  );
}
