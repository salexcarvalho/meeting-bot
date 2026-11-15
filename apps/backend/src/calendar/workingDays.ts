// Dias úteis da agenda (ISO: segunda = 1 … domingo = 7), sem depender do config: as funções
// recebem os dias e o fuso, o que as deixa testáveis. O vínculo com o .env fica em offDay.ts.

export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

const WEEKDAY_NUMBER: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Lê WORKING_DAYS ("1,2,3,4,5"): números ISO de 1 a 7, sem repetição; vazio = segunda a sexta. */
export function parseWorkingDays(raw: string | undefined): number[] {
  const text = raw?.trim();
  if (!text) return [...DEFAULT_WORKING_DAYS];
  const days = new Set<number>();
  for (const part of text.split(",")) {
    const value = part.trim();
    if (!/^[1-7]$/.test(value)) {
      throw new Error("WORKING_DAYS inválido: use dias ISO de 1 (segunda) a 7 (domingo), separados por vírgula");
    }
    days.add(Number(value));
  }
  return [...days].sort((a, b) => a - b);
}

/** Dia da semana ISO (segunda = 1 … domingo = 7) do instante no fuso informado. */
export function isoWeekday(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
  return WEEKDAY_NUMBER[name];
}

export function isWorkingDay(instant: Date, workingDays: readonly number[], timeZone: string): boolean {
  return workingDays.includes(isoWeekday(instant, timeZone));
}
