import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS, SpeakerHealth, type HealthSample } from "../src/bot/speakers/health";

const base: HealthSample = { namedTiles: 4, speakingTiles: 1, participants: 5, sound: true, rose: true, totalErrors: 0 };

/** Roda `seconds` de leituras a cada 5 s com a amostra dada. */
function run(health: SpeakerHealth, from: number, seconds: number, sample: Partial<HealthSample>) {
  let state = health.state;
  for (let t = from; t <= from + seconds * 1000; t += 5000) state = health.update({ ...base, ...sample }, t);
  return state;
}

describe("saúde da leitura (plan D5)", () => {
  it("leitura normal fica ok", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 300, {})).toEqual({ status: "ok" });
  });

  it("sem quadros por mais de 60 s com mais de uma pessoa: indisponível; recupera quando voltam", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 50, { namedTiles: 0, speakingTiles: 0, rose: false })).toEqual({ status: "ok" });
    expect(run(health, 60_000, 20, { namedTiles: 0, speakingTiles: 0, rose: false })).toEqual({ status: "unavailable", reason: "no_tiles" });
    expect(run(health, 90_000, 10, {})).toEqual({ status: "ok" });
  });

  it("sozinho na chamada, sem quadros não é falha", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 300, { namedTiles: 0, speakingTiles: 0, rose: false, participants: 1 })).toEqual({ status: "ok" });
  });

  it("som por mais de 120 s sem nenhuma fala detectada: parcial (sem indicador), e fica", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 100, { rose: false })).toEqual({ status: "ok" });
    expect(run(health, 110_000, 40, { rose: false })).toEqual({ status: "partial", reason: "no_indicator" });
    expect(run(health, 160_000, 20, { rose: true })).toEqual({ status: "partial", reason: "no_indicator" });
  });

  it("silêncio na chamada não conta como indicador quebrado", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 600, { rose: false, sound: false })).toEqual({ status: "ok" });
  });

  it("indicador preso (80% dos quadros por mais de 20 s): parcial e o registro é suspenso", () => {
    const health = new SpeakerHealth(0);
    run(health, 5000, 10, {});
    run(health, 20_000, 15, { speakingTiles: 4 });
    expect(health.recordingSuspended).toBe(false);
    expect(run(health, 40_000, 15, { speakingTiles: 4 })).toEqual({ status: "partial", reason: "stuck" });
    expect(health.recordingSuspended).toBe(true);
    run(health, 60_000, 10, { speakingTiles: 1 });
    expect(health.recordingSuspended).toBe(false);
    expect(health.state.status).toBe("partial");
  });

  it("um único quadro falando por muito tempo (monólogo) não é indicador preso", () => {
    const health = new SpeakerHealth(0);
    expect(run(health, 5000, 120, { namedTiles: 1, speakingTiles: 1 })).toEqual({ status: "ok" });
  });

  it("mais de 20 exceções em 1 minuto: indisponível", () => {
    const health = new SpeakerHealth(0);
    run(health, 5000, 20, { totalErrors: 0 });
    const state = health.update({ ...base, totalErrors: HEALTH_LIMITS.maxErrorsPerMinute + 5 }, 30_000);
    expect(state).toEqual({ status: "unavailable", reason: "errors" });
    expect(run(health, 90_000, 30, { totalErrors: HEALTH_LIMITS.maxErrorsPerMinute + 5 })).toEqual({ status: "ok" });
  });
});
