import { useState, type ReactNode } from "react";
import { Activity, AudioLines, Coins, Cpu, Hash } from "lucide-react";
import type { UsageAsrSplitValue, UsageGroupValue, UsageTotalsValue } from "@meeting-bot/contracts";
import { formatAudio, formatCount, formatMs, formatTokens, formatUsd } from "../../format";
import { Kpi } from "../ui";
import { BAR_METRICS, UsageBars, type BarMetric } from "../ui/UsageBars";

// Peças compartilhadas do painel do usuário e do painel de admin. Nada aqui conhece reunião:
// só totais e grupos, o que garante que a tela de admin não tenha o que mostrar de terceiros.

export const NO_COST_LABEL = "sem custo por chamada";

/** Custo informado pelo provedor; nulo é "sem custo por chamada", nunca zero. */
export function CostCell({ costUsd }: { costUsd: number | null }) {
  return costUsd === null ? <span className="muted small">{NO_COST_LABEL}</span> : <>{formatUsd(costUsd)}</>;
}

export function UsageKpis({ totals, asr }: { totals: UsageTotalsValue; asr: UsageAsrSplitValue }) {
  const audio = asr.local.audioSeconds + asr.external.audioSeconds;
  return (
    <div className="kpis" role="group" aria-label="Resumo do período">
      <Kpi
        icon={Activity}
        label="Chamadas"
        value={formatCount(totals.calls)}
        foot={totals.failedCalls > 0 ? `${formatCount(totals.failedCalls)} com falha` : "nenhuma falha"}
      />
      <Kpi
        icon={Hash}
        label="Tokens"
        value={formatTokens(totals.inputTokens + totals.outputTokens)}
        foot={`${formatTokens(totals.inputTokens)} entrada · ${formatTokens(totals.outputTokens)} saída`}
      />
      <Kpi
        icon={Coins}
        label="Custo informado"
        value={formatUsd(totals.costUsd)}
        foot={
          totals.calls === 0
            ? undefined
            : `${formatCount(totals.pricedCalls)} de ${formatCount(totals.calls)} chamadas com custo (assinatura e modelo local: ${NO_COST_LABEL})`
        }
      />
      <Kpi
        icon={AudioLines}
        label="Áudio transcrito"
        value={formatAudio(audio)}
        foot={`${formatAudio(asr.local.audioSeconds)} local · ${formatAudio(asr.external.audioSeconds)} externo`}
      />
      <Kpi
        icon={Cpu}
        label="Inferência local"
        value={formatMs(totals.computeMs)}
        foot="modelo local e Whisper; não é ocupação da GPU"
      />
    </div>
  );
}

export function GroupTable({ title, rows, firstColumn }: { title: string; rows: UsageGroupValue[]; firstColumn?: string }) {
  if (!rows.length) return null;
  return (
    <div className="usage-block">
      <h3 className="small">{title}</h3>
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{firstColumn ?? title}</th>
            <th scope="col">Chamadas</th>
            <th scope="col">Falhas</th>
            <th scope="col">Tokens</th>
            <th scope="col">Áudio</th>
            <th scope="col">Custo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{formatCount(r.calls)}</td>
              <td>{r.failedCalls ? formatCount(r.failedCalls) : "—"}</td>
              <td>{r.inputTokens + r.outputTokens ? `${formatTokens(r.inputTokens)} + ${formatTokens(r.outputTokens)}` : "—"}</td>
              <td>{r.audioSeconds ? formatAudio(r.audioSeconds) : "—"}</td>
              <td>
                <CostCell costUsd={r.costUsd} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DailyBars({ days }: { days: UsageGroupValue[] }) {
  const [metric, setMetric] = useState<BarMetric>("calls");
  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <h3 className="small">Por dia</h3>
        <div className="seg" role="group" aria-label="Métrica do gráfico">
          {BAR_METRICS.map((m) => (
            <button key={m.key} type="button" className="small" aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <UsageBars days={days} metric={metric} />
    </div>
  );
}

export function RetentionNote({ days, what }: { days: number; what: ReactNode }) {
  return (
    <p className="small muted">
      {days > 0
        ? `${what} são guardados por ${days >= 60 ? `${Math.round(days / 30)} meses` : `${days} dias`} e depois apagados automaticamente.`
        : `${what} ficam guardados sem prazo de exclusão.`}
    </p>
  );
}
