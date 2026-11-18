import type { SnippetPartValue } from "@meeting-bot/contracts";

// `ts_headline` marca os termos com caracteres de controle (nunca HTML); aqui viram partes tipadas.
// O front monta <mark> a partir delas, então nada do conteúdo é interpretado como marcação.

export const MARK_START = "\u0002";
export const MARK_STOP = "\u0003";
export const SNIPPET_MAX_CHARS = 320;

/** Opções do `ts_headline` (parâmetro de texto, nunca interpolado no SQL). */
export const HEADLINE_OPTIONS = `StartSel=${MARK_START}, StopSel=${MARK_STOP}, MaxWords=40, MinWords=18, ShortWord=2, MaxFragments=1`;

function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 || ch === "\t" || ch === "\n") out += ch;
  }
  return out.replace(/\s+/g, " ");
}

/** Separa a saída do `ts_headline` em pedaços [texto, destacado?], pela marcação de controle. */
function splitMarked(headline: string): [string, boolean][] {
  const pieces: [string, boolean][] = [];
  let buffer = "";
  let match = false;
  for (const ch of headline) {
    if (ch !== MARK_START && ch !== MARK_STOP) {
      buffer += ch;
      continue;
    }
    if (buffer) pieces.push([buffer, match]);
    buffer = "";
    match = ch === MARK_START;
  }
  if (buffer) pieces.push([buffer, match]);
  return pieces;
}

/** Converte a saída do `ts_headline` em partes; trunca em ~320 caracteres de texto visível. */
export function parseHeadline(headline: string, max = SNIPPET_MAX_CHARS): SnippetPartValue[] {
  const parts: SnippetPartValue[] = [];
  let budget = max;
  for (const [piece, match] of splitMarked(headline)) {
    if (budget <= 0) break;
    const taken = clean(piece).slice(0, budget);
    budget -= taken.length;
    if (taken) parts.push({ text: taken, match });
  }
  return mergeNeighbors(parts);
}

function mergeNeighbors(parts: SnippetPartValue[]): SnippetPartValue[] {
  const merged: SnippetPartValue[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last && last.match === part.match) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

/** Trecho sem destaque (acerto só semântico): começo do conteúdo, cortado em fronteira de palavra. */
export function plainSnippet(content: string, max = SNIPPET_MAX_CHARS): SnippetPartValue[] {
  const text = clean(content).trim();
  if (!text) return [];
  if (text.length <= max) return [{ text, match: false }];
  const cut = text.lastIndexOf(" ", max);
  return [{ text: `${text.slice(0, cut > max / 2 ? cut : max)}…`, match: false }];
}

/** Há trecho destacado? Se não, o chamador usa `plainSnippet`. */
export function hasMatch(parts: SnippetPartValue[]): boolean {
  return parts.some((p) => p.match);
}
