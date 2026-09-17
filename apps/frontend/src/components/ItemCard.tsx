import { useState, type FormEvent } from "react";
import {
  ITEM_TYPE_LABELS,
  ITEM_TYPES,
  RISK_CATEGORIES,
  RISK_CATEGORY_LABELS,
  type Channel,
  type Item,
  type ItemType,
  type RiskCategory,
} from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { formatClock } from "../format";
import { isExternal, llmLabel } from "../session";
import { ItemHistory } from "./ItemHistory";
import { useToast } from "./Toast";

const STATUS_TEXT = { proposto: "proposto", aprovado: "aprovado", rejeitado: "rejeitado" } as const;
const ORIGIN_TEXT = { live: "ao vivo", final: "pós-reunião", manual: "manual" } as const;

export function ItemCard({
  item,
  onChange,
  onEvidence,
  onGenerateAdr,
  readOnly = false,
}: {
  item: Item;
  readOnly?: boolean;
  onChange: (item: Item) => void;
  onEvidence?: (segmentId: number | null, channel: Channel, start: number) => void;
  /** presente quando quem vê pode gerar ADR desta decisão */
  onGenerateAdr?: (item: Item) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<ItemType>(item.type);

  async function call(path: string, method: string, json?: unknown) {
    setBusy(true);
    try {
      const updated = await api<Item>(path, { method, json });
      onChange(updated);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const attributes: Record<string, unknown> = {};
    if (type === "risco") attributes.categoria = (data.get("categoria") as RiskCategory) || null;
    if (type === "pendencia") {
      attributes.status_acao = data.get("concluida") ? "concluida" : "aberta";
      attributes.dependencia = text("dependencia") || null;
    }
    const ok = await call(`/items/${item.id}`, "PATCH", {
      type,
      description: text("description"),
      owner: text("owner") || null,
      due: text("due") || null,
      attributes,
    });
    if (ok) setEditing(false);
  }

  const quote = item.evidence.find((e) => e.quote)?.quote;

  return (
    <article className={`item ${item.reviewStatus}`}>
      {editing ? (
        <form className="item-form" onSubmit={save}>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)} aria-label="Tipo">
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>{ITEM_TYPE_LABELS[t]}</option>
            ))}
          </select>
          <textarea name="description" defaultValue={item.description} required minLength={5} maxLength={1000} aria-label="Descrição" />
          <input name="owner" defaultValue={item.owner ?? ""} placeholder="Responsável" maxLength={120} />
          <input name="due" defaultValue={item.due ?? ""} placeholder="Prazo" maxLength={120} />
          {type === "risco" && (
            <select name="categoria" defaultValue={item.attributes.categoria ?? ""} aria-label="Categoria">
              <option value="">Sem categoria</option>
              {RISK_CATEGORIES.map((c) => (
                <option key={c} value={c}>{RISK_CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          )}
          {type === "pendencia" && (
            <>
              <input name="dependencia" defaultValue={item.attributes.dependencia ?? ""} placeholder="Depende de" maxLength={300} />
              <label className="row small" style={{ margin: 0 }}>
                <input type="checkbox" name="concluida" defaultChecked={item.attributes.status_acao === "concluida"} /> Concluída
              </label>
            </>
          )}
          <div className="item-actions">
            <button className="small primary" disabled={busy}>Salvar</button>
            <button type="button" className="small" onClick={() => setEditing(false)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <>
          <div className="row small" style={{ justifyContent: "space-between" }}>
            <span className={`badge item-badge ${item.reviewStatus === "aprovado" ? "ok" : item.reviewStatus === "proposto" ? "warn" : ""}`}>
              {STATUS_TEXT[item.reviewStatus]}
            </span>
            <span className="muted small">
              {ORIGIN_TEXT[item.origin]}
              {isExternal(item.generatedBy) && (
                <span className="badge warn chip-external" title={`Gerado por ${llmLabel(item.generatedBy)}`}>OpenRouter</span>
              )}
            </span>
          </div>
          <p className="item-text">{item.description}</p>
          {quote && <p className="item-quote">“{quote}”</p>}
          <div className="item-meta">
            {item.owner && <span>👤 {item.owner}</span>}
            {item.due && <span>📅 {item.due}</span>}
            {item.type === "risco" && item.attributes.categoria && <span>{RISK_CATEGORY_LABELS[item.attributes.categoria]}</span>}
            {item.attributes.dependencia && <span>depende de: {item.attributes.dependencia}</span>}
            {item.attributes.status_acao === "concluida" && <span>✔ concluída</span>}
            {item.attributes.sistema && <span>sistema: {item.attributes.sistema}</span>}
          </div>
          {item.evidence.length > 0 && onEvidence && (
            <div className="item-evidence">
              {item.evidence.slice(0, 4).map((e, i) => (
                <button key={i} type="button" className="link" onClick={() => onEvidence(e.segmentId, e.channel, e.start)} title="Ver trecho">
                  ▶ {formatClock(e.start)}
                </button>
              ))}
            </div>
          )}
          <div className="item-actions">
            {readOnly ? null : item.reviewStatus === "proposto" ? (
              <>
                <button type="button" className="small primary" disabled={busy} onClick={() => call(`/items/${item.id}/approve`, "POST")}>Aprovar</button>
                <button type="button" className="small" disabled={busy} onClick={() => call(`/items/${item.id}/reject`, "POST")}>Rejeitar</button>
              </>
            ) : (
              <button type="button" className="small" disabled={busy} onClick={() => call(`/items/${item.id}/reopen`, "POST")}>Reabrir</button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="small"
                onClick={() => {
                  setType(item.type);
                  setEditing(true);
                }}
              >
                Editar
              </button>
            )}
            {onGenerateAdr && item.type === "decisao_arquitetural" && item.reviewStatus !== "rejeitado" && (
              <button type="button" className="small" onClick={() => onGenerateAdr(item)}>Gerar ADR</button>
            )}
            <button type="button" className="small link" onClick={() => setHistoryOpen(true)}>Histórico</button>
          </div>
        </>
      )}
      <ItemHistory itemId={item.id} open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </article>
  );
}
