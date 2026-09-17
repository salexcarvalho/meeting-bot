import { describe, expect, it } from "vitest";
import { conflicts, decide, type SchedMeeting, type SchedulerState } from "../src/recording/decide";

const T0 = new Date("2026-09-16T13:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function meeting(id: string, over: Partial<SchedMeeting> = {}): SchedMeeting {
  return {
    id,
    status: "scheduled",
    scheduledStart: at(0),
    scheduledEnd: at(60),
    skipRecording: false,
    startedAt: null,
    stopRequested: false,
    lastSpeechAt: null,
    ...over,
  };
}

function state(meetings: SchedMeeting[], over: Partial<SchedulerState> = {}): SchedulerState {
  return { meetings, hostAgentOnline: true, hostAgentLastSeen: at(0), ...over };
}

const recording = (id: string, over: Partial<SchedMeeting> = {}) =>
  meeting(id, { status: "recording", startedAt: at(0), ...over });

describe("decide", () => {
  it("inicia a reunião cuja janela começou", () => {
    expect(decide(at(0), state([meeting("a")]))).toEqual([{ kind: "start", meetingId: "a" }]);
    expect(decide(at(-1), state([meeting("a")]))).toEqual([]);
  });

  it("inicia atrasado se ainda estiver na janela (volta da suspensão)", () => {
    expect(decide(at(40), state([meeting("a")]))).toEqual([{ kind: "start", meetingId: "a" }]);
  });

  it("escolhe a de início mais antigo quando duas estão na janela", () => {
    const m = [meeting("b", { scheduledStart: at(10) }), meeting("a", { scheduledStart: at(0) })];
    expect(decide(at(15), state(m))).toEqual([{ kind: "start", meetingId: "a" }]);
  });

  it("não inicia outra enquanto uma grava (conflito)", () => {
    const m = [recording("a"), meeting("b", { scheduledStart: at(30) })];
    expect(decide(at(31), state(m))).toEqual([]);
    expect(conflicts(at(31), state(m))).toEqual(["b"]);
  });

  it("não inicia enquanto outra está em stopping", () => {
    const m = [meeting("a", { status: "stopping" }), meeting("b")];
    expect(decide(at(1), state(m))).toEqual([]);
  });

  it("reunião marcada como Não gravar não inicia", () => {
    expect(decide(at(1), state([meeting("a", { skipRecording: true, status: "skipped" })]))).toEqual([]);
    expect(decide(at(1), state([meeting("a", { skipRecording: true })]))).toEqual([]);
  });

  it("não inicia com o host-agent offline", () => {
    expect(decide(at(1), state([meeting("a")], { hostAgentOnline: false }))).toEqual([]);
  });

  it("marca missed quando o fim passou sem gravar", () => {
    const m = [meeting("a"), meeting("b", { status: "skipped" })];
    expect(decide(at(60), state(m))).toEqual([{ kind: "missed", meetingId: "a" }]);
  });

  it("para por silêncio depois do fim previsto", () => {
    const m = [recording("a", { lastSpeechAt: at(59) })];
    expect(decide(at(61), state(m))).toEqual([]);
    expect(decide(at(62), state(m))).toEqual([{ kind: "stop", meetingId: "a", reason: "silence" }]);
  });

  it("não para por silêncio antes do fim previsto", () => {
    const m = [recording("a", { lastSpeechAt: at(5) })];
    expect(decide(at(50), state(m))).toEqual([]);
  });

  it("grava pelo menos 3 min mesmo se iniciada depois do fim", () => {
    const m = [recording("a", { startedAt: at(70), lastSpeechAt: null })];
    expect(decide(at(72), state(m))).toEqual([]);
    expect(decide(at(73), state(m))).toEqual([{ kind: "stop", meetingId: "a", reason: "silence" }]);
  });

  it("parada manual tem prioridade", () => {
    const m = [recording("a", { stopRequested: true, lastSpeechAt: at(10) })];
    expect(decide(at(10), state(m))).toEqual([{ kind: "stop", meetingId: "a", reason: "manual" }]);
  });

  it("para ao atingir 4 h", () => {
    const m = [recording("a", { scheduledEnd: at(600), lastSpeechAt: at(239) })];
    expect(decide(at(239), state(m))).toEqual([]);
    expect(decide(at(240), state(m))).toEqual([{ kind: "stop", meetingId: "a", reason: "max_duration" }]);
  });

  it("para quando o host-agent some por 5 min depois do fim", () => {
    const m = [recording("a", { lastSpeechAt: at(64) })];
    const offline = { hostAgentOnline: false, hostAgentLastSeen: at(58) };
    expect(decide(at(62), state(m, offline))).toEqual([]);
    expect(decide(at(63), state(m, offline))).toEqual([{ kind: "stop", meetingId: "a", reason: "agent_offline" }]);
  });

  it("host-agent offline antes do fim não para a gravação", () => {
    const m = [recording("a", { lastSpeechAt: at(30) })];
    expect(decide(at(50), state(m, { hostAgentOnline: false, hostAgentLastSeen: at(20) }))).toEqual([]);
  });

  it("a próxima só começa no ciclo seguinte à parada", () => {
    const m = [recording("a", { stopRequested: true }), meeting("b", { scheduledStart: at(5) })];
    expect(decide(at(6), state(m))).toEqual([{ kind: "stop", meetingId: "a", reason: "manual" }]);
    m[0].status = "stopping";
    expect(decide(at(6), state(m))).toEqual([]);
    m[0].status = "transcribing";
    expect(decide(at(7), state(m))).toEqual([{ kind: "start", meetingId: "b" }]);
  });
});
