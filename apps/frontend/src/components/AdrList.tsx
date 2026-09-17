import { useState, type FormEvent } from "react";
import type { Adr } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { isExternal, llmLabel } from "../session";
import { useToast } from "./Toast";

function AdrCard({ adr, onChange, readOnly }: { adr: Adr; onChange: (a: Adr) => void; readOnly: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

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
    const text = (k: string) => String(d.get(k) ?? "").trim();
    const alternatives = text("alternatives")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [opcao, pros = "", contras = ""] = l.split("|").map((p) => p.trim());
        return { opcao, pros, contras };
      });
    const ok = await call(`/adrs/${adr.id}`, "PATCH", {
      title: text("title"),
      context: text("context"),
      problem: text("problem"),
      alternatives,
      decision: text("decision"),
      consequences: text("consequences"),
      risks: text("risks").split("\n").map((l) => l.trim()).filter(Boolean),
    });
    if (ok) setEditing(false);
  }

  const status = adr.status === "aprovado" ? "ok" : adr.status === "proposto" ? "warn" : "";
  return (
    <article className="adr">
      <div className="row between">
        <h3 style={{ margin: 0 }}>
          {adr.code ? `${adr.code} — ` : ""}
          {adr.title}
        </h3>
        <span className="row small">
          {adr.generatedBy && (
            <span className={`badge ${isExternal(adr.generatedBy) ? "warn" : ""}`} title="Modelo que gerou esta sugestão">
              {llmLabel(adr.generatedBy)}
            </span>
          )}
          <span className={`badge ${status}`}>{adr.status}</span>
        </span>
      </div>
      {editing ? (
        <form className="item-form" onSubmit={save}>
          <label>Título<input name="title" defaultValue={adr.title} required minLength={3} maxLength={300} /></label>
          <label>Contexto<textarea name="context" defaultValue={adr.context} maxLength={5000} /></label>
          <label>Problema<textarea name="problem" defaultValue={adr.problem} maxLength={5000} /></label>
          <label>
            Alternativas (uma por linha: opção | prós | contras)
            <textarea name="alternatives" defaultValue={adr.alternatives.map((a) => `${a.opcao} | ${a.pros} | ${a.contras}`).join("\n")} />
          </label>
          <label>Decisão<textarea name="decision" defaultValue={adr.decision} maxLength={5000} /></label>
          <label>Consequências<textarea name="consequences" defaultValue={adr.consequences} maxLength={5000} /></label>
          <label>Riscos (um por linha)<textarea name="risks" defaultValue={adr.risks.join("\n")} /></label>
          <div className="item-actions">
            <button className="small primary" disabled={busy}>Salvar</button>
            <button type="button" className="small" onClick={() => setEditing(false)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <>
          <dl>
            <dt>Contexto</dt><dd>{adr.context || "—"}</dd>
            <dt>Problema</dt><dd>{adr.problem || "—"}</dd>
            <dt>Alternativas</dt>
            <dd>
              {adr.alternatives.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {adr.alternatives.map((a, i) => (
                    <li key={i}>
                      <strong>{a.opcao}</strong>
                      {a.pros && ` — prós: ${a.pros}`}
                      {a.contras && ` — contras: ${a.contras}`}
                    </li>
                  ))}
                </ul>
              ) : (
                "não discutidas na reunião"
              )}
            </dd>
            <dt>Decisão</dt><dd>{adr.decision || "—"}</dd>
            <dt>Consequências</dt><dd>{adr.consequences || "—"}</dd>
            <dt>Riscos</dt><dd>{adr.risks.length ? adr.risks.join("\n") : "—"}</dd>
            <dt>Status</dt><dd>{adr.status}{adr.approvedAt ? ` em ${new Date(adr.approvedAt).toLocaleDateString("pt-BR")}` : ""}</dd>
          </dl>
          {!readOnly && <div className="item-actions">
            {adr.status !== "aprovado" && (
              <button type="button" className="small primary" disabled={busy} onClick={() => call(`/adrs/${adr.id}/approve`, "POST")}>
                Aprovar ADR
              </button>
            )}
            {adr.status !== "rejeitado" && (
              <button type="button" className="small" disabled={busy} onClick={() => call(`/adrs/${adr.id}/reject`, "POST")}>
                Rejeitar
              </button>
            )}
            <button type="button" className="small" onClick={() => setEditing(true)}>Editar</button>
          </div>}
        </>
      )}
    </article>
  );
}

export function AdrList({ adrs, onChange, readOnly = false }: { adrs: Adr[]; onChange: (a: Adr) => void; readOnly?: boolean }) {
  if (!adrs.length) {
    return <p className="muted">Nenhum ADR sugerido. Eles aparecem após a análise, ou pelo botão Gerar ADRs, para cada decisão arquitetural.</p>;
  }
  return (
    <>
      <p className="small muted">
        Sugestões da IA. Aprovar o ADR atribui o número definitivo; não aprova a decisão (e vice-versa).
      </p>
      {adrs.map((a) => (
        <AdrCard key={a.id} adr={a} onChange={onChange} readOnly={readOnly} />
      ))}
    </>
  );
}
