import { disambiguateNames } from "../bot/speakers/names";

// Linha do tempo em memória de quem falou na chamada (spec 006): alimentada pelo coletor do bot,
// consultada pela transcrição ao vivo e esvaziada em lotes para o banco. O tempo é o do áudio gravado.

/** Fala só conta depois de 300 ms contínuos; pausas menores que 500 ms não separam intervalos. */
export const MIN_SPEECH_SECONDS = 0.3;
export const MERGE_GAP_SECONDS = 0.5;
/** Um intervalo fechado só vira definitivo depois da janela de fusão (a pessoa pode voltar a falar). */
const SETTLE_SECONDS = MERGE_GAP_SECONDS + 0.1;
/** Ao vivo: fração mínima do segmento, e tempo mínimo, para ele levar o nome. */
export const DOMINANT_MIN_FRACTION = 0.5;
export const DOMINANT_MIN_SECONDS = 0.5;

export interface SpeechInterval {
  key: string;
  name: string;
  start: number;
  end: number;
}

type Span = Omit<SpeechInterval, "key">;

interface PersonState {
  name: string;
  firstAt: number;
  openAt: number | null;
  closed: Span[];
  /** quantos dos fechados já saíram para o banco (prefixo) */
  drained: number;
}

export interface DominantOptions {
  /** o indicador da tela chega este tanto depois do áudio (segundos) */
  skewSeconds?: number;
  /** instante atual no relógio do áudio: intervalos abertos valem até aqui */
  nowSeconds: number;
}

export class SpeakerTimeline {
  private readonly people = new Map<string, PersonState>();

  /** Borda do indicador: `speaking` = começou/continua falando; false = parou. Tempo em segundos do áudio. */
  addEdge(key: string, name: string, speaking: boolean, at: number): void {
    const person = this.person(key, name, at);
    person.name = name;
    if (speaking) this.rise(person, at);
    else this.fall(person, at);
  }

  private person(key: string, name: string, at: number): PersonState {
    let person = this.people.get(key);
    if (!person) {
      person = { name, firstAt: at, openAt: null, closed: [], drained: 0 };
      this.people.set(key, person);
    }
    return person;
  }

  private rise(person: PersonState, at: number): void {
    if (person.openAt !== null) return;
    const last = person.closed[person.closed.length - 1];
    const canMerge = last && person.closed.length > person.drained && at - last.end < MERGE_GAP_SECONDS;
    if (canMerge) {
      person.closed.pop();
      person.openAt = last.start;
    } else {
      person.openAt = at;
    }
  }

  private fall(person: PersonState, at: number): void {
    if (person.openAt === null) return;
    const start = person.openAt;
    person.openAt = null;
    if (at - start < MIN_SPEECH_SECONDS) return;
    person.closed.push({ name: person.name, start, end: at });
  }

  /** Fecha todos os intervalos abertos (fim da gravação). */
  closeAll(at: number): void {
    for (const [key, person] of this.people) this.addEdge(key, person.name, false, at);
  }

  get peopleCount(): number {
    return this.people.size;
  }

  /** Intervalos fechados (os que viram linhas do banco). */
  get intervalCount(): number {
    let total = 0;
    for (const person of this.people.values()) total += person.closed.length;
    return total;
  }

  get hasData(): boolean {
    for (const person of this.people.values()) if (person.closed.length || person.openAt !== null) return true;
    return false;
  }

  /** Todos os intervalos (fechados e abertos até `nowSeconds`), ordenados por início. */
  snapshot(nowSeconds: number): SpeechInterval[] {
    const out: SpeechInterval[] = [];
    for (const [key, person] of this.people) {
      for (const it of person.closed) out.push({ ...it, key });
      if (person.openAt !== null && nowSeconds - person.openAt >= MIN_SPEECH_SECONDS) {
        out.push({ key, name: person.name, start: person.openAt, end: nowSeconds });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Intervalos fechados e já definitivos que ainda não foram para o banco (ou todos, com `all`). */
  drain(nowSeconds: number, all = false): SpeechInterval[] {
    const out: SpeechInterval[] = [];
    for (const [key, person] of this.people) {
      let next = person.drained;
      while (next < person.closed.length && (all || person.closed[next].end <= nowSeconds - SETTLE_SECONDS)) {
        out.push({ ...person.closed[next], key });
        next++;
      }
      person.drained = next;
    }
    return out;
  }

  /** Quem a pessoa de cada chave é, com nomes repetidos de pessoas diferentes já desambiguados. */
  displayNames(): Map<string, string> {
    return disambiguateNames([...this.people].map(([key, p]) => ({ key, name: p.name, firstAt: p.firstAt })));
  }

  /**
   * Nome de quem mais falou em [t0, t1] (relógio do áudio), ou null sem maioria: precisa de pelo menos
   * metade do segmento e 0,5 s, e de mais tempo que qualquer outra pessoa.
   */
  dominant(t0: number, t1: number, opts: DominantOptions): string | null {
    const skew = opts.skewSeconds ?? 0;
    const from = t0 + skew;
    const to = t1 + skew;
    const length = to - from;
    if (length <= 0) return null;
    let best: { key: string; time: number } | null = null;
    let second = 0;
    for (const [key, person] of this.people) {
      const time = this.activeTime(person, from, to, opts.nowSeconds);
      if (best === null || time > best.time) {
        if (best) second = Math.max(second, best.time);
        best = { key, time };
      } else {
        second = Math.max(second, time);
      }
    }
    if (!best || best.time < DOMINANT_MIN_SECONDS || best.time < length * DOMINANT_MIN_FRACTION) return null;
    if (best.time <= second) return null;
    return this.displayNames().get(best.key) ?? null;
  }

  private activeTime(person: PersonState, from: number, to: number, now: number): number {
    let total = 0;
    for (const it of person.closed) total += Math.max(0, Math.min(it.end, to) - Math.max(it.start, from));
    if (person.openAt !== null) total += Math.max(0, Math.min(now, to) - Math.max(person.openAt, from));
    return total;
  }
}

// Uma linha do tempo por reunião com assistente na chamada; some quando o bot termina (sem vazar memória).
const timelines = new Map<string, SpeakerTimeline>();

export function timelineFor(meetingId: string): SpeakerTimeline {
  let timeline = timelines.get(meetingId);
  if (!timeline) {
    timeline = new SpeakerTimeline();
    timelines.set(meetingId, timeline);
  }
  return timeline;
}

export function getTimeline(meetingId: string): SpeakerTimeline | undefined {
  return timelines.get(meetingId);
}

export function dropTimeline(meetingId: string): void {
  timelines.delete(meetingId);
}
