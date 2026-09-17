import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, ChevronLeft, ChevronRight, Inbox, MonitorSmartphone, Plus, Upload } from "lucide-react";
import type { AgendaResponse, MeetingSummary } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { AgendaItem } from "../components/AgendaItem";
import { ImportIcs } from "../components/ImportIcs";
import { MeetingForm } from "../components/MeetingForm";
import { CardHead, EmptyState, PageHeader, SkeletonLines } from "../components/ui";
import { formatLongDate, shiftDate, todayIso } from "../format";
import { useLive, useProjects } from "../hooks";
import { live } from "../live";
import { useCan } from "../session";

function dayOf(m: MeetingSummary): string {
  const iso = m.scheduledStart ?? m.startedAt ?? m.createdAt;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(iso));
}

function sortKey(m: MeetingSummary): number {
  return new Date(m.scheduledStart ?? m.startedAt ?? m.createdAt).getTime();
}

export function Hoje() {
  const can = useCan();
  const [date, setDate] = useState(todayIso());
  const [agenda, setAgenda] = useState<AgendaResponse | null>(null);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MeetingSummary | null>(null);
  const { projects } = useProjects();

  const load = useCallback(() => {
    api<AgendaResponse>(`/agenda?date=${date}`)
      .then((a) => {
        setAgenda(a);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [date]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => live.subscribe({ topic: "agenda" }), []);
  useEffect(() => live.onReconnect(load), [load]);

  const upsert = useCallback(
    (m: MeetingSummary) => {
      setAgenda((a) => {
        if (!a) return a;
        const others = a.meetings.filter((x) => x.id !== m.id);
        const meetings = dayOf(m) === a.date ? [...others, m].sort((x, y) => sortKey(x) - sortKey(y)) : others;
        const recording =
          m.status === "recording" || m.status === "stopping"
            ? m.id
            : a.recordingMeetingId === m.id
              ? null
              : a.recordingMeetingId;
        return { ...a, meetings, recordingMeetingId: recording };
      });
    },
    [],
  );

  useLive(
    (msg) => {
      if (msg.type === "meeting") upsert(msg.meeting);
      if (msg.type === "host_agent") {
        setAgenda((a) => (a ? { ...a, hostAgent: { ...a.hostAgent, online: msg.online, lastSeenAt: msg.lastSeenAt } } : a));
      }
    },
    [upsert],
  );

  const recording = agenda?.meetings.find((m) => m.id === agenda.recordingMeetingId);
  const isToday = date === todayIso();

  return (
    <main className="container">
      <PageHeader
        title={isToday ? "Hoje" : "Agenda"}
        description={<span className="capitalize-first">{formatLongDate(date)}</span>}
        actions={
          <>
            <div className="date-nav" role="group" aria-label="Navegar entre dias">
              <button type="button" className="icon" onClick={() => setDate(shiftDate(date, -1))} aria-label="Dia anterior">
                <ChevronLeft />
              </button>
              {!isToday && <button type="button" onClick={() => setDate(todayIso())}>Hoje</button>}
              <button type="button" className="icon" onClick={() => setDate(shiftDate(date, 1))} aria-label="Próximo dia">
                <ChevronRight />
              </button>
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Escolher data" />
            </div>
            {can("meetings.manage") && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus aria-hidden="true" /> Nova reunião
              </button>
            )}
          </>
        }
      />

      {agenda && !agenda.hostAgent.online && (
        <div className="banner warn" role="status">
          O agente do desktop não está ativo: <strong>alertas e gravação automática estão indisponíveis</strong>. Inicie
          com <code>systemctl --user start agente-host</code> (instalação: <code>apps/host-agent/install.sh</code>).
        </div>
      )}
      {recording && (
        <div className="banner error row" role="status">
          <span className="badge live">Gravando</span>
          <Link to={`/reunioes/${recording.id}`}>{recording.title}</Link>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="grid-main-aside">
        <section className="card">
          <CardHead
            title="Reuniões do dia"
            icon={CalendarDays}
            actions={agenda && agenda.meetings.length > 0 ? <span className="badge">{agenda.meetings.length}</span> : undefined}
          />
          {!agenda ? (
            error ? null : <SkeletonLines lines={4} />
          ) : agenda.meetings.length === 0 ? (
            <EmptyState icon={Inbox} title="Nenhuma reunião neste dia">
              Importe um convite .ics ou cadastre a reunião manualmente.
            </EmptyState>
          ) : (
            <ul className="agenda">
              {agenda.meetings.map((m) => (
                <AgendaItem
                  key={m.id}
                  meeting={m}
                  onChange={upsert}
                  hostAgentOnline={agenda.hostAgent.online}
                  onEdit={(meeting) => {
                    setEditing(meeting);
                    setFormOpen(true);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <aside className="stack" style={{ gap: 24 }}>
          {can("meetings.manage") && <section className="card">
            <CardHead title="Importar convites" icon={Upload} />
            <ImportIcs onImported={load} />
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              No Outlook: abra o convite → <em>Salvar como</em> / baixe o anexo <code>.ics</code>. Nada é lido do seu
              e-mail ou calendário corporativo.
            </p>
          </section>}
          {agenda && (
            <section className="card">
              <CardHead title="Agente do desktop" icon={MonitorSmartphone} />
              <div className="row">
                <span className={`badge ${agenda.hostAgent.online ? "ok" : "warn"}`}>
                  {agenda.hostAgent.online ? "Ativo" : "Offline"}
                </span>
                <span className="small muted">
                  {agenda.hostAgent.online ? "Alertas e gravação automática disponíveis." : "Sem alertas nem gravação automática."}
                </span>
              </div>
            </section>
          )}
        </aside>
      </div>

      <MeetingForm
        open={formOpen}
        meeting={editing}
        projects={projects}
        onClose={() => setFormOpen(false)}
        onSaved={(m) => {
          upsert(m);
          if (dayOf(m) !== date) setDate(dayOf(m));
        }}
      />
    </main>
  );
}
