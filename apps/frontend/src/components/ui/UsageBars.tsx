import type { UsageGroupValue } from "@meeting-bot/contracts";
import { formatAudio, formatCount, formatTokens } from "../../format";

// Barras diárias em SVG/CSS, sem biblioteca de gráfico. A tabela equivalente fica num <details>
// para leitores de tela e para quem prefere números.

export type BarMetric = "calls" | "tokens" | "audio";

export const BAR_METRICS: { key: BarMetric; label: string }[] = [
  { key: "calls", label: "Chamadas" },
  { key: "tokens", label: "Tokens" },
  { key: "audio", label: "Áudio" },
];

function valueOf(day: UsageGroupValue, metric: BarMetric): number {
  if (metric === "calls") return day.calls;
  if (metric === "audio") return day.audioSeconds;
  return day.inputTokens + day.outputTokens;
}

function format(value: number, metric: BarMetric): string {
  if (metric === "audio") return formatAudio(value);
  return metric === "tokens" ? formatTokens(value) : formatCount(value);
}

const HEIGHT = 120;
const BAR_WIDTH = 18;
const GAP = 6;

export function UsageBars({ days, metric }: { days: UsageGroupValue[]; metric: BarMetric }) {
  const values = days.map((d) => valueOf(d, metric));
  const max = Math.max(...values, 0);
  const width = Math.max(days.length * (BAR_WIDTH + GAP) - GAP, BAR_WIDTH);
  const metricLabel = BAR_METRICS.find((m) => m.key === metric)?.label ?? "";
  const summary = `${metricLabel} por dia: ${days.map((d, i) => `${d.label} ${format(values[i], metric)}`).join("; ")}`;

  if (!days.length || max === 0) return <p className="small muted">Sem consumo de {metricLabel.toLowerCase()} neste período.</p>;

  return (
    <div className="usage-bars">
      <div className="usage-bars-scroll">
        <svg viewBox={`0 0 ${width} ${HEIGHT + 18}`} width={width} height={HEIGHT + 18} role="img" aria-label={summary}>
          {days.map((day, i) => {
            const h = Math.max((values[i] / max) * HEIGHT, values[i] > 0 ? 2 : 0);
            const x = i * (BAR_WIDTH + GAP);
            return (
              <g key={day.key}>
                <title>{`${day.label}: ${format(values[i], metric)}`}</title>
                <rect className="usage-bar" x={x} y={HEIGHT - h} width={BAR_WIDTH} height={h} rx={3} />
                {(days.length <= 10 || i % Math.ceil(days.length / 10) === 0) && (
                  <text className="usage-bar-label" x={x + BAR_WIDTH / 2} y={HEIGHT + 13} textAnchor="middle">
                    {day.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="usage-bars-table">
        <summary className="small">Ver como tabela</summary>
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Dia</th>
              <th scope="col">Chamadas</th>
              <th scope="col">Tokens</th>
              <th scope="col">Áudio</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.key}>
                <th scope="row">{d.label}</th>
                <td>{formatCount(d.calls)}</td>
                <td>{formatTokens(d.inputTokens + d.outputTokens)}</td>
                <td>{formatAudio(d.audioSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
