import type { Frame, Page } from "playwright";
import { PROBE_SOURCE, PROBE_VERSION } from "./probeSource";

// Ponte entre o Node e o leitor que roda dentro da página (probeSource.ts). Toda chamada à página tem
// limite de tempo e falha em silêncio para o chamador: ler a tela nunca pode atrapalhar a gravação.

/** De onde sai o nome de um quadro: atributo ou texto do próprio quadro (`self`) ou de um descendente (`sel`). */
export interface NameSource {
  self?: boolean;
  sel?: string;
  attr?: string;
  text?: boolean;
  /** o texto folha mais longo (até 60 caracteres) dentro do quadro */
  shortest?: boolean;
}

/** Como saber que o quadro está com a voz ativa. Lido por estado, nunca por classe CSS fixa. */
export type IndicatorRule =
  | { mode: "present"; sel?: string }
  | { mode: "attr"; sel?: string; attr: string; match: string }
  | { mode: "style"; sel?: string; props: string[]; minObservations: number };

export interface ProbeLayer {
  /** "semantic" (atributos), "structural" (forma do quadro) ou "panel" (lista de pessoas já aberta) */
  name: string;
  tile: string;
  /** descendente obrigatório (vídeo, avatar); sem ele o elemento não é um quadro */
  requires?: string;
  /** atributo com o identificador do participante dado pela plataforma */
  idAttr?: string;
  nameFrom: NameSource[];
  indicators: IndicatorRule[];
}

export interface ProbeConfig {
  version: number;
  layers: ProbeLayer[];
  intervalMs: number;
  largeIntervalMs: number;
  largeTiles: number;
  cacheMs: number;
  maxTiles: number;
  maxEdges: number;
}

/** Estilo que muda quando o indicador de fala acende (anel/contorno/animação), comparado ao repouso do próprio quadro. */
export const RING_STYLE = ["outline-style", "outline-width", "box-shadow", "animation-name"];
/** Leituras sem fala para aprender o estilo de repouso de um quadro antes de decidir por estilo. */
export const MIN_REST_OBSERVATIONS = 20;
/** Nome tirado do rótulo acessível do próprio quadro. */
export const ARIA_NAME: NameSource = { self: true, attr: "aria-label" };
/** Ícone de microfone animado de uma lista de pessoas. */
export const ICON_STYLE = ["animation-name", "transform", "opacity"];

export const PROBE_DEFAULTS = {
  intervalMs: 250,
  largeIntervalMs: 500,
  largeTiles: 30,
  cacheMs: 5000,
  maxTiles: 80,
  maxEdges: 2000,
} as const;

export function probeConfig(layers: ProbeLayer[]): ProbeConfig {
  return { version: PROBE_VERSION, layers, ...PROBE_DEFAULTS };
}

export interface ProbeStats {
  tiles: number;
  layer: number;
  layerName: string;
  errors: number;
  polls: number;
  speaking: number;
  lastError: string;
}

/** Borda do indicador já no relógio do Node (`performance.now()`), ainda com o nome cru da tela. */
export interface HostEdge {
  id: string;
  raw: string;
  speaking: boolean;
  atNodeMs: number;
}

export interface DrainResult {
  edges: HostEdge[];
  stats: ProbeStats;
}

/** O que o coletor precisa da página; os testes usam uma versão falsa. */
export interface ProbeHost {
  install(): Promise<void>;
  /** null = não conseguiu ler agora (página navegando, tempo esgotado) */
  drain(): Promise<DrainResult | null>;
}

export const CALL_TIMEOUT_MS = 2000;

/** Espera `work` por no máximo `ms`; passado o prazo devolve null (a página pode estar travada ou navegando). */
export async function withTimeout<T>(work: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work.catch(() => null), limit]);
  } finally {
    clearTimeout(timer);
  }
}

interface RawDrain {
  now: number;
  edges: { id: string; raw: string; speaking: boolean; at: number }[];
  stats: ProbeStats;
}

const EMPTY_STATS: ProbeStats = { tiles: 0, layer: -1, layerName: "", errors: 0, polls: 0, speaking: 0, lastError: "" };

/** Usa os frames da página (a chamada pode vir num iframe): instala o leitor em todos e junta o que cada um viu. */
export class PageProbeHost implements ProbeHost {
  private readonly active = new Set<Frame>();

  constructor(
    private readonly page: Page,
    private readonly config: ProbeConfig,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  async install(): Promise<void> {
    if (this.page.isClosed()) return;
    const source = `(${PROBE_SOURCE})(${JSON.stringify(this.config)})`;
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      const stats = await withTimeout(frame.evaluate(source) as Promise<ProbeStats>);
      if (stats && (stats.tiles > 0 || frame === this.page.mainFrame())) this.active.add(frame);
      if (stats && stats.tiles === 0 && frame !== this.page.mainFrame()) this.active.delete(frame);
    }
  }

  async drain(): Promise<DrainResult | null> {
    if (this.page.isClosed()) return null;
    const edges: HostEdge[] = [];
    let best: ProbeStats | null = null;
    let reached = false;
    for (const frame of [...this.active]) {
      if (frame.isDetached()) {
        this.active.delete(frame);
        continue;
      }
      const before = this.nowMs();
      const raw = await withTimeout(frame.evaluate("window.__mbSpk ? window.__mbSpk.drain() : null") as Promise<RawDrain | null>);
      const after = this.nowMs();
      if (!raw) {
        // leitor perdido (navegação) ou página sem resposta: o próximo install() reinjeta
        this.active.delete(frame);
        continue;
      }
      reached = true;
      // o relógio da página (Date.now) é lido no meio da chamada; cada borda vira "há tanto tempo" no relógio do Node
      const mid = (before + after) / 2;
      for (const e of raw.edges) {
        edges.push({ id: e.id, raw: e.raw, speaking: e.speaking, atNodeMs: mid - (raw.now - e.at) });
      }
      if (!best || raw.stats.tiles > best.tiles) best = raw.stats;
    }
    return reached ? { edges, stats: best ?? EMPTY_STATS } : null;
  }
}
