import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { DatabaseZap, RefreshCw } from "lucide-react";
import type { SearchStatusValue } from "@meeting-bot/contracts";
import { ApiError, errorMessage, searchReindex, searchStatus } from "../api";
import { formatCount } from "../format";
import { semanticReasonText } from "../searchUi";
import { useCan } from "../session";
import { ConfirmDialog } from "./Dialog";
import { useToast } from "./Toast";
import { CardHead, Kpi, SkeletonLines } from "./ui";

const POLL_MS = 10_000;

function useIndexOverview() {
  const [status, setStatus] = useState<SearchStatusValue | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    searchStatus()
      .then((s) => {
        setStatus(s);
        setDisabled(!s.enabled);
        setError("");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setDisabled(true);
        else setError(errorMessage(err));
      });
  }, []);
  useEffect(load, [load]);
  // Enquanto há reunião na fila, acompanha o andamento.
  const pending = status?.totals.pending ?? 0;
  useEffect(() => {
    if (pending === 0) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, load]);
  return { status, disabled, error, load };
}

function SemanticLine({ status }: { status: SearchStatusValue }) {
  const { semantic } = status;
  return (
    <p className="small">
      Modelo de busca semântica: <strong>{semantic.model}</strong> ({semantic.dim} dimensões) ·{" "}
      {semantic.available ? (
        <span className="badge ok">disponível</span>
      ) : (
        <span className="badge warn">indisponível: {semanticReasonText(semantic.reason)}</span>
      )}
    </p>
  );
}

function Counters({ status }: { status: SearchStatusValue }) {
  const { totals } = status;
  return (
    <div className="kpis">
      <Kpi label="Indexadas" value={formatCount(totals.indexed)} foot={`de ${formatCount(totals.meetings)} reuniões`} />
      <Kpi label="Pendentes" value={formatCount(totals.pending)} />
      <Kpi label="Falhas" value={formatCount(totals.failed)} />
      <Kpi label="Somente texto" value={formatCount(totals.textReady)} foot="sem busca semântica ainda" />
      <Kpi label="Trechos" value={formatCount(totals.chunks)} />
    </div>
  );
}

function Failures({ status }: { status: SearchStatusValue }) {
  if (!status.failures.length) return null;
  return (
    <section aria-label="Reuniões com falha na indexação">
      <h3>Falhas na indexação</h3>
      <ul className="search-status-list">
        {status.failures.map((f) => (
          <li key={f.meetingId}>
            <Link to={`/reunioes/${f.meetingId}`}>{f.title}</Link>
            <span className="small error-text">{f.error}</span>
            <span className="small muted">
              {f.attempts} {f.attempts === 1 ? "tentativa" : "tentativas"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SearchStatusCard() {
  const { status, disabled, error, load } = useIndexOverview();
  const can = useCan();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const canReindex = can("meetings.manage");

  async function reindex() {
    setBusy(true);
    try {
      const { queued } = await searchReindex();
      toast(queued === 1 ? "1 reunião na fila de indexação." : `${queued} reuniões na fila de indexação.`);
      load();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <CardHead
        title="Busca e perguntas"
        icon={DatabaseZap}
        actions={
          <button type="button" className="small" onClick={load}>
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
        }
      />
      <p className="card-desc">
        O índice permite buscar nas suas reuniões e perguntar sobre elas. Tudo é processado nesta máquina; nada sai dela.
      </p>
      {error && <div className="banner error">{error}</div>}
      {disabled && <div className="banner warn">A busca nas reuniões está desligada neste servidor.</div>}
      {!status && !error && !disabled && <SkeletonLines lines={4} />}
      {status && !disabled && (
        <>
          {status.paused === "reuniao_ao_vivo" && (
            <div className="banner warn" role="status">
              A indexação está pausada enquanto há uma reunião ao vivo e continua quando ela terminar.
            </div>
          )}
          <SemanticLine status={status} />
          <Counters status={status} />
          <Failures status={status} />
          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" disabled={!canReindex || busy} onClick={() => setConfirming(true)}>
              <RefreshCw aria-hidden="true" /> Reindexar minhas reuniões
            </button>
            {!canReindex && <span className="small muted">Exige permissão para gerenciar reuniões.</span>}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title="Reindexar minhas reuniões?"
        message="Todas as suas reuniões concluídas voltam para a fila de indexação. A busca continua funcionando enquanto isso, mas pode demorar para refletir tudo."
        confirmLabel="Reindexar"
        onClose={() => setConfirming(false)}
        onConfirm={() => void reindex()}
      />
    </section>
  );
}
