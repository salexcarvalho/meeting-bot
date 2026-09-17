// Quando o assistente sai da chamada. Antes dependia só do aviso "você é o único aqui", que o
// Teams nem sempre mostra: em 2026-09-17 o bot ficou gravando sozinho depois do fim da reunião.
// Agora conta participantes, vê a tela de fim e usa o silêncio do áudio.

export interface LeaveSettings {
  /** sozinho na chamada por este tempo */
  aloneTimeoutMs: number;
  /** silêncio depois do fim previsto (mesma regra da gravação pelo computador) */
  silenceAfterEndMs: number;
  /** silêncio numa reunião sem horário previsto (bot enviado à mão) */
  silenceNoScheduleMs: number;
  maxMeetingMs: number;
  /** fim previsto: antes dele o assistente não sai por estar sozinho */
  stayUntil: number | null;
}

export interface CallSample {
  now: number;
  startedAt: number;
  /** tela de "a chamada terminou" / "você saiu" */
  ended: boolean;
  /** pessoas na chamada, incluindo o assistente; null = não deu para contar */
  participants: number | null;
  /** aviso de "você é o único aqui" */
  aloneText: boolean;
  /** último instante com som no áudio da chamada */
  lastSoundAt: number;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

export class LeaveDecider {
  private aloneSince: number | null = null;

  constructor(private readonly settings: LeaveSettings) {}

  /** Motivo para sair agora, ou null para continuar gravando. */
  check(sample: CallSample): string | null {
    const { aloneTimeoutMs, silenceAfterEndMs, silenceNoScheduleMs, maxMeetingMs, stayUntil } = this.settings;
    if (sample.ended) return "a chamada terminou";
    if (sample.now - sample.startedAt > maxMeetingMs) return `duração máxima de ${minutes(maxMeetingMs)} min atingida`;

    const alone = sample.participants !== null ? sample.participants <= 1 : sample.aloneText;
    if (alone) {
      this.aloneSince ??= sample.now;
      const mayLeave = sample.now >= (stayUntil ?? 0);
      if (mayLeave && sample.now - this.aloneSince > aloneTimeoutMs) {
        return `sozinho na chamada há ${minutes(sample.now - this.aloneSince)} min`;
      }
    } else {
      this.aloneSince = null;
    }

    // Sem som ninguém está falando: com horário previsto vale a regra da gravação local; sem
    // horário (bot enviado à mão), espera bem mais antes de desistir.
    const silentFor = sample.now - sample.lastSoundAt;
    if (stayUntil !== null) {
      if (sample.now > stayUntil && silentFor > silenceAfterEndMs) {
        return `sem som há ${minutes(silentFor)} min depois do fim previsto`;
      }
    } else if (silentFor > silenceNoScheduleMs) {
      return `sem som há ${minutes(silentFor)} min`;
    }
    return null;
  }
}
