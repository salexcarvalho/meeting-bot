import { formatMonth, recentMonths, todayIso } from "../../format";

// Período dos painéis: um mês (padrão: o corrente) ou um intervalo livre de datas (janela máxima de 24 meses).

export type Period = { mode: "month"; month: string } | { mode: "range"; from: string; to: string };

const RANGE = "range";
const MONTHS_SHOWN = 24;

export function defaultPeriod(): Period {
  return { mode: "month", month: recentMonths(1)[0] };
}

/** Querystring da API; o intervalo vai do início do dia `from` ao fim do dia `to` (fuso do navegador). */
export function periodQuery(period: Period): string {
  if (period.mode === "month") return `month=${period.month}`;
  const from = new Date(`${period.from}T00:00:00`);
  const to = new Date(`${period.to}T00:00:00`);
  to.setDate(to.getDate() + 1);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

export function isValidPeriod(period: Period): boolean {
  if (period.mode === "month") return true;
  return Boolean(period.from && period.to && period.from <= period.to);
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (period: Period) => void }) {
  const months = recentMonths(MONTHS_SHOWN);
  const today = todayIso();
  return (
    <div className="period-picker">
      <label className="small inline-field">
        Período
        <select
          value={value.mode === "month" ? value.month : RANGE}
          onChange={(e) =>
            onChange(e.target.value === RANGE ? { mode: "range", from: `${months[0]}-01`, to: today } : { mode: "month", month: e.target.value })
          }
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
          <option value={RANGE}>Intervalo livre…</option>
        </select>
      </label>
      {value.mode === "range" && (
        <>
          <label className="small inline-field">
            De
            <input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </label>
          <label className="small inline-field">
            Até
            <input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </label>
        </>
      )}
    </div>
  );
}
