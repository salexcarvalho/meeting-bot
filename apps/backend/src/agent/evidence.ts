import type { Channel, Extracao, ItemAttributes, ItemType } from "@meeting-bot/contracts";
import type { WindowMap, WindowSegment } from "./prompts";
import { words } from "./text";

// Validação da saída do LLM contra a janela enviada (contracts/llm-schemas.md §1).

export interface EvidenceInput {
  segmentId: number | null;
  start: number;
  end: number;
  channel: Channel;
  quote: string | null;
}

export interface ValidItem {
  type: ItemType;
  description: string;
  owner: string | null;
  due: string | null;
  attributes: ItemAttributes;
  evidence: EvidenceInput[];
}

const MIN_QUOTE_MATCH = 0.6;
const MIN_DESCRIPTION = 8;

function normalizeRef(ref: string): string | null {
  const m = /^\s*\[?s?\s*(\d{1,5})\]?\s*$/i.exec(ref);
  return m ? `S${Number(m[1])}` : null;
}

export function quoteMatches(quote: string, text: string): boolean {
  const q = words(quote).filter((w) => w.length >= 3);
  if (!q.length) return false;
  const pool = new Set(words(text));
  const hits = q.filter((w) => pool.has(w)).length;
  return hits / q.length >= MIN_QUOTE_MATCH;
}

const nullable = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

export function validateExtraction(extracao: Extracao, map: WindowMap): ValidItem[] {
  const out: ValidItem[] = [];
  for (const item of extracao.itens) {
    const refs = [...new Set(item.segmentos.map(normalizeRef).filter((r): r is string => Boolean(r)))];
    const cited = refs
      .filter((r) => !map.context.has(r))
      .map((r) => map.cite.get(r))
      .filter((s): s is WindowSegment => Boolean(s));
    if (!cited.length) continue;
    if (!quoteMatches(item.citacao, cited.map((s) => s.text).join(" "))) continue;
    const description = item.descricao.trim();
    if (description.length < MIN_DESCRIPTION) continue;

    // A citação fica no segmento que mais a contém.
    const quote = item.citacao.trim();
    const best = cited.reduce((a, b) => (score(quote, b.text) > score(quote, a.text) ? b : a));
    out.push({
      type: item.tipo,
      description,
      owner: nullable(item.responsavel),
      due: nullable(item.prazo),
      attributes: {
        dependencia: nullable(item.dependencia),
        motivacao: nullable(item.motivacao),
        impacto: nullable(item.impacto),
        sistema: nullable(item.sistema),
        categoria: item.tipo === "risco" ? item.categoria : null,
        ...(item.tipo === "pendencia" ? { status_acao: "aberta" as const } : {}),
      },
      evidence: cited
        .sort((a, b) => a.start - b.start)
        .map((s) => ({
          segmentId: s.id,
          start: s.start,
          end: s.end,
          channel: s.channel,
          quote: s === best ? quote : null,
        })),
    });
  }
  return out;
}

function score(quote: string, text: string): number {
  const pool = new Set(words(text));
  return words(quote).filter((w) => pool.has(w)).length;
}
