import { CHAT_NOT_FOUND_ANSWER, type ChatCitationValue, type ChatLlmOutputValue, type SearchTargetValue } from "@meeting-bot/contracts";
import { normalizeText } from "../../agent/text";
import { kindLabel, type PromptSource } from "./prompt";

// Validação da resposta do LLM (specs/003-busca-chat/contracts/chat-llm.md). Módulo puro.
// Sem citação válida não há afirmação (Princípio IV): a resposta vira "não encontrei".

export interface Located {
  segmentId: number | null;
  start: number | null;
}

/** Acha o segmento (e o horário) da transcrição cujo texto contém a citação normalizada. */
export type SegmentLocator = (source: PromptSource, normalizedQuote: string) => Located | null;

export interface ChatValidation {
  answered: boolean;
  answer: string;
  citations: ChatCitationValue[];
}

const MARKER = /\[(\d{1,3})\]/g;

function label(source: PromptSource): string {
  const date = source.hit.meeting.date.slice(0, 10).split("-").reverse().slice(0, 2).join("/");
  return `Reunião ${source.hit.meeting.title} · ${date} · ${kindLabel(source)}`;
}

function citationFor(ref: number, quote: string, source: PromptSource, locate: SegmentLocator): ChatCitationValue {
  const normalizedQuote = normalizeText(quote);
  const exact = normalizedQuote.length > 0 && normalizeText(source.content).includes(normalizedQuote);
  const target: SearchTargetValue = { ...source.hit.target };
  if (exact && source.hit.kind === "transcript") {
    const found = locate(source, normalizedQuote);
    if (found) {
      target.segmentId = found.segmentId;
      target.start = found.start ?? target.start;
    }
  }
  return {
    ref,
    quote: exact ? quote.trim() : null,
    exact,
    label: label(source),
    proposed: source.hit.reviewStatus === "proposto",
    target,
  };
}

/** Mescla citações do mesmo trecho: fica a primeira, preferindo uma citação conferida. */
function merge(citations: ChatCitationValue[]): ChatCitationValue[] {
  const byRef = new Map<number, ChatCitationValue>();
  for (const c of citations) {
    const existing = byRef.get(c.ref);
    if (!existing || (!existing.exact && c.exact)) byRef.set(c.ref, c);
  }
  return [...byRef.values()].sort((a, b) => a.ref - b.ref);
}

const PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/** Colapsa espaços repetidos e tira o espaço antes de pontuação (varredura linear, sem regex). */
function tidyLine(line: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of line) {
    if (ch === " " || ch === "\t") {
      pendingSpace = out.length > 0 || pendingSpace;
      continue;
    }
    if (pendingSpace && !PUNCTUATION.has(ch)) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

/** Remove marcadores [n] sem citação válida; marcadores repetidos são mantidos. */
export function cleanMarkers(answer: string, valid: Set<number>): string {
  return answer
    .replace(MARKER, (whole, n: string) => (valid.has(Number(n)) ? whole : ""))
    .split("\n")
    .map(tidyLine)
    .join("\n")
    .trim();
}

export const NOT_FOUND: ChatValidation = { answered: false, answer: CHAT_NOT_FOUND_ANSWER, citations: [] };

/** `sources[n - 1]` é o trecho de número n enviado ao LLM. */
export function validateChat(llm: ChatLlmOutputValue, sources: PromptSource[], locate: SegmentLocator = () => null): ChatValidation {
  if (!llm.answered || !llm.answer.trim()) return NOT_FOUND;
  const citations = merge(
    llm.citations
      .filter((c) => Number.isInteger(c.ref) && c.ref >= 1 && c.ref <= sources.length)
      .map((c) => citationFor(c.ref, c.quote, sources[c.ref - 1], locate)),
  );
  if (!citations.length) return NOT_FOUND;
  const answer = cleanMarkers(llm.answer, new Set(citations.map((c) => c.ref)));
  return answer ? { answered: true, answer, citations } : NOT_FOUND;
}
