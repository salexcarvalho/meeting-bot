import { config } from "../config";
import { isWorkingDay } from "./workingDays";

// Fim de semana (ou qualquer dia fora de WORKING_DAYS) sem agenda: o dia vale no fuso APP_TIMEZONE,
// como o resto da agenda.

export function isAgendaWorkingDay(instant: Date): boolean {
  return isWorkingDay(instant, config.workingDays, config.appTimezone);
}

/**
 * Sem lembrete nem entrada/gravação automática: reunião em dia não útil, a menos que o usuário
 * tenha pedido (`auto_on_off_day`). "Enviar assistente agora" e "Gravar agora" continuam valendo.
 */
export function autoSuppressed(start: Date | null, userOverride: boolean): boolean {
  return start !== null && !userOverride && !isAgendaWorkingDay(start);
}
