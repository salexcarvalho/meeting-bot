import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Coins } from "lucide-react";
import { USAGE_PURPOSE_LABELS, USAGE_PROVIDER_LABELS, type UsageCallValue, type UsageCallsPageValue, type UsageReportValue } from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { CardHead, EmptyState, SkeletonLines } from "../../components/ui";
import { CostCell, DailyBars, GroupTable, RetentionNote, UsageKpis } from "../../components/usage/UsageParts";
import { defaultPeriod, isValidPeriod, periodQuery, PeriodPicker, type Period } from "../../components/usage/PeriodPicker";
import { useReport } from "../../components/usage/useReport";
import { formatAudio, formatCount, formatDateTime, formatMs, formatTokens } from "../../format";

// Meu consumo de IA: só as chamadas das reuniões em que eu sou o dono. Só leitura: nada aqui limita geração.

const ERROR_LABELS: Record<string, string> = {
  timeout: "tempo esgotado",
  unavailable: "serviço indisponível",
  schema_invalid: "resposta fora do formato",
  refused: "recusada pelo modelo",
  truncated: "resposta cortada",
  disabled: "desligado",
  cancelled: "cancelada",
  other: "erro",
};

export function errorLabel(code: string | null): string {
  if (!code) return "";
  if (/^http_\d{3}$/.test(code)) return `recusada pelo provedor (${code.slice(5)})`;
  return ERROR_LABELS[code] ?? "erro";
}

function callVolume(call: UsageCallValue): string {
  if (call.category === "asr") return formatAudio(call.audioSeconds);
  if (call.inputTokens === null && call.outputTokens === null) return "—";
  return formatTokens(call.inputTokens) + " + " + formatTokens(call.outputTokens);
}

function CallRow({ call }: { call: UsageCallValue }) {
  const purpose = USAGE_PURPOSE_LABELS[call.purpose];
  const provider = USAGE_PROVIDER_LABELS[call.provider as keyof typeof USAGE_PROVIDER_LABELS] ?? call.provider;
  return (
    <tr>
      <th scope="row">{formatDateTime(call.at)}</th>
      <td>
        {purpose}
        <span className="cell-sub"> · {provider}</span>
      </td>
      <td className="hide-sm">{call.model ?? "—"}</td>
      <td>
        {callVolume(call)}
      </td>
      <td className="hide-sm">{formatMs(call.durationMs)}</td>
      <td>
        <CostCell costUsd={call.costUsd} />
      </td>
      <td>
        {call.success ? (
          <span className="status-ok">ok</span>
        ) : (
          <span className="status-fail" title={call.errorCode ?? undefined}>
            {errorLabel(call.errorCode)}
          </span>
        )}
        {call.meetingTitle && call.meetingId && (
          <div className="cell-sub">
            <Link to={`/reunioes/${call.meetingId}`}>{call.meetingTitle}</Link>
          </div>
        )}
      </td>
    </tr>
  );
}

function CallsList({ period }: { period: Period }) {
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [items, setItems] = useState<UsageCallValue[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = isValidPeriod(period);
  const base = `/usage/me/calls?${valid ? periodQuery(period) : ""}&limit=30${onlyFailures ? "&status=error" : ""}`;

  const load = useCallback(
    (after: string | null, signal?: AbortSignal) => {
      setBusy(true);
      const next = after ? "&cursor=" + encodeURIComponent(after) : "";
      api<UsageCallsPageValue>(base + next, { signal })
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
    if (!valid) return;
    const controller = new AbortController();
    load(null, controller.signal);
    return () => controller.abort();
  }, [load, valid]);

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <h3 className="small">Últimas chamadas</h3>
        <label className="small inline-field">
          <input type="checkbox" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} />
          Só falhas
        </label>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!error && !busy && items.length === 0 && <p className="small muted">{onlyFailures ? "Nenhuma falha neste período." : "Nenhuma chamada neste período."}</p>}
      {items.length > 0 && (
        <table className="usage-table usage-calls">
          <thead>
            <tr>
              <th scope="col">Quando</th>
              <th scope="col">O quê</th>
              <th scope="col" className="hide-sm">
                Modelo
              </th>
              <th scope="col">Tokens / áudio</th>
              <th scope="col" className="hide-sm">
                Tempo
              </th>
              <th scope="col">Custo</th>
              <th scope="col">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <CallRow key={c.id} call={c} />
            ))}
          </tbody>
        </table>
      )}
      {busy && <SkeletonLines lines={2} />}
      {cursor && !busy && (
        <button type="button" className="small" onClick={() => load(cursor)}>
          Carregar mais
        </button>
      )}
    </div>
  );
}

export function ConsumoTab() {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const { report, error, busy } = useReport<UsageReportValue>("/usage/me", period);

  return (
    <section className="card">
      <CardHead title="Consumo de IA" icon={Coins} actions={<PeriodPicker value={period} onChange={setPeriod} />} />
      <p className="card-desc">
        Cada chamada de IA das suas reuniões: modelo local, OpenRouter, assinatura (Claude/Codex) e transcrição. O custo é o que o
        provedor informou; assinatura e modelo local não cobram por chamada, então mostram só tokens e tempo. Só você vê estes números, e
        nada aqui limita ou bloqueia uma geração.
      </p>
      {error && <div className="banner error">{error}</div>}
      {busy && !report && <SkeletonLines lines={4} />}
      {report && (
        <div aria-busy={busy}>
          <UsageKpis totals={report.totals} asr={report.asr} />
          {report.totals.calls === 0 ? (
            <EmptyState title="Nenhum consumo neste período">As gerações de ata, itens, ADR e as transcrições das suas reuniões aparecem aqui.</EmptyState>
          ) : (
            <>
              <DailyBars days={report.byDay} />
              <GroupTable title="Finalidade" rows={report.byPurpose} />
              <GroupTable title="Provedor" rows={report.byProvider} />
              <GroupTable title="Modelo" rows={report.byModel} />
              {report.topMeetings.length > 0 && (
                <div className="usage-block">
                  <h3 className="small">Reuniões que mais consumiram</h3>
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th scope="col">Reunião</th>
                        <th scope="col">Chamadas</th>
                        <th scope="col">Tokens</th>
                        <th scope="col">Áudio</th>
                        <th scope="col">Custo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topMeetings.map((m) => (
                        <tr key={m.meetingId}>
                          <th scope="row">
                            <Link to={`/reunioes/${m.meetingId}`}>{m.title}</Link>
                          </th>
                          <td>{formatCount(m.calls)}</td>
                          <td>{formatTokens(m.inputTokens + m.outputTokens)}</td>
                          <td>{m.audioSeconds ? formatAudio(m.audioSeconds) : "—"}</td>
                          <td>
                            <CostCell costUsd={m.costUsd} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <CallsList period={period} />
            </>
          )}
          <RetentionNote days={report.retention.usageDays} what="Os registros de consumo" />
          <p className="small muted">
            Com a chave do próprio provedor no OpenRouter (BYOK), o custo é o informado pelo OpenRouter e pode não ser o valor total pago ao provedor final.
          </p>
        </div>
      )}
    </section>
  );
}
