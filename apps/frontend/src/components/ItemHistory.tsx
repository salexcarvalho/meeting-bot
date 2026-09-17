import { useEffect, useState } from "react";
import type { ItemHistoryEntry } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { Dialog } from "./Dialog";

const ACTION: Record<string, string> = {
  created: "criado",
  edited: "editado",
  approved: "aprovado",
  rejected: "rejeitado",
  reopened: "reaberto",
  merged: "mesclado",
  evidence_remapped: "evidência remapeada",
  adr_edited: "ADR editado",
  adr_approved: "ADR aprovado",
  adr_rejected: "ADR rejeitado",
};

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function Changes({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (!keys.length) return null;
  return (
    <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
      {keys.map((k) => (
        <li key={k}>
          <strong>{k}</strong>:{" "}
          {before && k in before && <><code>{show(before[k])}</code> → </>}
          <code>{show(after?.[k])}</code>
        </li>
      ))}
    </ul>
  );
}

export function ItemHistory({ itemId, open, onClose }: { itemId: string; open: boolean; onClose: () => void }) {
  const [history, setHistory] = useState<ItemHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setHistory(null);
    api<{ history: ItemHistoryEntry[] }>(`/items/${itemId}/history`)
      .then((r) => setHistory(r.history))
      .catch((err) => setError(errorMessage(err)));
  }, [open, itemId]);

  return (
    <Dialog open={open} onClose={onClose} label="Histórico do item">
      <h2>Histórico</h2>
      {error && <p className="error-text">{error}</p>}
      {!history ? (
        <p className="muted">Carregando…</p>
      ) : (
        <ul className="history">
          {history.map((h, i) => (
            <li key={i}>
              <strong>{ACTION[h.action] ?? h.action}</strong> · {formatDateTime(h.createdAt)} · {h.actor?.username ?? "agente"}
              <Changes before={h.before} after={h.after} />
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Fechar</button>
      </div>
    </Dialog>
  );
}
