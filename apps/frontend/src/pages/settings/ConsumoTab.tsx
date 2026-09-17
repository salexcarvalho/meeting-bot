import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import type { LlmUsageGroup, LlmUsageReport } from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { CardHead, EmptyState, SkeletonLines } from "../../components/ui";

// Consumo de LLM do mês, lido do audit_log. Só leitura: nada aqui bloqueia geração.

const PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  claude: "Claude (assinatura)",
  codex: "Codex (assinatura)",
  local: "Ollama (local)",
};

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function money(v: number | null): string {
  return v === null ? "—" : `US$ ${v.toFixed(2)}`;
}

function months(current: string): string[] {
  const [y, m] = current.split("-").map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

function GroupTable({ title, rows }: { title: string; rows: LlmUsageGroup[] }) {
  if (!rows.length) return null;
  return (
    <div className="usage-block">
      <h3 className="small">{title}</h3>
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col">Chamadas</th>
            <th scope="col">Entrada</th>
            <th scope="col">Saída</th>
            <th scope="col">Custo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{PROVIDER_LABELS[r.key] ?? r.key}</td>
              <td>{r.calls}</td>
              <td>{tokens(r.promptTokens)}</td>
              <td>{tokens(r.completionTokens)}</td>
              <td>{money(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConsumoTab() {
  const [month, setMonth] = useState("");
  const [report, setReport] = useState<LlmUsageReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setBusy(true);
    api<LlmUsageReport>(`/llm/usage${month ? `?month=${month}` : ""}`)
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  }, [month]);

  const current = report?.month ?? "";

  return (
    <section className="card">
      <CardHead
        title="Consumo de IA"
        icon={Coins}
        actions={
          current ? (
            <label className="small inline-field">
              Mês
              <select value={current} onChange={(e) => setMonth(e.target.value)}>
                {months(current).map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          ) : null
        }
      />
      <p className="card-desc">
        Tokens e custo de cada geração de ata, ADR e análise. A assinatura do Claude/Codex não cobra por chamada:
        aparece só o volume de tokens. O modelo local (Ollama) não gera registro, porque nada sai da máquina.
      </p>
      {error && <div className="banner error">{error}</div>}
      {busy && !report && <SkeletonLines lines={4} />}
      {report && (
        <>
          <div className="usage-totals">
            <div>
              <span className="small muted">Chamadas</span>
              <strong>{report.totals.calls}</strong>
            </div>
            <div>
              <span className="small muted">Tokens de entrada</span>
              <strong>{tokens(report.totals.promptTokens)}</strong>
            </div>
            <div>
              <span className="small muted">Tokens de saída</span>
              <strong>{tokens(report.totals.completionTokens)}</strong>
            </div>
            <div>
              <span className="small muted">Custo (OpenRouter)</span>
              <strong>{money(report.totals.costUsd)}</strong>
            </div>
          </div>
          {report.totals.calls === 0 ? (
            <EmptyState title="Nada gerado neste mês">As gerações de ata e ADR aparecem aqui.</EmptyState>
          ) : (
            <>
              <GroupTable title="Provedor" rows={report.byProvider} />
              <GroupTable title="Modelo" rows={report.byModel} />
              {report.byMeeting.length > 0 && (
                <div className="usage-block">
                  <h3 className="small">Reunião</h3>
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th scope="col">Reunião</th>
                        <th scope="col">Chamadas</th>
                        <th scope="col">Tokens</th>
                        <th scope="col">Custo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byMeeting.map((r) => (
                        <tr key={r.meetingId}>
                          <td>
                            <a href={`/reunioes/${r.meetingId}`}>{r.title}</a>
                          </td>
                          <td>{r.calls}</td>
                          <td>{tokens(r.promptTokens + r.completionTokens)}</td>
                          <td>{money(r.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="usage-block">
                <h3 className="small">Últimas chamadas</h3>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th scope="col">Quando</th>
                      <th scope="col">O quê</th>
                      <th scope="col">Modelo</th>
                      <th scope="col">Tokens</th>
                      <th scope="col">Tempo</th>
                      <th scope="col">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.recent.map((c) => (
                      <tr key={`${c.at}-${c.label ?? ""}`}>
                        <td>{new Date(c.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                        <td>{c.label ?? "—"}</td>
                        <td>{c.model ?? "—"}</td>
                        <td>
                          {tokens(c.promptTokens)}+{tokens(c.completionTokens)}
                        </td>
                        <td>{c.durationMs === null ? "—" : `${(c.durationMs / 1000).toFixed(1)}s`}</td>
                        <td>{money(c.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
