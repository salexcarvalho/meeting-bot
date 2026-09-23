import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Bot, Circle, ExternalLink, ListChecks, Pencil, RefreshCw, Sparkles, Square, Trash2 } from "lucide-react";
import {
  IDLE_STATUSES,
  type Adr,
  type Channel,
  type GpuStats,
  type Item,
  type LlmChoice,
  type MeetingDetail,
  type MeetingSummary,
  type RecordingEvent,
  type Segment,
} from "@meeting-bot/contracts";
import { api, ApiError, errorMessage } from "../api";
import { AdrList } from "../components/AdrList";
import { AtaView } from "../components/AtaView";
import { AudioPlayers, type AudioPlayersHandle } from "../components/AudioPlayers";
import { ItemsBoard, type ItemFocus } from "../components/ItemsBoard";
import { Speakers } from "../components/Speakers";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { LivePanel, type ProcessingState } from "../components/LivePanel";
import { MeetingForm } from "../components/MeetingForm";
import { Markdown } from "../components/Markdown";
import { StatusBadge } from "../components/StatusBadge";
import { useToast } from "../components/Toast";
import { Transcript } from "../components/Transcript";
import { BotProgress } from "../components/BotProgress";
import {
  defaultChoice,
  GenerateDialog,
  llmChoiceOptions,
  useLlmOptions,
  type GenerateRequest,
} from "../components/GenerateDialog";
import { sendBot } from "../bot";
import { SkeletonLines } from "../components/ui";
import { formatDateTime, formatTime, minutesBetween } from "../format";
import { useLive, useProjects } from "../hooks";
import { live } from "../live";
import {
  asrLabel,
  EXTERNAL_ASR_WARNING,
  generationWarning,
  isExternal,
  llmLabel,
  useCan,
  useSession,
} from "../session";

type Tab = "transcricao" | "itens" | "ata" | "adrs" | "audio";

type Generation = { kind: "ata" } | { kind: "itens" } | { kind: "adrs" } | { kind: "adr"; item: Item };

const GENERATION_TEXT: Record<Generation["kind"], GenerateRequest> = {
  itens: {
    title: "Gerar itens",
    message:
      "Liga os itens desta reunião e refaz a análise sobre a transcrição final: decisões, pendências, riscos, requisitos, resumo, ata e ADRs sugeridos. Tudo nasce como proposto.",
    confirmLabel: "Gerar itens",
    scope: "ata",
  },
  ata: {
    title: "Gerar ata",
    message: "Refaz a análise sobre a transcrição final: itens, resumo, ata e ADRs sugeridos. Itens e ADRs já revisados são mantidos.",
    confirmLabel: "Gerar ata",
    scope: "ata",
  },
  adrs: {
    title: "Gerar ADRs",
    message: "Gera um ADR sugerido para cada decisão arquitetural não rejeitada. ADRs aprovados, rejeitados ou editados à mão ficam como estão.",
    confirmLabel: "Gerar ADRs",
    scope: "adr",
  },
  adr: {
    title: "Gerar ADR",
    message: "Gera (ou refaz) o ADR sugerido desta decisão arquitetural.",
    confirmLabel: "Gerar ADR",
    scope: "adr",
  },
};

const PROCESSING_STATUSES = ["queued", "transcribing", "generating_ata"];
const RECORDING_STATUSES = ["recording", "stopping"];
// transcrição ao vivo: gravação no PC ou assistente dentro da chamada
const LIVE_STATUSES = [...RECORDING_STATUSES, "in_call"];

const WAITING_TEXT: Partial<Record<string, string>> = {
  scheduled: "No horário, o assistente entra na chamada e grava de dentro dela.",
  skipped: "Esta reunião foi marcada para não ser gravada.",
  missed: "A reunião não foi gravada.",
  cancelled: "Reunião cancelada.",
  joining: "O assistente está entrando na reunião…",
  waiting_admission: "O assistente está na sala de espera. Admita-o na reunião.",
  in_call: "O assistente está gravando. A ata é gerada quando a reunião terminar.",
  recording: "Gravando. A ata é gerada quando a reunião terminar.",
  stopping: "Finalizando a gravação…",
  queued: "Aguardando a vez para a transcrição final…",
  transcribing: "Transcrição final em andamento…",
  generating_ata: "Gerando a ata…",
};

// Sem link do Teams/Meet o assistente não tem onde entrar, e o PC não grava sozinho.
function waitingText(m: MeetingSummary): string | undefined {
  if (m.status === "scheduled" && !m.url) return "Sem link do Teams/Meet: nada é gravado sozinho. Use Gravar agora se precisar.";
  return WAITING_TEXT[m.status];
}

export function Reuniao() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("transcricao");
  const [itemFocus, setItemFocus] = useState<ItemFocus | null>(null);
  const [recording, setRecording] = useState<RecordingEvent | null>(null);
  const [processing, setProcessing] = useState<ProcessingState | null>(null);
  const [gpu, setGpu] = useState<GpuStats | null>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "reprocess" | "stop">(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const { asr } = useSession();
  const llm = useLlmOptions(id, confirm === "reprocess");
  const can = useCan();
  const resending = useRef(false);
  // Conta os fins de processamento: sem GPU a falha pode chegar antes da resposta do pedido.
  const finishedRuns = useRef(0);
  const [reprocessAsr, setReprocessAsr] = useState("local");
  const [reprocessLlm, setReprocessLlm] = useState<LlmChoice>("local");
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [adrs, setAdrs] = useState<Adr[]>([]);
  const [highlight, setHighlight] = useState<Set<number>>(new Set());
  const [ataVersion, setAtaVersion] = useState(0);
  const { projects } = useProjects();
  const players = useRef<AudioPlayersHandle>(null);

  const load = useCallback(() => {
    api<{ items: Item[] }>(`/meetings/${id}/items`).then((r) => setItems(r.items)).catch(() => {});
    api<{ adrs: Adr[] }>(`/meetings/${id}/adrs`).then((r) => setAdrs(r.adrs)).catch(() => {});
    setAtaVersion((v) => v + 1);
    api<MeetingDetail>(`/meetings/${id}`)
      .then((d) => {
        setDetail(d);
        setError("");
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? "Reunião não encontrada." : errorMessage(err)));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setItems([]);
    setAdrs([]);
    setRecording(null);
    setProcessing(null);
    load();
  }, [load]);
  useEffect(() => live.subscribe({ topic: "meeting", meetingId: id }), [id]);
  useEffect(() => live.onReconnect(load), [load]);

  const setMeeting = useCallback((meeting: MeetingSummary) => {
    setDetail((d) => {
      if (!d) return d;
      // Mudou de fase (ex.: gravação → transcrição): recarrega áudio e segmentos.
      if (d.meeting.status !== meeting.status && ["queued", "done", "error"].includes(meeting.status)) load();
      return { ...d, meeting };
    });
  }, [load]);

  useLive(
    (msg) => {
      switch (msg.type) {
        case "meeting":
          if (msg.meeting.id === id) setMeeting(msg.meeting);
          break;
        case "segments":
          if (msg.meetingId !== id) break;
          setDetail((d) => {
            if (!d) return d;
            if (msg.pass === "live" && d.segments.some((s) => s.pass === "final")) return d;
            const known = new Set(d.segments.map((s) => s.id));
            const fresh = msg.segments.filter((s) => !known.has(s.id));
            const segments: Segment[] = [...d.segments, ...fresh].sort((a, b) => a.start - b.start || a.id - b.id);
            return { ...d, segments };
          });
          break;
        case "transcript_replaced":
          if (msg.meetingId === id) load();
          break;
        case "recording":
          if (msg.meetingId === id) setRecording(msg);
          break;
        case "processing":
          if (msg.meetingId !== id) break;
          setProcessing(msg.step ? { step: msg.step, progress: msg.progress } : null);
          if (!msg.step) finishedRuns.current++;
          if (!msg.step && msg.error) toast(msg.error, "error");
          if (!msg.step && msg.done) {
            toast(msg.done);
            load();
          }
          break;
        case "items":
          if (msg.meetingId !== id) break;
          setItems((list) => {
            const byId = new Map(list.map((i) => [i.id, i]));
            for (const item of msg.items) byId.set(item.id, item);
            return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
          setAtaVersion((v) => v + 1);
          break;
        case "items_removed":
          if (msg.meetingId === id) setItems((list) => list.filter((i) => !msg.ids.includes(i.id)));
          break;
        case "adrs":
          if (msg.meetingId !== id) break;
          setAdrs((list) => {
            const byId = new Map(list.map((a) => [a.id, a]));
            for (const adr of msg.adrs) byId.set(adr.id, adr);
            return [...byId.values()];
          });
          setAtaVersion((v) => v + 1);
          break;
        case "summary":
          if (msg.meetingId === id) setDetail((d) => (d ? { ...d, liveSummary: msg.text, liveSummaryAt: msg.at } : d));
          break;
        case "bot":
          if (msg.meetingId === id) {
            setDetail((d) => (d ? { ...d, meeting: { ...d.meeting, botProgress: msg.progress } } : d));
          }
          break;
        case "gpu":
          setGpu({ utilization: msg.utilization, memoryUsedMb: msg.memoryUsedMb, memoryTotalMb: msg.memoryTotalMb, name: msg.name });
          break;
      }
    },
    [id, load, setMeeting, toast],
  );

  async function action(path: string, body: unknown, message: string | (() => string | null), method = "POST") {
    setBusy(true);
    try {
      const result = await api<MeetingSummary | { status: string } | undefined>(path, { method, json: body });
      if (result && "id" in result) setMeeting(result);
      const text = typeof message === "function" ? message() : message;
      if (text) toast(text);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <main className="container">
        <BackLink />
        <div className="banner error">{error}</div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="container">
        <BackLink />
        <section className="card">
          <SkeletonLines lines={3} />
        </section>
      </main>
    );
  }

  const m = detail.meeting;
  const isLive = LIVE_STATUSES.includes(m.status);
  const local = m.source === "ics" || m.source === "manual";
  const idle = IDLE_STATUSES.includes(m.status) && !m.botActive;
  const hasAudio = detail.audio.some((a) => a.format !== "pcm_s16le_16k");
  const showPanel = RECORDING_STATUSES.includes(m.status) || PROCESSING_STATUSES.includes(m.status) || Boolean(processing?.step);
  const duration = m.startedAt ? minutesBetween(m.startedAt, m.endedAt ?? new Date().toISOString()) : null;
  const seek = hasAudio ? (channel: Segment["channel"], t: number) => players.current?.seek(channel, t) : undefined;
  const activeItems = items.filter((i) => i.reviewStatus !== "rejeitado").length;
  const writable = detail.access !== "read" && can("meetings.manage");
  // gravar, parar, reenviar, reprocessar e editar a agenda são do dono (o backend confere igual)
  const ownerActions = detail.access === "owner" && can("meetings.manage");
  const hasFinal = detail.segments.some((s) => s.pass === "final");
  const reprocessOptions = llmChoiceOptions(llm);
  const reprocessWarning = generationWarning(reprocessLlm, "ata");
  const readyToGenerate =
    ownerActions && can("documents.generate") && ["done", "error"].includes(m.status) && !m.botActive && !processing?.step;
  const canGenerateAta = readyToGenerate && (hasFinal || hasAudio);
  const canGenerateAdrs = readyToGenerate && hasFinal;
  const archDecisions = items.filter((i) => i.type === "decisao_arquitetural" && i.reviewStatus !== "rejeitado").length;
  const onGenerateAdr = canGenerateAdrs ? (item: Item) => setGeneration({ kind: "adr", item }) : undefined;
  const generationRequest: GenerateRequest | null = !generation
    ? null
    : generation.kind === "ata" && !m.itemsEnabled
      ? {
          ...GENERATION_TEXT.ata,
          message:
            "Refaz o resumo e a ata sobre a transcrição final. Esta reunião não gera itens (decisões, pendências, riscos e ADRs); para incluí-los, use “Gerar itens”.",
        }
      : GENERATION_TEXT[generation.kind];

  async function toggleItems() {
    if (m.itemsEnabled) {
      await action(
        `/meetings/${m.id}/extract-items`,
        { enabled: false },
        "Itens desligados. O que já foi gerado continua; nada novo será criado.",
        "PUT",
      );
    } else if (readyToGenerate && hasFinal) {
      // reunião pronta: escolhe onde gerar e já roda a análise com os itens
      setGeneration({ kind: "itens" });
    } else {
      await action(
        `/meetings/${m.id}/extract-items`,
        { enabled: true },
        "Itens ligados: serão gerados ao vivo e na análise final.",
        "PUT",
      );
    }
  }
  const canDelete = detail.access === "owner" && can("meetings.manage") && can("transcripts.delete");
  const showBotProgress = Boolean(m.botProgress) || (m.botActive && m.status === "in_call");
  // Reunião da agenda com link: quem grava é o assistente (o PC só com "Gravar agora", sem link).
  const canSendAssistant =
    ownerActions && local && Boolean(m.url) && !m.botActive &&
    (["scheduled", "skipped", "missed"].includes(m.status) || (m.status === "error" && !hasAudio));

  async function resendBot() {
    if (resending.current || !m.url) return;
    resending.current = true;
    setBusy(true);
    try {
      const result = await sendBot({ url: m.url, title: m.title });
      if (result.kind === "created") navigate(`/reunioes/${result.meeting.id}`);
      else if (result.meetingId) navigate(`/reunioes/${result.meetingId}`);
      else toast(result.message, "error");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      resending.current = false;
      setBusy(false);
    }
  }

  function upsertItem(item: Item) {
    setItems((list) => (list.some((i) => i.id === item.id) ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item]));
    setAtaVersion((v) => v + 1);
  }

  function upsertAdr(adr: Adr) {
    setAdrs((list) => list.map((a) => (a.id === adr.id ? adr : a)));
    setAtaVersion((v) => v + 1);
  }

  // Evidência → destaca o segmento (ou o mais próximo no tempo) e toca o áudio.
  function showEvidence(segmentId: number | null, channel: Channel, start: number) {
    const segments = detail!.segments;
    let target = segmentId !== null && segments.some((s) => s.id === segmentId) ? segmentId : null;
    if (target === null && segments.length) {
      const pool = segments.filter((s) => s.channel === channel);
      const nearest = (pool.length ? pool : segments).reduce((a, b) =>
        Math.abs(b.start - start) < Math.abs(a.start - start) ? b : a,
      );
      target = nearest.id;
    }
    setHighlight(new Set(target !== null ? [target] : []));
    if (!isLive) setTab("transcricao");
    if (seek) setTimeout(() => seek(channel, start), 50);
  }

  return (
    <main className="container">
      <BackLink />
      <section className="card">
        <div className="meeting-header">
          <div style={{ minWidth: 0 }}>
            <h1 style={{ marginBottom: 8 }}>{m.title}</h1>
            <div className="row small muted">
              <StatusBadge status={m.status} label={m.statusLabel} />
              {m.scheduledStart && <span>{formatDateTime(m.scheduledStart)}{m.scheduledEnd ? `–${formatTime(m.scheduledEnd)}` : ""}</span>}
              {!m.scheduledStart && <span>{formatDateTime(m.startedAt ?? m.createdAt)}</span>}
              {duration !== null && !isLive && <span>{duration} min gravados</span>}
              {m.project && <span className="badge">{m.project.name}{m.project.suggested ? " (sugerido)" : ""}</span>}
              {m.organizer && <span>org.: {m.organizer}</span>}
              {m.createdBy && <span>por {m.createdBy}</span>}
              {detail.access !== "owner" && (
                <span className="badge info">{detail.access === "read" ? "Compartilhada · somente leitura" : "Compartilhada · edição"}</span>
              )}
              {m.botDisplayName && <span title="Nome do assistente na reunião">assistente: {m.botDisplayName}</span>}
            </div>
            {m.attendees.length > 0 && (
              <details className="small" style={{ marginTop: 6 }}>
                <summary>{m.attendees.length} participante(s)</summary>
                <p className="muted">{m.attendees.map((a) => a.name || a.email).join(", ")}</p>
              </details>
            )}
            {m.errorMessage && <p className="error-text">{m.errorMessage}</p>}
          </div>
          <div className="row">
            {m.url && !idle && m.status !== "done" && (
              <a className="button primary" href={m.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" /> Entrar
              </a>
            )}
            {canSendAssistant && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => action(`/meetings/${m.id}/assistant`, undefined, "Assistente a caminho da reunião.")}
              >
                <Bot aria-hidden="true" /> {m.status === "error" ? "Enviar assistente de novo" : "Enviar assistente agora"}
              </button>
            )}
            {ownerActions && local && !m.url && ["scheduled", "skipped", "missed"].includes(m.status) && (
              <button type="button" className="primary" disabled={busy} onClick={() => action(`/meetings/${m.id}/record`, undefined, "Gravação iniciada.")}>
                <Circle aria-hidden="true" /> Gravar agora
              </button>
            )}
            {ownerActions && (m.status === "recording" || (m.botActive && m.status !== "stopping")) && (
              <button type="button" className="danger solid" disabled={busy} onClick={() => setConfirm("stop")}>
                <Square aria-hidden="true" /> Parar
              </button>
            )}
            {ownerActions && m.source === "bot" && m.status === "error" && m.url && !hasAudio && (
              <button type="button" className="primary" disabled={busy} onClick={() => void resendBot()}>
                {busy ? "Preparando agente…" : "Enviar assistente de novo"}
              </button>
            )}
            {ownerActions && ["done", "error"].includes(m.status) && hasAudio && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReprocessAsr(detail.asrProvider ?? (asr.external?.isDefault ? "openrouter" : "local"));
                  setReprocessLlm(defaultChoice(llm));
                  setConfirm("reprocess");
                }}
              >
                <RefreshCw aria-hidden="true" /> Reprocessar
              </button>
            )}
            {ownerActions && (
              <button type="button" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" /> Editar
              </button>
            )}
            {canDelete && idle && (
              <button type="button" className="danger" disabled={busy} onClick={() => setConfirm("delete")}>
                <Trash2 aria-hidden="true" /> Excluir
              </button>
            )}
          </div>
        </div>
      </section>

      {detail.transcriptionProvider?.startsWith("openrouter:") && (
        <div className="banner warn" role="note">
          Transcrição final feita por {asrLabel(detail.transcriptionProvider)}: o áudio foi enviado para fora da máquina.
        </div>
      )}
      {!detail.transcriptionProvider && detail.asrProvider === "openrouter" && PROCESSING_STATUSES.includes(m.status) && (
        <div className="banner warn" role="note">{EXTERNAL_ASR_WARNING}</div>
      )}
      {showBotProgress && <BotProgress progress={m.botProgress} status={m.status} />}
      {showPanel && <LivePanel meeting={m} recording={recording} processing={processing} gpu={gpu} />}

      <ItemsSwitch
        enabled={m.itemsEnabled}
        hasItems={items.length > 0}
        canEdit={ownerActions}
        busy={busy || PROCESSING_STATUSES.includes(m.status)}
        onToggle={() => void toggleItems()}
      />

      <div className="tabs" role="tablist">
        {([
          ["transcricao", isLive ? "Ao vivo" : "Transcrição"],
          ...(isLive ? [] : [["itens", `Itens (${activeItems})`]]),
          ["ata", "Ata"],
          ["adrs", `ADRs${adrs.length ? ` (${adrs.length})` : ""}`],
          ["audio", "Áudio e debug"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "transcricao" && (
        <div className={isLive ? "live-layout" : "grid-transcript"}>
          <section className="card">
            <h2>{detail.segments.some((s) => s.pass === "final") ? "Transcrição final" : "Transcrição ao vivo"}</h2>
            {hasAudio && (
              <div style={{ marginBottom: 12 }}>
                <AudioPlayers ref={players} meetingId={m.id} audio={detail.audio} version={m.status} />
              </div>
            )}
            <Transcript
              segments={detail.segments}
              follow={isLive}
              full={!isLive}
              onSeek={seek}
              highlight={highlight}
              emptyText={isLive ? "Aguardando fala… o texto aparece alguns segundos depois." : waitingText(m) ?? "Sem transcrição."}
            />
          </section>
          {isLive ? (
            <div className="aside-stack">
              <section className="card">
                <h2>Resumo corrente</h2>
                {detail.liveSummary ? (
                  <>
                    <Markdown source={detail.liveSummary} />
                    <p className="small muted">atualizado às {formatTime(detail.liveSummaryAt)}</p>
                  </>
                ) : (
                  <p className="muted">
                    {m.itemsEnabled
                      ? "O agente arquiteto resume a reunião periodicamente."
                      : "Sem resumo ao vivo: os itens estão desligados. A ata sai só com o resumo, depois da reunião."}
                  </p>
                )}
              </section>
              <ItemsBoard
                meetingId={m.id}
                items={items}
                readOnly={!writable}
                onChange={upsertItem}
                onEvidence={showEvidence}
                onGenerateAdr={onGenerateAdr}
              />
            </div>
          ) : (
            <aside className="aside-stack">
              <section className="card">
                <h2>Falantes</h2>
                <Speakers meetingId={m.id} speakers={detail.speakers} readOnly={!writable} onRenamed={load} />
              </section>
              {detail.liveSummary && (
                <section className="card">
                  <h2>Resumo</h2>
                  <Markdown source={detail.liveSummary} />
                </section>
              )}
            </aside>
          )}
        </div>
      )}

      {tab === "itens" && (
        <ItemsBoard
          meetingId={m.id}
          items={items}
          readOnly={!writable}
          onChange={upsertItem}
          onEvidence={showEvidence}
          onGenerateAdr={onGenerateAdr}
          focus={itemFocus}
        />
      )}

      {tab === "ata" && (
        <section className="card">
          <AtaView
            meetingId={m.id}
            version={`${m.status}:${ataVersion}`}
            waitingText={waitingText(m) ?? (m.status === "error" ? "A ata não foi gerada. Use Reprocessar." : "A ata ainda não foi gerada.")}
            provider={detail.analysisProvider}
            generate={canGenerateAta ? { label: "Gerar ata", onClick: () => setGeneration({ kind: "ata" }) } : null}
          />
        </section>
      )}

      {tab === "adrs" && (
        <section className="card">
          <GenerationBar
            provider={null}
            providerText=""
            action={
              canGenerateAdrs && archDecisions > 0
                ? { label: `Gerar ADRs (${archDecisions})`, onClick: () => setGeneration({ kind: "adrs" }) }
                : null
            }
          />
          <AdrList
            adrs={adrs}
            items={items}
            readOnly={!writable}
            onChange={upsertAdr}
            onShowItem={(itemId) => {
              setTab("itens");
              setItemFocus({ id: itemId, seq: Date.now() });
            }}
          />
        </section>
      )}

      {tab === "audio" && (
        <section className="card">
          <h2>Áudio gravado</h2>
          <AudioPlayers ref={players} meetingId={m.id} audio={detail.audio} version={m.status} />
          {(m.source === "bot" || detail.hasScreenshot) && (
            <>
              <h3 style={{ marginTop: 16 }}>Tela do assistente</h3>
              {detail.hasScreenshot ? (
                <img className="shot" src={`/api/meetings/${m.id}/screenshot?t=${Date.now()}`} alt="Última captura da tela do bot" />
              ) : (
                <p className="muted">Sem captura.</p>
              )}
            </>
          )}
        </section>
      )}

      <MeetingForm open={editing} meeting={m} projects={projects} onClose={() => setEditing(false)} onSaved={setMeeting} />
      <ConfirmDialog
        open={confirm === "stop"}
        title="Parar gravação?"
        message="A gravação termina agora e a transcrição final começa em seguida."
        confirmLabel="Parar"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={() => void action(`/meetings/${m.id}/end`, undefined, "Encerrando a gravação…")}
      />
      <Dialog open={confirm === "reprocess"} onClose={() => setConfirm(null)} label="Reprocessar reunião">
        <h2>Reprocessar reunião?</h2>
        <p className="muted">A transcrição final e a análise serão refeitas. Itens já aprovados são mantidos.</p>
        {asr.external && (
          <label>
            Transcrição
            <select value={reprocessAsr} onChange={(e) => setReprocessAsr(e.target.value)}>
              <option value="local">Whisper local</option>
              <option value="openrouter" disabled={!asr.external.available}>
                {asr.external.model} via OpenRouter (externo){asr.external.available ? "" : " — falta OPENROUTER_API_KEY"}
              </option>
            </select>
          </label>
        )}
        {reprocessAsr === "openrouter" && <p className="banner warn small">{EXTERNAL_ASR_WARNING}</p>}
        {reprocessOptions.length > 1 && (
          <label>
            Análise (itens, ata e ADRs)
            <select value={reprocessLlm} onChange={(e) => setReprocessLlm(e.target.value as LlmChoice)}>
              {reprocessOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={!o.available}>
                  {o.title} — {o.detail}
                </option>
              ))}
            </select>
          </label>
        )}
        {reprocessWarning && <p className="banner warn small">{reprocessWarning}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={() => setConfirm(null)}>Cancelar</button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setConfirm(null);
              const before = finishedRuns.current;
              void action(
                `/meetings/${m.id}/reprocess`,
                {
                  step: "all",
                  ...(asr.external ? { asr: reprocessAsr } : {}),
                  ...(reprocessOptions.length > 1 ? { llm: reprocessLlm } : {}),
                },
                () => (finishedRuns.current === before ? "Reunião na fila." : null),
              ).then((ok) => ok && load());
            }}
          >
            Reprocessar
          </button>
        </div>
      </Dialog>
      <GenerateDialog
        meetingId={m.id}
        request={generationRequest}
        onClose={() => setGeneration(null)}
        onConfirm={(choice) => {
          if (!generation) return;
          const before = finishedRuns.current;
          // não cobre o resultado se a geração já terminou antes da resposta
          const pending = (text: string) => () => (finishedRuns.current === before ? text : null);
          if (generation.kind === "itens") {
            void (async () => {
              // liga a chave e, se deu certo, roda a análise completa; se a análise falhar, a chave fica ligada
              if (!(await action(`/meetings/${m.id}/extract-items`, { enabled: true }, () => null, "PUT"))) return;
              const queued = await action(
                `/meetings/${m.id}/reprocess`,
                { step: "analysis", llm: choice },
                pending("Gerando itens, resumo e ata…"),
              );
              if (queued) load();
            })();
          } else if (generation.kind === "ata") {
            void action(`/meetings/${m.id}/reprocess`, { step: "analysis", llm: choice }, pending("Gerando a ata…")).then(
              (ok) => ok && load(),
            );
          } else {
            const itemId = generation.kind === "adr" ? generation.item.id : undefined;
            void action(
              `/meetings/${m.id}/adrs/generate`,
              { llm: choice, ...(itemId ? { itemId } : {}) },
              pending(itemId ? "Gerando o ADR…" : "Gerando ADRs…"),
            );
          }
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title="Excluir reunião?"
        message={`“${m.title}” será excluída com áudio, transcrição e itens. Não dá para desfazer.`}
        confirmLabel="Excluir"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          void action(`/meetings/${m.id}`, undefined, "Reunião excluída.", "DELETE").then((ok) => ok && navigate("/reunioes"))
        }
      />
    </main>
  );
}

function ItemsSwitch({
  enabled,
  hasItems,
  canEdit,
  busy,
  onToggle,
}: {
  enabled: boolean;
  hasItems: boolean;
  canEdit: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`items-switch ${enabled ? "on" : "off"}`} role="group" aria-label="Itens da reunião">
      <ListChecks aria-hidden="true" />
      <div>
        <strong>{enabled ? "Itens ligados" : "Itens desligados"}</strong>
        <span className="small muted">
          {enabled
            ? "Decisões, pendências, riscos e requisitos são gerados ao vivo e na análise final."
            : hasItems
              ? "Nada novo será gerado; o que já existe continua."
              : "Esta reunião não gera decisões, pendências, riscos nem ADRs; a ata sai só com o resumo."}
        </span>
      </div>
      {canEdit && (
        <button type="button" className={enabled ? "" : "primary"} disabled={busy} onClick={onToggle}>
          {enabled ? "Desligar itens" : "Gerar itens"}
        </button>
      )}
    </div>
  );
}

function GenerationBar({
  provider,
  providerText,
  action,
}: {
  provider: string | null;
  providerText: string;
  action: { label: string; onClick: () => void } | null;
}) {
  if (!provider && !action) return null;
  return (
    <div className="generation-bar">
      {provider ? (
        <span className={`badge ${isExternal(provider) ? "warn" : ""}`}>
          {providerText} {llmLabel(provider)}
        </span>
      ) : (
        <span />
      )}
      {action && (
        <button type="button" className="primary small" onClick={action.onClick}>
          <Sparkles aria-hidden="true" /> {action.label}
        </button>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <p style={{ marginBottom: 16 }}>
      <Link className="back-link" to="/reunioes">
        <ArrowLeft size={14} aria-hidden="true" /> Reuniões
      </Link>
    </p>
  );
}
