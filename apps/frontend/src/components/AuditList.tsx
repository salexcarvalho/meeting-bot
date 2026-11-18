import { useCallback, useEffect, useState } from "react";
import { USAGE_PURPOSE_LABELS, type AuditEventViewValue, type AuditKindInfoValue, type AuditPageValue, type UsagePurposeValue } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { EmptyState, SkeletonLines } from "./ui";
import { formatDateTime } from "../format";

// Lista de eventos de auditoria (já projetados pelo servidor: só os campos permitidos de cada tipo).
// Serve a aba "Segurança" do usuário (/audit/me) e a página "Auditoria" do admin (/admin/audit).

const WINDOWS = [
  { days: 7, label: "Últimos 7 dias" },
  { days: 30, label: "Últimos 30 dias" },
  { days: 90, label: "Últimos 90 dias" },
  { days: 365, label: "Último ano" },
];

const FIELD_LABELS: Record<string, string> = {
  ip: "IP",
  provider: "Provedor",
  model: "Modelo",
  purpose: "Finalidade",
  success: "Resultado",
  seconds: "Segundos de áudio",
  from: "De",
  to: "Para",
  role: "Papel",
  fields: "Campos",
  step: "Passo",
  table: "Tabela",
  deleted: "Apagados",
  olderThanDays: "Prazo (dias)",
  host: "Destino",
  protocol: "Protocolo",
  where: "Onde",
  reason: "Motivo",
  mode: "Modo",
  source: "Origem",
  created: "Criados",
  updated: "Atualizados",
  cancelled: "Cancelados",
  sessionsRevoked: "Sessões encerradas",
  rateLimited: "Limite de tentativas",
};

function fieldText(key: string, value: AuditEventViewValue["fields"][string]): string {
  if (key === "success") return value ? "sucesso" : "falha";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (key === "purpose" && typeof value === "string") return USAGE_PURPOSE_LABELS[value as UsagePurposeValue] ?? value;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function Details({ event }: { event: AuditEventViewValue }) {
  const entries = Object.entries(event.fields);
  if (!entries.length) return null;
  return (
    <ul className="audit-fields">
      {entries.map(([key, value]) => (
        <li key={key}>
          <span className="muted">{FIELD_LABELS[key] ?? key}:</span> {fieldText(key, value)}
        </li>
      ))}
    </ul>
  );
}

export function AuditList({
  endpoint,
  showPeople,
  users,
  emptyHint,
}: {
  endpoint: string;
  /** admin: mostra quem fez e quem sofreu a ação */
  showPeople: boolean;
  /** admin: filtro por usuário (id → nome) */
  users?: { id: string; username: string }[];
  emptyHint: string;
}) {
  const [kinds, setKinds] = useState<AuditKindInfoValue[]>([]);
  const [kind, setKind] = useState("");
  const [userId, setUserId] = useState("");
  const [days, setDays] = useState(90);
  const [items, setItems] = useState<AuditEventViewValue[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    api<{ items: AuditKindInfoValue[] }>("/audit/kinds")
      .then((r) => setKinds(r.items))
      .catch(() => setKinds([]));
  }, []);

  const params = new URLSearchParams({ limit: "30", from: new Date(Date.now() - days * 86_400_000).toISOString() });
  if (kind) params.set("kind", kind);
  if (userId) params.set("userId", userId);
  const base = `${endpoint}?${params.toString()}`;

  const load = useCallback(
    (after: string | null, signal?: AbortSignal) => {
      setBusy(true);
      const next = after ? "&cursor=" + encodeURIComponent(after) : "";
      api<AuditPageValue>(base + next, { signal })
        .then((page) => {
          setItems((prev) => (after ? [...prev, ...page.items] : page.items));
          setCursor(page.nextCursor);
          setError("");
        })
        .catch((err) => {
          if (!signal?.aborted) setError(errorMessage(err));
        })
        .finally(() => {
          if (!signal?.aborted) setBusy(false);
        });
    },
    [base],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div>
      <div className="audit-filters">
        <label className="small inline-field">
          Tipo
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Todos</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="small inline-field">
          Período
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {users && users.length > 0 && (
          <label className="small inline-field">
            Usuário
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todos</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}
      {busy && items.length === 0 && <SkeletonLines lines={4} />}
      {!busy && !error && items.length === 0 && <EmptyState title="Nenhum evento neste filtro">{emptyHint}</EmptyState>}
      {items.length > 0 && (
        <ol className="audit-list" aria-busy={busy}>
          {items.map((e) => (
            <li key={e.id} className="audit-item">
              <time className="audit-when small muted" dateTime={e.at}>
                {formatDateTime(e.at)}
              </time>
              <div className="audit-body">
                <div className="audit-title">{e.title}</div>
                {showPeople && (e.actor?.username || e.target?.username) && (
                  <div className="cell-sub">
                    {e.actor?.username && <>Conta: {e.actor.username}</>}
                    {e.target?.username && <> · Alvo: {e.target.username}</>}
                  </div>
                )}
                <Details event={e} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {cursor && !busy && (
        <button type="button" className="small" onClick={() => load(cursor)}>
          Carregar mais
        </button>
      )}
    </div>
  );
}
