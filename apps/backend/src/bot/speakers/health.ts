import type { SpeakerTimelineStatus } from "@meeting-bot/contracts";

// Saúde da leitura da tela (plan D5): decide se a linha do tempo é confiável. Puro e com relógio injetado.
// A leitura "reprovada" nunca derruba nada: só deixa de ser usada para nomear.

export const HEALTH_LIMITS = {
  /** sem nenhum quadro com nome por tanto tempo (e mais de uma pessoa na chamada) = indisponível */
  noTilesMs: 60_000,
  /** som na chamada sem nenhuma fala detectada pelo indicador = parcial */
  noIndicatorSoundMs: 120_000,
  /** quadros "falando" ao mesmo tempo por tanto tempo seguido = indicador preso */
  stuckMs: 20_000,
  stuckShare: 0.8,
  /** menos que isso de quadros não permite concluir que o indicador está preso (um monólogo é normal) */
  stuckMinTiles: 2,
  /** exceções de leitura na página em 1 minuto = indisponível */
  maxErrorsPerMinute: 20,
  errorWindowMs: 60_000,
} as const;

export type HealthReason = "no_tiles" | "no_indicator" | "stuck" | "errors" | "no_clock";

export interface HealthState {
  status: Extract<SpeakerTimelineStatus, "ok" | "partial" | "unavailable">;
  reason?: HealthReason;
}

export interface HealthSample {
  /** quadros com nome (já sem o assistente, "apresentando" etc.) */
  namedTiles: number;
  speakingTiles: number;
  /** pessoas na chamada segundo a plataforma (inclui o assistente); null = não sabe */
  participants: number | null;
  /** o áudio da chamada teve som neste intervalo de leitura */
  sound: boolean;
  /** houve borda de subida (alguém começou a falar) neste intervalo */
  rose: boolean;
  /** exceções de leitura acumuladas na página */
  totalErrors: number;
}

export class SpeakerHealth {
  private lastTilesAt: number;
  private soundSinceRise = 0;
  private lastSampleAt: number;
  private stuckSince: number | null = null;
  private stickyReason: HealthReason | null = null;
  private errorLog: { at: number; total: number }[] = [];
  private current: HealthState = { status: "ok" };

  constructor(startMs: number) {
    this.lastTilesAt = startMs;
    this.lastSampleAt = startMs;
  }

  get state(): HealthState {
    return this.current;
  }

  /** O registro de intervalos deve parar (indicador preso agora)? */
  get recordingSuspended(): boolean {
    return this.stuckSince !== null && this.current.reason === "stuck";
  }

  update(sample: HealthSample, nowMs: number): HealthState {
    const elapsed = nowMs - this.lastSampleAt;
    this.lastSampleAt = nowMs;
    this.trackTiles(sample, nowMs);
    this.trackIndicator(sample, elapsed);
    this.trackStuck(sample, nowMs);
    this.current = this.evaluate(sample, nowMs);
    return this.current;
  }

  private trackTiles(sample: HealthSample, nowMs: number): void {
    if (sample.namedTiles > 0) this.lastTilesAt = nowMs;
  }

  private trackIndicator(sample: HealthSample, elapsed: number): void {
    if (sample.rose) this.soundSinceRise = 0;
    else if (sample.sound && sample.namedTiles > 0) this.soundSinceRise += elapsed;
  }

  private trackStuck(sample: HealthSample, nowMs: number): void {
    const stuckNow =
      sample.namedTiles >= HEALTH_LIMITS.stuckMinTiles &&
      sample.speakingTiles / sample.namedTiles >= HEALTH_LIMITS.stuckShare;
    if (!stuckNow) this.stuckSince = null;
    else this.stuckSince ??= nowMs;
  }

  private errorsInWindow(sample: HealthSample, nowMs: number): number {
    this.errorLog.push({ at: nowMs, total: sample.totalErrors });
    this.errorLog = this.errorLog.filter((e) => nowMs - e.at <= HEALTH_LIMITS.errorWindowMs);
    return sample.totalErrors - this.errorLog[0].total;
  }

  private evaluate(sample: HealthSample, nowMs: number): HealthState {
    // "partial" por indicador preso ou sem indicador é definitivo: a linha do tempo da reunião não é confiável.
    if (this.stuckSince !== null && nowMs - this.stuckSince >= HEALTH_LIMITS.stuckMs) this.stickyReason = "stuck";
    else if (this.soundSinceRise >= HEALTH_LIMITS.noIndicatorSoundMs) this.stickyReason ??= "no_indicator";
    if (this.errorsInWindow(sample, nowMs) > HEALTH_LIMITS.maxErrorsPerMinute) return { status: "unavailable", reason: "errors" };
    const alone = sample.participants !== null && sample.participants <= 1;
    if (nowMs - this.lastTilesAt > HEALTH_LIMITS.noTilesMs && !alone) return { status: "unavailable", reason: "no_tiles" };
    if (this.stickyReason) return { status: "partial", reason: this.stickyReason };
    return { status: "ok" };
  }
}
