import { useEffect, useState, type ReactNode } from "react";
import {
  ITEM_TYPE_LABELS,
  RISK_CATEGORY_LABELS,
  type ItemHistoryEntry,
  type ItemType,
  type RiskCategory,
} from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { llmLabel } from "../session";
import { Dialog } from "./Dialog";

type Tone = "primary" | "ok" | "error" | "warn" | "info" | "neutral";

const ACTION: Record<string, { label: string; tone: Tone }> = {
  created: { label: "Criado", tone: "primary" },
  edited: { label: "Editado", tone: "info" },
  approved: { label: "Aprovado", tone: "ok" },
  rejected: { label: "Rejeitado", tone: "error" },
  reopened: { label: "Reaberto para revisão", tone: "warn" },
  merged: { label: "Repetição absorvida", tone: "neutral" },
  evidence_remapped: { label: "Trechos ligados à transcrição final", tone: "neutral" },
  adr_edited: { label: "ADR editado", tone: "info" },
  adr_approved: { label: "ADR aprovado", tone: "ok" },
  adr_rejected: { label: "ADR rejeitado", tone: "error" },
};

const FIELD: Record<string, string> = {
  type: "Tipo",
  description: "Descrição",
  owner: "Responsável",
  due: "Prazo",
  reviewStatus: "Status",
  status: "Status do ADR",
  title: "Título",
  context: "Contexto",
  problem: "Problema",
  alternatives: "Alternativas",
  decision: "Decisão",
  consequences: "Consequências",
  risks: "Riscos",
  dependencia: "Dependência",
  status_acao: "Situação da ação",
  motivacao: "Motivação",
  impacto: "Impacto",
  sistema: "Sistema",
  categoria: "Categoria do risco",
};
// Textos longos aparecem em bloco (antes riscado, depois); o resto numa linha.
const LONG = new Set(["description", "title", "context", "problem", "decision", "consequences", "alternatives", "risks", "dependencia", "motivacao", "impacto"]);
const STATUS: Record<string, string> = { proposto: "Proposto", aprovado: "Aprovado", rejeitado: "Rejeitado" };
const ORIGIN: Record<string, string> = { live: "ao vivo", final: "pós-reunião", manual: "manual" };
const ACTION_STATUS: Record<string, string> = { aberta: "aberta", concluida: "concluída" };

const adrCode = (n: unknown) => (typeof n === "number" ? `ADR-${String(n).padStart(3, "0")}` : null);
const trechos = (n: unknown) => `${n} ${n === 1 ? "trecho" : "trechos"}`;

function format(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "type") return ITEM_TYPE_LABELS[value as ItemType] ?? String(value);
  if (field === "reviewStatus" || field === "status") return STATUS[String(value)] ?? String(value);
  if (field === "categoria") return RISK_CATEGORY_LABELS[value as RiskCategory] ?? String(value);
  if (field === "status_acao") return ACTION_STATUS[String(value)] ?? String(value);
  if (field === "alternatives" && Array.isArray(value)) {
    return value.map((a: { opcao?: string }) => a.opcao ?? "").filter(Boolean).join("; ") || "—";
  }
  if (Array.isArray(value)) return value.join("; ") || "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Campos alterados, com `attributes` aberto em seus subcampos e sem o que não mudou. */
function changes(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const flat = (o: Record<string, unknown> | null) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o ?? {})) {
      if (k === "attributes" && v && typeof v === "object") Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  };
  const b = flat(before);
  const a = flat(after);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => k in FIELD && !same(b[k], a[k]))
    .map((k) => ({ field: k, before: b[k], after: a[k] }));
}

function Change({ field, before, after }: { field: string; before: unknown; after: unknown }) {
  const label = FIELD[field];
  if (field === "reviewStatus" || field === "status") {
    return (
      <p className="history-change">
        <span className="history-field">{label}</span>
        <span className={`badge ${String(before) === "aprovado" ? "ok" : String(before) === "proposto" ? "warn" : ""}`}>{format(field, before)}</span>
        <span aria-hidden="true">→</span>
        <span className="sr-only">para</span>
        <span className={`badge ${String(after) === "aprovado" ? "ok" : String(after) === "proposto" ? "warn" : ""}`}>{format(field, after)}</span>
      </p>
    );
  }
  if (LONG.has(field)) {
    return (
      <div className="history-change block">
        <span className="history-field">{label}</span>
        {before !== undefined && format(field, before) !== "—" && (
          <del className="history-before">
            <span className="sr-only">antes: </span>
            {format(field, before)}
          </del>
        )}
        <p className="history-after">
          <span className="sr-only">depois: </span>
          {format(field, after)}
        </p>
      </div>
    );
  }
  return (
    <p className="history-change">
      <span className="history-field">{label}</span>
      {before !== undefined && (
        <>
          <span className="history-old">{format(field, before)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only">para</span>
        </>
      )}
      <span>{format(field, after)}</span>
    </p>
  );
}

function Details({ entry }: { entry: ItemHistoryEntry }) {
  const after = entry.after ?? {};
  const facts = (list: (string | null | false)[]) => {
    const shown = list.filter(Boolean);
    return shown.length ? <p className="history-facts">{shown.join(" · ")}</p> : null;
  };

  switch (entry.action) {
    case "created":
      return (
        <>
          {facts([
            format("type", after.type),
            typeof after.origin === "string" && ORIGIN[after.origin],
            typeof after.generatedBy === "string" && `gerado por ${llmLabel(after.generatedBy)}`,
          ])}
          {typeof after.description === "string" && <p className="history-after">{after.description}</p>}
          {facts([
            after.owner ? `Responsável: ${format("owner", after.owner)}` : null,
            after.due ? `Prazo: ${format("due", after.due)}` : null,
          ])}
        </>
      );
    case "merged":
      return (
        <>
          <p className="history-facts">
            A IA encontrou o mesmo item de novo e juntou aqui
            {typeof after.evidence === "number" ? ` (+${trechos(after.evidence)} da transcrição)` : ""}:
          </p>
          {typeof after.description === "string" && <p className="history-quote">“{after.description}”</p>}
        </>
      );
    case "evidence_remapped":
      return typeof after.evidence === "number" ? (
        <p className="history-facts">{trechos(after.evidence)} da transcrição ao vivo apontam agora para a transcrição final.</p>
      ) : null;
    default: {
      const list = changes(entry.before, entry.after);
      if (!list.length) return null;
      return (
        <>
          {list.map((c) => (
            <Change key={c.field} {...c} />
          ))}
        </>
      );
    }
  }
}

function title(entry: ItemHistoryEntry): ReactNode {
  const action = ACTION[entry.action];
  const code = entry.action.startsWith("adr_") ? adrCode(entry.after?.number) ?? adrCode(entry.before?.number) : null;
  return (
    <>
      {action?.label ?? entry.action}
      {code && <span className="history-code">{code}</span>}
    </>
  );
}

export function ItemHistory({
  itemId,
  description,
  open,
  onClose,
}: {
  itemId: string;
  description?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<ItemHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setHistory(null);
    setError("");
    api<{ history: ItemHistoryEntry[] }>(`/items/${itemId}/history`)
      .then((r) => setHistory(r.history))
      .catch((err) => setError(errorMessage(err)));
  }, [open, itemId]);

  return (
    <Dialog open={open} onClose={onClose} label="Histórico do item" className="panel-dialog">
      <header className="panel-dialog-head">
        <h2>Histórico</h2>
        {description && <p className="panel-dialog-sub">{description}</p>}
      </header>
      <div className="panel-dialog-body">
        {error && <p className="error-text">{error}</p>}
        {!history && !error && <p className="muted">Carregando…</p>}
        {history && (
          <ol className="history">
            {history.map((h, i) => {
              const tone = ACTION[h.action]?.tone ?? "neutral";
              return (
                <li key={i} className={`history-entry ${tone}`}>
                  <div className="history-head">
                    <strong>{title(h)}</strong>
                    <span className="history-when">
                      <time dateTime={h.createdAt}>{formatDateTime(h.createdAt)}</time> · {h.actor ? h.actor.username : "IA"}
                    </span>
                  </div>
                  <Details entry={h} />
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <footer className="panel-dialog-foot">
        <button type="button" onClick={onClose}>Fechar</button>
      </footer>
    </Dialog>
  );
}
