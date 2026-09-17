import type { MeetingStatus } from "@meeting-bot/contracts";

// Regras do controle de gravação (research.md R12) como função pura.

export interface SchedMeeting {
  id: string;
  status: MeetingStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  skipRecording: boolean;
  startedAt: Date | null;
  stopRequested: boolean;
  lastSpeechAt: Date | null;
}

export interface SchedulerState {
  meetings: SchedMeeting[];
  hostAgentOnline: boolean;
  hostAgentLastSeen: Date | null;
}

export type StopReason = "manual" | "silence" | "max_duration" | "agent_offline";

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  manual: "Parada pelo usuário",
  silence: "Sem fala depois do horário previsto",
  max_duration: "Limite de duração atingido",
  agent_offline: "Agente do desktop desconectado",
};

export type SchedulerAction =
  | { kind: "start"; meetingId: string }
  | { kind: "stop"; meetingId: string; reason: StopReason }
  | { kind: "missed"; meetingId: string };

export interface DecideOptions {
  maxRecordingMs: number;
  silenceStopMs: number;
  agentGoneMs: number;
}

export const DEFAULT_DECIDE_OPTIONS: DecideOptions = {
  maxRecordingMs: 4 * 3600_000,
  silenceStopMs: 180_000,
  agentGoneMs: 5 * 60_000,
};

function stopReason(now: number, m: SchedMeeting, state: SchedulerState, opts: DecideOptions): StopReason | null {
  if (m.stopRequested) return "manual";
  const started = (m.startedAt ?? new Date(now)).getTime();
  if (now - started >= opts.maxRecordingMs) return "max_duration";
  if (now < m.scheduledEnd.getTime()) return null;
  // Depois do fim previsto: silêncio contado desde a última fala (ou desde o início, o que
  // garante o mínimo de 3 min gravando).
  const lastSpeech = Math.max(started, m.lastSpeechAt?.getTime() ?? 0);
  if (now - lastSpeech >= opts.silenceStopMs) return "silence";
  const lastSeen = state.hostAgentLastSeen?.getTime() ?? started;
  if (!state.hostAgentOnline && now - Math.max(lastSeen, started) >= opts.agentGoneMs) return "agent_offline";
  return null;
}

export function decide(
  now: Date,
  state: SchedulerState,
  opts: DecideOptions = DEFAULT_DECIDE_OPTIONS,
): SchedulerAction[] {
  const t = now.getTime();
  const actions: SchedulerAction[] = [];

  let busy = false;
  for (const m of state.meetings) {
    if (m.status === "stopping") busy = true;
    if (m.status !== "recording") continue;
    const reason = stopReason(t, m, state, opts);
    if (reason) actions.push({ kind: "stop", meetingId: m.id, reason });
    else busy = true;
  }

  for (const m of state.meetings) {
    if (m.status === "scheduled" && m.scheduledEnd.getTime() <= t) {
      actions.push({ kind: "missed", meetingId: m.id });
    }
  }

  // Uma gravação por vez; quem para neste ciclo só libera a vez no próximo (depois de `stopping`).
  const stopping = actions.some((a) => a.kind === "stop");
  if (busy || stopping || !state.hostAgentOnline) return actions;

  const candidate = state.meetings
    .filter(
      (m) =>
        m.status === "scheduled" &&
        !m.skipRecording &&
        m.scheduledStart.getTime() <= t &&
        t < m.scheduledEnd.getTime(),
    )
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.id.localeCompare(b.id))[0];
  if (candidate) actions.push({ kind: "start", meetingId: candidate.id });
  return actions;
}

// Reuniões que deveriam estar gravando mas esperam outra terminar (FR-013).
export function conflicts(now: Date, state: SchedulerState): string[] {
  const t = now.getTime();
  const active = state.meetings.some((m) => m.status === "recording" || m.status === "stopping");
  if (!active) return [];
  return state.meetings
    .filter(
      (m) =>
        m.status === "scheduled" &&
        !m.skipRecording &&
        m.scheduledStart.getTime() <= t &&
        t < m.scheduledEnd.getTime(),
    )
    .map((m) => m.id);
}
