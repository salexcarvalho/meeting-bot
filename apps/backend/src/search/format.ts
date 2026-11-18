import { config } from "../config";

// Formatação de datas e horários para rótulos de busca e do chat (fuso APP_TIMEZONE).

export function dateLabel(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: config.appTimezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/** dd/mm, para rótulos curtos. */
export function shortDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: config.appTimezone, day: "2-digit", month: "2-digit" }).format(date);
}

/** Segundos desde o início da gravação como hh:mm:ss. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
