import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Adr, Item } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { externalName, isExternal, llmLabel } from "../session";
import { useToast } from "./Toast";

type AdrStatus = Adr["status"];
type Filter = "ativos" | AdrStatus;

const FILTERS: { key: Filter; label: string; empty: string }[] = [
  { key: "ativos", label: "Ativos", empty: "Nenhum ADR proposto ou aprovado." },
  { key: "proposto", label: "Propostos", empty: "Nenhum ADR aguardando revisão." },
  { key: "aprovado", label: "Aprovados", empty: "Nenhum ADR aprovado." },
  { key: "rejeitado", label: "Rejeitados", empty: "Nenhum ADR rejeitado." },
];
const STATUS_LABEL: Record<AdrStatus, string> = { proposto: "Proposto", aprovado: "Aprovado", rejeitado: "Rejeitado" };
const STATUS_BADGE: Record<AdrStatus, string> = { proposto: "warn", aprovado: "ok", rejeitado: "" };
const ITEM_STATUS: Record<Item["reviewStatus"], string> = { proposto: "proposta", aprovado: "aprovada", rejeitado: "rejeitada" };
// propostos primeiro (é o que pede ação), depois aprovados pelo número
const ORDER: Record<AdrStatus, number> = { proposto: 0, aprovado: 1, rejeitado: 2 };

const formatDay = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

function reviewText(adr: Adr): string {
  if (adr.status === "aprovado") return adr.approvedAt ? `Aprovado em ${formatDay(adr.approvedAt)}` : "Aprovado";
  if (adr.status === "rejeitado") {
    return adr.approvedAt ? `Rejeitado depois de aprovado em ${formatDay(adr.approvedAt)}` : "Rejeitado";
  }
  return "Aguardando revisão";
}

function Field({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`adr-field${wide ? " wide" : ""}`}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

const text = (value: string) => (value ? <p>{value}</p> : <p className="muted">—</p>);

function AdrCard({
  adr,
  item,
  expanded,
  onToggle,
  onChange,
  onShowItem,
  readOnly,
}: {
  adr: Adr;
  item: Item | undefined;
  expanded: boolean;
  onToggle: () => void;
  onChange: (a: Adr) => void;
  onShowItem?: (itemId: string) => void;
  readOnly: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyId = `adr-body-${adr.id}`;
  const open = expanded || editing;
  const external = isExternal(adr.generatedBy);

  async function call(path: string, method: string, json?: unknown) {
    setBusy(true);
    try {
      onChange(await api<Adr>(path, { method, json }));
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
    const d = new FormData(e.currentTarget);
    const value = (k: string) => String(d.get(k) ?? "").trim();
    const alternatives = value("alternatives")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [opcao, pros = "", contras = ""] = l.split("|").map((p) => p.trim());
        return { opcao, pros, contras };
      });
    const ok = await call(`/adrs/${adr.id}`, "PATCH", {
      title: value("title"),
      context: value("context"),
      problem: value("problem"),
      alternatives,
      decision: value("decision"),
      consequences: value("consequences"),
      risks: value("risks").split("\n").map((l) => l.trim()).filter(Boolean),
    });
    if (ok) setEditing(false);
  }

  return (
    <article className={`adr-card ${adr.status}`}>
      <h3 className="adr-head">
        <button type="button" className="adr-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} disabled={editing}>
          <span className="adr-code">{adr.code ?? "Sugestão"}</span>
          <span className="adr-title">{adr.title}</span>
          <ChevronDown className="adr-chevron" aria-hidden="true" />
        </button>
      </h3>
      <div className="adr-meta">
        <span className={`badge ${STATUS_BADGE[adr.status]}`}>{STATUS_LABEL[adr.status]}</span>
        {adr.generatedBy && (
          <span className={`badge ${external ? "warn" : ""}`} title={`Gerado por ${llmLabel(adr.generatedBy)}`}>
            {externalName(adr.generatedBy) ?? "Local"}
          </span>
        )}
        {item && (
          <span className="adr-origin">
            Decisão {ITEM_STATUS[item.reviewStatus]}:{" "}
            {onShowItem ? (
              <button type="button" className="link" onClick={() => onShowItem(item.id)} title="Ver a decisão na aba Itens">
                {item.description}
              </button>
            ) : (
              item.description
            )}
          </span>
        )}
      </div>

      {!open && adr.decision && <p className="adr-excerpt">{adr.decision}</p>}

      {open && (
        <div id={bodyId} className="adr-body">
          {editing ? (
            <form className="item-form" onSubmit={save}>
              <label>Título<input name="title" defaultValue={adr.title} required minLength={3} maxLength={300} /></label>
              <label>Contexto<textarea name="context" rows={4} defaultValue={adr.context} maxLength={5000} /></label>
              <label>Problema<textarea name="problem" rows={3} defaultValue={adr.problem} maxLength={5000} /></label>
              <label>
                Alternativas (uma por linha: opção | prós | contras)
                <textarea name="alternatives" rows={3} defaultValue={adr.alternatives.map((a) => `${a.opcao} | ${a.pros} | ${a.contras}`).join("\n")} />
              </label>
              <label>Decisão<textarea name="decision" rows={4} defaultValue={adr.decision} maxLength={5000} /></label>
              <label>Consequências<textarea name="consequences" rows={4} defaultValue={adr.consequences} maxLength={5000} /></label>
              <label>Riscos (um por linha)<textarea name="risks" rows={3} defaultValue={adr.risks.join("\n")} /></label>
              <div className="item-actions">
                <button className="small primary" disabled={busy}>Salvar</button>
                <button type="button" className="small" onClick={() => setEditing(false)}>Cancelar</button>
              </div>
            </form>
          ) : (
            <>
              <div className="adr-fields">
                <Field title="Contexto">{text(adr.context)}</Field>
                <Field title="Problema">{text(adr.problem)}</Field>
                <Field title="Alternativas" wide>
                  {adr.alternatives.length ? (
                    <ul>
                      {adr.alternatives.map((a, i) => (
                        <li key={i}>
                          <strong>{a.opcao}</strong>
                          {a.pros && ` — prós: ${a.pros}`}
                          {a.contras && ` — contras: ${a.contras}`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">Não discutidas na reunião.</p>
                  )}
                </Field>
                <section className="adr-field wide adr-decision">
                  <h4>Decisão</h4>
                  {text(adr.decision)}
                </section>
                <Field title="Consequências">{text(adr.consequences)}</Field>
                <Field title="Riscos">
                  {adr.risks.length ? (
                    <ul>
                      {adr.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  ) : (
                    <p className="muted">—</p>
                  )}
                </Field>
              </div>
              <div className="adr-foot">
                <span className="small muted">
                  {reviewText(adr)}
                  {adr.generatedBy && ` · gerado por ${llmLabel(adr.generatedBy)}`}
                </span>
                {!readOnly && (
                  <div className="item-actions" style={{ marginTop: 0 }}>
                    {adr.status !== "aprovado" && (
                      <button
                        type="button"
                        className={`small${adr.status === "proposto" ? " primary" : ""}`}
                        disabled={busy}
                        onClick={() => call(`/adrs/${adr.id}/approve`, "POST")}
                      >
                        Aprovar ADR
                      </button>
                    )}
                    {adr.status !== "rejeitado" && (
                      <button type="button" className="small" disabled={busy} onClick={() => call(`/adrs/${adr.id}/reject`, "POST")}>
                        Rejeitar
                      </button>
                    )}
                    <button type="button" className="small" onClick={() => setEditing(true)}>Editar</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function AdrList({
  adrs,
  items = [],
  onChange,
  onShowItem,
  readOnly = false,
}: {
  adrs: Adr[];
  items?: Item[];
  onChange: (a: Adr) => void;
  /** leva à decisão de origem na aba Itens */
  onShowItem?: (itemId: string) => void;
  readOnly?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("ativos");
  // null = padrão (aberto só quando há um ADR na lista); depois, os ids abertos. Trocar o filtro volta ao padrão.
  const [openIds, setOpenIds] = useState<Set<string> | null>(null);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ativos: 0, proposto: 0, aprovado: 0, rejeitado: 0 };
    for (const a of adrs) {
      c[a.status]++;
      if (a.status !== "rejeitado") c.ativos++;
    }
    return c;
  }, [adrs]);
  const visible = useMemo(
    () =>
      adrs
        .filter((a) => (filter === "ativos" ? a.status !== "rejeitado" : a.status === filter))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.number ?? 0) - (b.number ?? 0)),
    [adrs, filter],
  );

  if (!adrs.length) {
    return <p className="muted">Nenhum ADR sugerido. Eles aparecem após a análise, ou pelo botão Gerar ADRs, para cada decisão arquitetural.</p>;
  }

  const isOpen = (id: string) => (openIds ? openIds.has(id) : visible.length === 1);
  const allOpen = visible.length > 0 && visible.every((a) => isOpen(a.id));
  const toggle = (id: string) => {
    const next = new Set(visible.filter((a) => isOpen(a.id)).map((a) => a.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  };

  return (
    <section>
      <div className="adr-toolbar">
        <div className="tabs" role="tablist" aria-label="Filtrar ADRs" style={{ marginBottom: 0, borderBottom: 0 }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => {
                setFilter(f.key);
                setOpenIds(null);
              }}
            >
              {f.label} ({counts[f.key]})
            </button>
          ))}
        </div>
        {visible.length > 1 && (
          <button type="button" className="small ghost" onClick={() => setOpenIds(allOpen ? new Set() : new Set(visible.map((a) => a.id)))}>
            {allOpen ? "Recolher todos" : "Expandir todos"}
          </button>
        )}
      </div>
      <p className="small muted" style={{ margin: "0 0 12px" }}>
        Sugestões da IA. Aprovar o ADR dá o número definitivo, mas não aprova a decisão de origem (e vice-versa).
      </p>
      {visible.length === 0 ? (
        <p className="panel-empty">{FILTERS.find((f) => f.key === filter)!.empty}</p>
      ) : (
        <div className="adr-list">
          {visible.map((a) => (
            <AdrCard
              key={a.id}
              adr={a}
              item={itemById.get(a.itemId)}
              expanded={isOpen(a.id)}
              onToggle={() => toggle(a.id)}
              onChange={onChange}
              onShowItem={onShowItem}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </section>
  );
}
