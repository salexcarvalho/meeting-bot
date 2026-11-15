import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ListChecks } from "lucide-react";
import type { TaskSummaryResponse } from "@meeting-bot/contracts";
import { errorMessage } from "../../api";
import { fetchTaskSummary } from "../../tasks";
import { CardHead } from "../ui";

/** Cartão da tela Hoje: cada número leva à lista já filtrada (as propostas levam às reuniões). */
export function TasksSummaryCard() {
  const [summary, setSummary] = useState<TaskSummaryResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchTaskSummary()
        .then((s) => {
          if (!alive) return;
          setSummary(s);
          setError("");
        })
        .catch((err) => {
          if (alive) setError(errorMessage(err));
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, []);

  const counts = summary?.counts;
  const n = (value: number | undefined) => (summary ? String(value ?? 0) : "…");
  const links = [
    { label: "Atrasadas", value: n(counts?.overdue), to: "/pendencias?prazo=overdue" },
    { label: "Vencem hoje", value: n(counts?.dueToday), to: "/pendencias?prazo=today" },
    { label: "Abertas", value: n(counts?.open), to: "/pendencias" },
    { label: "Propostas a revisar", value: n(summary?.proposalsToReview), to: "/reunioes" },
  ];
  return (
    <section className="card" aria-label="Minhas pendências">
      <CardHead title="Minhas pendências" icon={ListChecks} />
      {error && <p className="error-text small">{error}</p>}
      <ul className="tasks-summary">
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to}>
              <span className="tasks-summary-value">{l.value}</span>
              <span className="tasks-summary-label">{l.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
