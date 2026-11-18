import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Bot, FileAudio, Inbox, ListVideo } from "lucide-react";
import type { IdentityChoice, MeResponse, MeetingListItem, MeetingSummary } from "@meeting-bot/contracts";
import { api, errorMessage, ignoreError } from "../api";
import { sendBot } from "../bot";
import { BotIdentityField } from "../components/BotIdentityField";
import { useToast } from "../components/Toast";
import { ShareBadge } from "../components/ShareBadge";
import { StatusBadge } from "../components/StatusBadge";
import { CardHead, EmptyState, PageHeader, SkeletonLines } from "../components/ui";
import { formatDateTime, recurrenceLabel } from "../format";
import { useLive, useProjects } from "../hooks";
import { live } from "../live";
import { applyAccessEvent, applySummary, scopeOf, SCOPES } from "../shares";
import { EXTERNAL_ASR_WARNING, useCan, useSession } from "../session";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "scheduled,skipped,missed,cancelled", label: "Agenda" },
  { value: "recording,stopping,joining,waiting_admission,in_call", label: "Em andamento" },
  { value: "queued,transcribing,generating_ata", label: "Processando" },
  { value: "done", label: "Concluídas" },
  { value: "error", label: "Com erro" },
];

const SOURCE_LABEL: Record<string, string> = { bot: "Bot", upload: "Arquivo", ics: "Convite", manual: "Manual" };
const PAGE = 50;

function when(m: MeetingSummary): string {
  return m.startedAt ?? m.scheduledStart ?? m.createdAt;
}

export function Reunioes() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("projeto") ?? "";
  const status = params.get("status") ?? "";
  const scopeKey = params.get("escopo") ?? "";
  const scope = scopeOf(scopeKey);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const { projects } = useProjects();
  const can = useCan();
  const { user } = useSession();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const unseen = useUnseenShared();
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    (before?: string) => {
      const q = new URLSearchParams({ limit: String(PAGE), scope });
      if (projectId) q.set("projectId", projectId);
      if (status) q.set("status", status);
      if (before) q.set("before", before);
      api<{ meetings: MeetingListItem[] }>(`/meetings?${q}`)
        .then((r) => {
          setMeetings((prev) => (before && prev ? [...prev, ...r.meetings] : r.meetings));
          setMore(r.meetings.length === PAGE);
          setError("");
        })
        .catch((err) => setError(errorMessage(err)));
    },
    [projectId, status, scope],
  );

  useEffect(() => load(), [load]);
  useEffect(() => live.subscribe({ topic: "agenda" }), []);
  useEffect(() => live.onReconnect(() => load()), [load]);
  useLive(
    (msg) => {
      if (msg.type === "meeting") {
        // O resumo difundido é igual para todos: access, ownerName, shareCount e shareUnseen vêm do item que já temos.
        const out = applySummary(meetingsRef.current, msg.meeting, user.username, { projectId, status, scope });
        if (out.reload) load();
        else setMeetings(out.list);
      } else if (msg.type === "meeting_access") {
        setMeetings((list) => applyAccessEvent(list, msg, { projectId, status, scope }));
      }
    },
    [projectId, status, scope, user.username, load],
  );

  return (
    <main className="container">
      <PageHeader
        title="Reuniões"
        description="Histórico, bot convidado e transcrição de arquivos."
      />

      {can("meetings.manage") && (
        <div className="grid-2">
          <BotForm onOpen={(id) => navigate(`/reunioes/${id}`)} />
          <UploadForm onCreated={(m) => navigate(`/reunioes/${m.id}`)} />
        </div>
      )}

      <section className="card flush">
        <div className="card-head">
          <h2>
            <ListVideo size={16} /> Reuniões
          </h2>
          <div className="row">
            <label className="sr-only" htmlFor="filtro-status">Status</label>
            <select id="filtro-status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.value ? f.label : "Todos os status"}</option>
              ))}
            </select>
            <label className="sr-only" htmlFor="filtro-projeto">Projeto</label>
            <select id="filtro-projeto" value={projectId} onChange={(e) => setFilter("projeto", e.target.value)}>
              <option value="">Todos os projetos</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="scope-tabs" role="group" aria-label="Quais reuniões mostrar">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={scopeKey === s.key}
              onClick={() => setFilter("escopo", s.key)}
            >
              {s.label}
              {s.scope === "shared" && unseen > 0 && <span className="badge primary small" aria-label={`${unseen} nova(s)`}>{unseen}</span>}
            </button>
          ))}
        </div>
        {error && <div className="banner error" style={{ margin: "12px 20px 0" }}>{error}</div>}
        {!meetings ? (
          error ? null : (
            <div style={{ padding: "8px 20px 20px" }}>
              <SkeletonLines lines={5} />
            </div>
          )
        ) : meetings.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState icon={Inbox} title={projectId || status || scope !== "all" ? "Nenhuma reunião com estes filtros" : "Nenhuma reunião ainda"}>
              {projectId || status || scope !== "all"
                ? "Troque os filtros para ver outras reuniões."
                : "Envie o bot para uma reunião, transcreva um arquivo ou importe convites na tela Hoje."}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="simple">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Reunião</th>
                  <th className="hide-sm">Projeto</th>
                  <th className="hide-sm">Origem</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.id}>
                    <td className="tabular" style={{ whiteSpace: "nowrap" }}>{formatDateTime(when(m))}</td>
                    <td>
                      <Link className="cell-title" to={`/reunioes/${m.id}`}>{m.title}</Link>
                      <span className="share-badges">
                        <ShareBadge access={m.access} ownerName={m.ownerName} shareCount={m.shareCount} shareUnseen={m.shareUnseen} />
                      </span>
                      {m.recurrence && (
                        <span className="badge small" title="Reunião recorrente" style={{ marginLeft: 6 }}>
                          {recurrenceLabel(m.recurrence)}
                        </span>
                      )}
                    </td>
                    <td className="hide-sm">{m.project?.name ?? <span className="muted">—</span>}</td>
                    <td className="hide-sm muted">{SOURCE_LABEL[m.source] ?? m.source}</td>
                    <td><StatusBadge status={m.status} label={m.statusLabel} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && meetings && (
          <div className="table-foot">
            <span className="small muted">{meetings.length} reuniões carregadas</span>
            <button type="button" className="small" onClick={() => load(when(meetings[meetings.length - 1]))}>
              Carregar mais
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

/** Quantas reuniões compartilhadas ainda estão marcadas como "Nova" (contador da aba). */
function useUnseenShared(): number {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    api<{ meetings: MeetingListItem[] }>("/meetings?scope=shared&limit=200")
      .then((r) => setCount(r.meetings.filter((m) => m.shareUnseen).length))
      .catch(ignoreError);
  }, []);
  useEffect(load, [load]);
  useEffect(() => live.onReconnect(load), [load]);
  useLive((msg) => msg.type === "meeting_access" && load(), [load]);
  return count;
}

function BotForm({ onOpen }: { onOpen: (meetingId: string) => void }) {
  const toast = useToast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityChoice>({ mode: "agent" });
  const submitting = useRef(false);

  useEffect(() => {
    api<MeResponse>("/me")
      .then((me) =>
        setIdentity({
          mode: me.settings.meetings.displayIdentity,
          customName: me.settings.meetings.customDisplayName ?? undefined,
        }),
      )
      .catch(() => {});
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const result = await sendBot({
        url: String(data.get("url") ?? ""),
        title: String(data.get("title") ?? ""),
        identity,
      });
      if (result.kind === "created") {
        form.reset();
        onOpen(result.meeting.id);
      } else if (result.meetingId) {
        toast("O bot já está nessa reunião. Abrindo o acompanhamento.");
        onOpen(result.meetingId);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit} aria-busy={busy}>
      <CardHead title="Modo Agente (assistente convidado)" icon={Bot} />
      <label>
        Link do Google Meet ou Teams
        <input name="url" type="url" placeholder="https://meet.google.com/abc-defg-hij" required />
      </label>
      <label>
        Título
        <input name="title" maxLength={200} placeholder="Ex.: Reunião com cliente" />
      </label>
      <BotIdentityField idPrefix="bot" value={identity} onChange={setIdentity} />
      <p className="small muted">
        O assistente entra como convidado, sem câmera e sem microfone. Se houver sala de espera, admita-o na reunião.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Preparando agente…" : "Enviar assistente"}</button>
    </form>
  );
}

function UploadForm({ onCreated }: { onCreated: (m: MeetingSummary) => void }) {
  const { asr } = useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState(asr.external?.isDefault ? "openrouter" : "local");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError("");
    try {
      const m = await api<MeetingSummary>("/meetings/upload", { method: "POST", form: new FormData(form) });
      form.reset();
      onCreated(m);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <CardHead title="Transcrever arquivo" icon={FileAudio} />
      <label>
        Áudio ou vídeo da reunião
        <input name="audio" type="file" accept="audio/*,video/*" required />
      </label>
      <label>
        Título
        <input name="title" maxLength={200} placeholder="Opcional" />
      </label>
      {asr.external && (
        <label>
          Transcrição
          <select name="asr" value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="local">Whisper local</option>
            <option value="openrouter" disabled={!asr.external.available}>
              {asr.external.model} via OpenRouter (externo){asr.external.available ? "" : " — falta OPENROUTER_API_KEY"}
            </option>
          </select>
        </label>
      )}
      {engine === "openrouter" && <p className="banner warn small">{EXTERNAL_ASR_WARNING}</p>}
      <p className="small muted">O arquivo fica guardado e passa pela mesma transcrição e análise das reuniões gravadas.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Enviando…" : "Enviar arquivo"}</button>
    </form>
  );
}
