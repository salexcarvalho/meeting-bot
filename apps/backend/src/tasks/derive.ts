// Derivações puras de item da reunião para tarefa (sem banco): título curto e prazo dito → data.
// Só entra data quando o texto é inequívoco; "sexta", "semana que vem" etc. ficam como prazo dito.

const TITLE_MAX = 120;
const TITLE_MIN = 3;
const ELLIPSIS = "…";
const HINT_MAX = 120;
const SENTENCE_END = new Set([".", "!", "?"]);

const collapse = (text: string) => text.split(/\s+/u).filter(Boolean).join(" ");

/** Primeira frase de uma linha: termina em `.`, `!` ou `?` seguidos de espaço ou do fim do texto. */
function firstSentence(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (SENTENCE_END.has(line[i]) && (i === line.length - 1 || line[i + 1] === " ")) return line.slice(0, i + 1);
  }
  return line;
}

const TRAILING_PUNCTUATION = new Set([",", ";", ":", "-"]);

/** Tira vírgula, ponto e vírgula, dois-pontos, hífen e espaços do fim (laço, sem regex com retrocesso). */
function stripTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && (TRAILING_PUNCTUATION.has(text[end - 1]) || text[end - 1].trim() === "")) end--;
  return text.slice(0, end);
}

function cutAtWord(text: string): string {
  const head = text.slice(0, TITLE_MAX);
  const space = head.lastIndexOf(" ");
  const cut = text[TITLE_MAX] === " " || space <= 0 ? head : head.slice(0, space);
  return `${stripTrailingPunctuation(cut)}${ELLIPSIS}`;
}

/** Título da tarefa: primeira frase do item, até 120 caracteres, cortada em palavra inteira (com `…`). */
export function deriveTitle(description: string): string {
  const lines = description.split(/\r?\n/u).map(collapse).filter(Boolean);
  const all = collapse(description);
  let title = firstSentence(lines[0] ?? all);
  if (title.endsWith(".")) title = title.slice(0, -1).trimEnd();
  if (title.length < TITLE_MIN) title = all;
  return title.length > TITLE_MAX ? cutAtWord(title) : title;
}

export interface DueResult {
  /** AAAA-MM-DD */
  date: string | null;
  /** texto dito que não virou data */
  hint: string | null;
}

const PREFIXES = ["ate o dia ", "ate dia ", "ate o ", "ate ", "para o dia ", "para o ", "para ", "no dia ", "dia ", "no ", "em "];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const BR_DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/u;
const BR_DAY_MONTH = /^(\d{1,2})\/(\d{1,2})$/u;

function fold(text: string): string {
  return collapse(text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase());
}

function stripPrefixes(text: string): string {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const prefix = PREFIXES.find((p) => out.startsWith(p));
    if (!prefix) break;
    out = out.slice(prefix.length).trimStart();
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Data civil válida em AAAA-MM-DD, ou null (ex.: 31/02). */
export function civilDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  return valid ? `${year}-${pad(month)}-${pad(day)}` : null;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Dia civil de um instante no fuso dado (AAAA-MM-DD). */
export function dayInZone(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function fullYear(raw: string): number {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

function parseNumeric(text: string, meetingDay: string): string | null {
  const iso = ISO_DAY.exec(text);
  if (iso) return civilDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = BR_DAY.exec(text);
  if (br) return civilDate(fullYear(br[3]), Number(br[2]), Number(br[1]));
  const short = BR_DAY_MONTH.exec(text);
  if (!short) return null;
  const year = Number(meetingDay.slice(0, 4));
  const same = civilDate(year, Number(short[2]), Number(short[1]));
  if (!same) return null;
  return same < meetingDay ? civilDate(year + 1, Number(short[2]), Number(short[1])) : same;
}

/**
 * Prazo dito → data. "hoje" e "amanhã" valem a partir do dia da reunião; `dd/mm` assume o ano da reunião
 * (o seguinte se a data já passou). O resto vira só `hint`: um prazo errado é pior que nenhum.
 */
export function parseDueText(text: string | null | undefined, meetingAt: Date, timezone: string): DueResult {
  const raw = collapse(text ?? "");
  if (!raw) return { date: null, hint: null };
  const hint = raw.slice(0, HINT_MAX);
  const meetingDay = dayInZone(meetingAt, timezone);
  const folded = stripPrefixes(fold(raw));
  if (folded === "hoje") return { date: meetingDay, hint: null };
  if (folded === "amanha") return { date: addDays(meetingDay, 1), hint: null };
  const date = parseNumeric(folded, meetingDay);
  return date ? { date, hint: null } : { date: null, hint };
}
