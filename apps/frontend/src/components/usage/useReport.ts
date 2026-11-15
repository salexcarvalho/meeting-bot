import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { isValidPeriod, periodQuery, type Period } from "./PeriodPicker";

// Carrega um relatório de uso do período escolhido; cancela a resposta antiga quando o período muda.
export function useReport<T>(path: string, period: Period): { report: T | null; error: string; busy: boolean } {
  const [report, setReport] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const query = isValidPeriod(period) ? periodQuery(period) : null;

  useEffect(() => {
    if (query === null) {
      setError("Escolha um intervalo em que a data inicial não seja depois da final.");
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    api<T>(`${path}?${query}`, { signal: controller.signal })
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [path, query]);

  return { report, error, busy };
}
