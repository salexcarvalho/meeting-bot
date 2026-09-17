import { useState, type FormEvent } from "react";
import { ITEM_TYPE_LABELS, ITEM_TYPES, type Item, type ItemType } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { Dialog } from "./Dialog";

export function NewItemForm({
  meetingId,
  open,
  onClose,
  onCreated,
}: {
  meetingId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (item: Item) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const item = await api<Item>(`/meetings/${meetingId}/items`, {
        method: "POST",
        json: {
          type: data.get("type") as ItemType,
          description: text("description"),
          owner: text("owner") || null,
          due: text("due") || null,
        },
      });
      onCreated(item);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="Novo item">
      <form onSubmit={submit}>
        <h2>Novo item</h2>
        <p className="small muted">Itens criados manualmente já nascem aprovados.</p>
        <label>
          Tipo
          <select name="type" defaultValue="pendencia">
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>{ITEM_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
        <label>
          Descrição
          <textarea name="description" required minLength={5} maxLength={1000} autoFocus />
        </label>
        <div className="grid-2">
          <label>
            Responsável
            <input name="owner" maxLength={120} />
          </label>
          <label>
            Prazo
            <input name="due" maxLength={120} placeholder="ex.: sexta-feira" />
          </label>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy}>Adicionar</button>
        </div>
      </form>
    </Dialog>
  );
}
