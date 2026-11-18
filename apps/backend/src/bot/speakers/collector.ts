import type { SpeakerTimelineStatus } from "@meeting-bot/contracts";
import type { ClockAnchor } from "../../recording/clockAnchor";
import { SpeakerTimeline, type SpeechInterval } from "../../recording/speakerTimeline";
import type { SpeakerTimelineMeta } from "../../repo/speakerActivity";
import { SpeakerHealth, type HealthState } from "./health";
import { identifyTile, participantKey } from "./names";
import type { HostEdge, ProbeHost, ProbeStats } from "./probe";

// Coletor da linha do tempo (spec 006): lê as bordas do indicador de fala pela ponte com a página, converte
// para o relógio do áudio, alimenta a linha do tempo em memória e grava em lotes. Roda sozinho, em timers
// próprios; o ciclo do bot só chama start()/stop(). Nada aqui lança para o runner.

export const DRAIN_EVERY_MS = 1000;
export const REINSTALL_EVERY_MS = 5000;
export const FLUSH_EVERY_MS = 10_000;
export const HEALTH_EVERY_MS = 5000;
const MAX_PENDING = 5000;

export interface CollectorDeps {
  host: ProbeHost;
  anchor: ClockAnchor;
  timeline: SpeakerTimeline;
  /** nome do assistente (nunca vira falante) */
  assistantName: string;
  /** relógio em ms (performance.now); injetável nos testes */
  now: () => number;
  /** o áudio da chamada teve som desde a última consulta */
  soundSinceLast: () => boolean;
  /** pessoas na chamada segundo a plataforma; null = não sabe */
  participants: () => Promise<number | null>;
  /** grava um lote de intervalos já definitivos */
  persist: (intervals: SpeechInterval[]) => Promise<void>;
  /** grava o resumo final da leitura */
  finish: (meta: SpeakerTimelineMeta) => Promise<void>;
  /** uma linha de log por mudança de estado (sem nomes) */
  log: (message: string) => void;
  /** amostra de estrutura para diagnóstico (BOT_SPEAKER_DIAGNOSTIC); opcional */
  diagnose?: () => Promise<void>;
  /** rótulo da fonte para o resumo (ex.: "teams:guest") */
  sourceLabel: string;
}

export interface SpeakerCollector {
  start(): void;
  /** executa um ciclo agora (usado pelos testes e pelo stop) */
  tick(): Promise<void>;
  stop(): Promise<SpeakerTimelineMeta>;
}

export function createSpeakerCollector(deps: CollectorDeps): SpeakerCollector {
  return new Collector(deps);
}

class Collector implements SpeakerCollector {
  private readonly health: SpeakerHealth;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private lastInstall = Number.NEGATIVE_INFINITY;
  private lastFlush: number;
  private lastHealth: number;
  private lastState: HealthState = { status: "ok" };
  private stats: ProbeStats | null = null;
  private pending: SpeechInterval[] = [];
  private roseSinceHealth = false;
  private soundSinceHealth = false;
  private layerName = "";

  constructor(private readonly deps: CollectorDeps) {
    const t = deps.now();
    this.health = new SpeakerHealth(t);
    this.lastFlush = t;
    this.lastHealth = t;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), DRAIN_EVERY_MS);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.cycle();
    } catch (err) {
      this.logOnce("erro_ciclo", `leitura dos nomes: erro no ciclo (${(err as Error).name})`);
    } finally {
      this.busy = false;
    }
  }

  private async cycle(): Promise<void> {
    const t = this.deps.now();
    if (t - this.lastInstall >= REINSTALL_EVERY_MS) {
      this.lastInstall = t;
      await this.deps.host.install();
      await this.deps.diagnose?.();
    }
    const drained = await this.deps.host.drain();
    if (drained) {
      this.stats = drained.stats;
      this.layerName = drained.stats.layerName || this.layerName;
      this.ingest(drained.edges);
    }
    this.soundSinceHealth ||= this.deps.soundSinceLast();
    if (t - this.lastHealth >= HEALTH_EVERY_MS) await this.checkHealth(t);
    if (t - this.lastFlush >= FLUSH_EVERY_MS) await this.flush(false);
  }

  private ingest(edges: HostEdge[]): void {
    for (const edge of edges) {
      const seconds = this.deps.anchor.toSeconds(edge.atNodeMs);
      if (seconds === null) continue;
      const tile = identifyTile(edge.raw, this.deps.assistantName);
      if (!tile.name) continue;
      if (edge.speaking) this.roseSinceHealth = true;
      if (this.health.recordingSuspended) continue;
      this.deps.timeline.addEdge(participantKey(edge.id, tile.name), tile.name, edge.speaking, seconds);
    }
  }

  private async checkHealth(nowMs: number): Promise<void> {
    this.lastHealth = nowMs;
    const participants = await this.deps.participants().catch(() => null);
    const state = this.health.update(
      {
        namedTiles: this.stats?.tiles ?? 0,
        speakingTiles: this.stats?.speaking ?? 0,
        participants,
        sound: this.soundSinceHealth,
        rose: this.roseSinceHealth,
        totalErrors: this.stats?.errors ?? 0,
      },
      nowMs,
    );
    this.roseSinceHealth = false;
    this.soundSinceHealth = false;
    if (state.status !== this.lastState.status || state.reason !== this.lastState.reason) {
      this.deps.log(`leitura dos nomes na chamada: ${state.status}${state.reason ? ` (${state.reason})` : ""}`);
      this.lastState = state;
    }
  }

  private async flush(all: boolean): Promise<void> {
    this.lastFlush = this.deps.now();
    const seconds = this.deps.anchor.toSeconds(this.deps.now()) ?? 0;
    this.pending.push(...this.deps.timeline.drain(seconds, all));
    if (!this.pending.length) return;
    const batch = this.pending;
    try {
      await this.deps.persist(batch);
      this.pending = [];
    } catch (err) {
      // fica na fila para a próxima tentativa; a gravação não depende disto
      if (this.pending.length > MAX_PENDING) this.pending = this.pending.slice(-MAX_PENDING);
      this.logOnce("flush", `leitura dos nomes: não consegui gravar os intervalos (${(err as Error).name}); tento de novo`);
    }
  }

  private readonly loggedOnce = new Set<string>();

  private logOnce(key: string, message: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.deps.log(message);
  }

  async stop(): Promise<SpeakerTimelineMeta> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const t = this.deps.now();
    try {
      await this.checkHealth(t);
      const seconds = this.deps.anchor.toSeconds(t);
      if (seconds !== null) this.deps.timeline.closeAll(seconds);
      await this.flush(true);
    } catch (err) {
      this.deps.log(`leitura dos nomes: erro ao encerrar (${(err as Error).name})`);
    }
    const meta = this.summary();
    await this.deps.finish(meta).catch((err) => this.deps.log(`leitura dos nomes: resumo não gravado (${(err as Error).name})`));
    return meta;
  }

  private summary(): SpeakerTimelineMeta {
    const state = this.lastState;
    const people = this.deps.timeline.peopleCount;
    let status: SpeakerTimelineStatus = state.status;
    let reason: string | undefined = state.reason;
    if (status === "ok" && !this.deps.timeline.hasData && !this.pending.length) {
      const sawTiles = Boolean(this.stats && this.stats.tiles > 0);
      status = sawTiles ? "partial" : "unavailable";
      reason = this.deps.anchor.ready ? (sawTiles ? "no_indicator" : "no_tiles") : "no_clock";
    }
    return {
      status,
      ...(reason ? { reason } : {}),
      source: this.layerName ? `${this.deps.sourceLabel}/${this.layerName}` : this.deps.sourceLabel,
      ...(this.stats && this.stats.layer >= 0 ? { layer: this.stats.layer } : {}),
      people,
      intervals: this.deps.timeline.intervalCount,
    };
  }
}
