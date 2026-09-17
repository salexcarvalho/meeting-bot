import { describe, expect, it } from "vitest";
import { LeaveDecider, type CallSample } from "../src/bot/leave";

const MIN = 60_000;
const SETTINGS = {
  aloneTimeoutMs: 5 * MIN,
  silenceAfterEndMs: 3 * MIN,
  silenceNoScheduleMs: 10 * MIN,
  maxMeetingMs: 240 * MIN,
  stayUntil: null as number | null,
};

/** Roda a checagem a cada 5 s a partir de `startedAt`, devolvendo o motivo e o minuto da saída. */
function run(
  settings: Partial<typeof SETTINGS>,
  sampleAt: (now: number) => Partial<CallSample>,
  minutes = 60,
): { reason: string | null; at: number } {
  const decider = new LeaveDecider({ ...SETTINGS, ...settings });
  const startedAt = 0;
  for (let now = 0; now <= minutes * MIN; now += 5000) {
    const reason = decider.check({
      now,
      startedAt,
      ended: false,
      participants: null,
      aloneText: false,
      lastSoundAt: now,
      ...sampleAt(now),
    });
    if (reason) return { reason, at: now / MIN };
  }
  return { reason: null, at: minutes };
}

describe("quando o assistente sai da chamada", () => {
  it("sai na hora quando a chamada termina", () => {
    const out = run({}, (now) => ({ ended: now >= 12 * MIN }));
    expect(out).toEqual({ reason: "a chamada terminou", at: 12 });
  });

  it("conta participantes: sozinho por 5 min faz sair (mesmo sem o aviso na tela)", () => {
    // o problema real de 2026-09-17: todo mundo saiu, o Teams não mostrou "você é o único aqui"
    const out = run({}, (now) => ({ participants: now >= 10 * MIN ? 1 : 4 }));
    expect(out.reason).toMatch(/sozinho na chamada há 5 min/);
    expect(out.at).toBeCloseTo(15, 0);
  });

  it("gente voltando zera a contagem de sozinho", () => {
    const out = run({}, (now) => ({ participants: now >= 4 * MIN && now < 8 * MIN ? 1 : 3 }), 30);
    expect(out.reason).toBeNull();
  });

  it("sem contagem, usa o aviso na tela", () => {
    const out = run({}, () => ({ participants: null, aloneText: true }));
    expect(out.reason).toMatch(/sozinho/);
  });

  it("reunião da agenda: não sai por estar sozinho antes do fim previsto", () => {
    const stayUntil = 20 * MIN;
    const out = run({ stayUntil }, () => ({ participants: 1 }), 40);
    expect(out.at).toBeGreaterThanOrEqual(20);
    expect(out.reason).toMatch(/sozinho/);
  });

  it("silêncio depois do fim previsto encerra em 3 min", () => {
    const stayUntil = 10 * MIN;
    const out = run({ stayUntil }, (now) => ({ participants: 3, lastSoundAt: Math.min(now, 9 * MIN) }), 30);
    expect(out.reason).toMatch(/sem som há 3 min depois do fim previsto/);
    expect(out.at).toBeCloseTo(12, 0);
  });

  it("sem horário previsto, o silêncio precisa ser longo", () => {
    const out = run({}, (now) => ({ participants: 3, lastSoundAt: Math.min(now, 2 * MIN) }), 30);
    expect(out.reason).toMatch(/sem som há 10 min/);
    expect(out.at).toBeCloseTo(12, 0);
  });

  it("gente na chamada e som rolando: fica até o limite de duração", () => {
    const out = run({ maxMeetingMs: 30 * MIN }, () => ({ participants: 3 }), 60);
    expect(out.reason).toBe("duração máxima de 30 min atingida");
    expect(out.at).toBeCloseTo(30, 0);
  });
});
