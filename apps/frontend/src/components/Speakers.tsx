import { useState, type FormEvent } from "react";
import type { Speaker } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { useToast } from "./Toast";

export function Speakers({
  meetingId,
  speakers,
  onRenamed,
  readOnly = false,
}: {
  meetingId: string;
  speakers: Speaker[];
  onRenamed: () => void;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);

  async function save(label: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const displayName = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    try {
      await api(`/meetings/${meetingId}/speakers/${encodeURIComponent(label)}`, { method: "PATCH", json: { displayName } });
      setEditing(null);
      toast("Falante renomeado.");
      onRenamed();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  if (!speakers.length) return <p className="muted small">Os falantes aparecem depois da transcrição final.</p>;
  return (
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
            <div className="row between">
              <span>
                <strong>{s.displayName}</strong>
                {s.displayName !== s.label && <span className="muted small"> ({s.isUser ? "microfone" : s.label})</span>}
              </span>
              {!readOnly && (
                <button type="button" className="small" onClick={() => setEditing(s.label)}>Renomear</button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
