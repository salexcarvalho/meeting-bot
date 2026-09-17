import {
  AdrSugerido,
  Consolidacao,
  Extracao,
  Narrativa,
  type Adr,
  type Item,
  type ProcessingStep,
} from "@meeting-bot/contracts";
import type { GenerateRequest } from "../llm/provider";
import { chunkSegments } from "./chunks";
import type { ValidItem } from "./evidence";
import { validateExtraction } from "./evidence";
import {
  adrUser,
  consolidationUser,
  extractionUser,
  formatWindow,
  narrativeUser,
  SYSTEM_ADR,
  SYSTEM_CONSOLIDACAO,
  SYSTEM_EXTRACAO,
  SYSTEM_NARRATIVA,
  type WindowSegment,
} from "./prompts";

// Análise pós-reunião em map-reduce (contracts/llm-schemas.md, "Pós-reunião").

export interface PostContext {
  title: string;
  project: string | null;
  participants: string[];
  liveSummary: string | null;
  /** resumo executivo da última análise (contexto dos ADRs gerados sob demanda) */
  analysisSummary: string | null;
  /** já houve análise pós-reunião: gerar de novo substitui o que ninguém revisou */
  regenerating: boolean;
  segments: WindowSegment[];
}

export interface PostAnalysisDeps {
  loadContext(meetingId: string): Promise<PostContext | null>;
  /** já ligado ao provedor escolhido (local ou OpenRouter) */
  generate<T>(req: GenerateRequest<T>): Promise<T>;
  /** tamanho do trecho por chamada; modelos externos aguentam trechos maiores */
  chunkTokens?: number;
  listItems(meetingId: string): Promise<Item[]>;
  listAdrs(meetingId: string): Promise<Adr[]>;
  createAiItems(meetingId: string, items: ValidItem[], origin: "final"): Promise<{ created: number; merged: number }>;
  mergeInto(meetingId: string, keepId: string, removeIds: string[]): Promise<string[]>;
  /** apaga os itens propostos pela IA que ninguém revisou; devolve quantos */
  clearUnreviewed(meetingId: string): Promise<number>;
  /** itens por chamada de consolidação; modelos externos aguentam mais */
  consolidationItems?: number;
  resetChunkNotes(meetingId: string): Promise<void>;
  saveChunkNote(meetingId: string, start: number, end: number, text: string): Promise<void>;
  saveSummary(meetingId: string, summary: string): Promise<void>;
  saveAnalysis(meetingId: string, analysis: Narrativa): Promise<void>;
  /** false quando o ADR está travado (aprovado, rejeitado ou editado à mão) */
  upsertAdr(meetingId: string, itemId: string, adr: AdrSugerido): Promise<boolean>;
}

export interface AdrRunResult {
  generated: number;
  skipped: number;
  failed: number;
}

export const POST_NUM_CTX = 8192;
const CHUNK_TOKENS = 2_000;
const CHUNK_OVERLAP = 2;
const MAX_NARRATIVE_ITEMS = 80;
const MAX_CONSOLIDATION_ITEMS = 60;
const MAX_REVIEWED_ANCHORS = 40;
const ADR_CONTEXT_S = 60;

type Report = (step: ProcessingStep, progress?: number) => void;

const isInvalidLlm = (err: unknown) => /Resposta do LLM inválida/.test((err as Error).message);

export async function runPostAnalysis(meetingId: string, report: Report, deps: PostAnalysisDeps): Promise<void> {
  const ctx = await deps.loadContext(meetingId);
  if (!ctx) return;
  const tag = meetingId.slice(0, 8);

  // 0. Gerar de novo começa do zero: sai o que a IA propôs e ninguém revisou.
  if (ctx.regenerating) {
    const removed = await deps.clearUnreviewed(meetingId);
    if (removed) console.log(`[pós ${tag}] ${removed} itens não revisados substituídos pela nova geração`);
  }

  // 1. Extração por chunk (itens `final`; os ao vivo prevalecem na deduplicação).
  await deps.resetChunkNotes(meetingId);
  const chunks = chunkSegments(ctx.segments, deps.chunkTokens ?? CHUNK_TOKENS, CHUNK_OVERLAP);
  const summaries: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    report("analisando", i / Math.max(chunks.length, 1));
    const context = i > 0 ? chunk.slice(0, CHUNK_OVERLAP) : [];
    const citeable = i > 0 ? chunk.slice(CHUNK_OVERLAP) : chunk;
    if (!citeable.length) continue;
    const { text, map } = formatWindow(citeable, context);
    try {
      const result = await deps.generate({
        system: SYSTEM_EXTRACAO,
        user: extractionUser({ title: ctx.title, project: ctx.project, summary: null, window: text }),
        schema: Extracao,
        numCtx: POST_NUM_CTX,
        label: `extração final ${tag} ${i + 1}/${chunks.length}`,
        meetingId,
      });
      const valid = validateExtraction(result, map);
      await deps.createAiItems(meetingId, valid, "final");
      const summary = result.resumo_trecho.trim();
      if (summary) summaries.push(summary);
      await deps.saveChunkNote(meetingId, citeable[0].start, citeable[citeable.length - 1].end, summary);
    } catch (err) {
      if (!isInvalidLlm(err)) throw err;
      console.warn(`[pós ${tag}] chunk ${i + 1} descartado: ${(err as Error).message}`);
    }
  }
  report("analisando", 1);

  // 2. Consolidação final: junta propostos repetidos (entre si e com os já revisados), por lotes de tipo.
  let summary = ctx.liveSummary;
  const current = await deps.listItems(meetingId);
  const proposed = current.filter((i) => i.reviewStatus === "proposto");
  const reviewed = current.filter((i) => i.reviewStatus !== "proposto").slice(-MAX_REVIEWED_ANCHORS);
  const batches = batchByType(proposed, deps.consolidationItems ?? MAX_CONSOLIDATION_ITEMS);
  if (!batches.length && summaries.length) batches.push([]);
  for (const [n, batch] of batches.entries()) {
    const types = new Set(batch.map((i) => i.type));
    const anchors = reviewed.filter((i) => types.has(i.type));
    const refs = new Map<string, Item>([
      ...batch.map((item, i) => [`I${i + 1}`, item] as const),
      ...anchors.map((item, i) => [`R${i + 1}`, item] as const),
    ]);
    const describe = (ref: string, item: Item) => ({ ref, type: item.type, description: item.description });
    try {
      const result = await deps.generate({
        system: SYSTEM_CONSOLIDACAO,
        user: consolidationUser({
          title: ctx.title,
          summary: ctx.liveSummary,
          // o resumo sai do primeiro lote; os demais só procuram repetidos
          windowSummaries: n === 0 ? summaries : [],
          items: [...refs].filter(([ref]) => ref.startsWith("I")).map(([ref, item]) => describe(ref, item)),
          reviewed: [...refs].filter(([ref]) => ref.startsWith("R")).map(([ref, item]) => describe(ref, item)),
        }),
        schema: Consolidacao,
        numCtx: POST_NUM_CTX,
        label: `consolidação final ${tag}${batches.length > 1 ? ` ${n + 1}/${batches.length}` : ""}`,
        meetingId,
      });
      if (n === 0 && result.resumo.trim()) {
        summary = result.resumo.trim().slice(0, 1200);
        await deps.saveSummary(meetingId, summary);
      }
      for (const group of result.duplicados) {
        const keep = refs.get(group.manter.trim().toUpperCase());
        if (!keep) continue;
        const remove = group.remover
          .map((r) => refs.get(r.trim().toUpperCase()))
          .filter(
            (i): i is Item =>
              Boolean(i) && i!.id !== keep.id && i!.type === keep.type && i!.reviewStatus === "proposto",
          );
        if (remove.length) await deps.mergeInto(meetingId, keep.id, remove.map((i) => i.id));
      }
    } catch (err) {
      if (!isInvalidLlm(err)) throw err;
      console.warn(`[pós ${tag}] consolidação descartada: ${(err as Error).message}`);
    }
  }

  // 3. Narrativa da ata.
  report("ata");
  const items = (await deps.listItems(meetingId)).filter((i) => i.reviewStatus !== "rejeitado");
  const narrative = await deps.generate({
    system: SYSTEM_NARRATIVA,
    user: narrativeUser({
      title: ctx.title,
      project: ctx.project,
      participants: ctx.participants,
      chunkSummaries: summaries.length ? summaries : summary ? [summary] : [],
      items: items.slice(0, MAX_NARRATIVE_ITEMS).map((i) => ({ type: i.type, description: i.description })),
    }),
    schema: Narrativa,
    numCtx: POST_NUM_CTX,
    label: `narrativa ${tag}`,
    meetingId,
  });
  await deps.saveAnalysis(meetingId, narrative);

  // 4. ADR sugerido por decisão arquitetural não rejeitada.
  await runAdrGeneration(meetingId, report, deps, { ctx, items, summary: narrative.resumo_executivo });
}

/**
 * Gera (ou regenera) os ADRs sugeridos. Sem `itemId`, todas as decisões arquiteturais não
 * rejeitadas; ADRs aprovados, rejeitados ou editados à mão ficam como estão.
 */
export async function runAdrGeneration(
  meetingId: string,
  report: Report,
  deps: PostAnalysisDeps,
  opts: { itemId?: string; ctx?: PostContext; items?: Item[]; summary?: string | null } = {},
): Promise<AdrRunResult> {
  const result: AdrRunResult = { generated: 0, skipped: 0, failed: 0 };
  const ctx = opts.ctx ?? (await deps.loadContext(meetingId));
  if (!ctx) return result;
  const tag = meetingId.slice(0, 8);
  const items = opts.items ?? (await deps.listItems(meetingId)).filter((i) => i.reviewStatus !== "rejeitado");
  const summary = opts.summary !== undefined ? opts.summary : (ctx.analysisSummary ?? ctx.liveSummary);

  const decisions = items.filter(
    (i) => i.type === "decisao_arquitetural" && i.reviewStatus !== "rejeitado" && (!opts.itemId || i.id === opts.itemId),
  );
  const adrs = new Map((await deps.listAdrs(meetingId)).map((a) => [a.itemId, a]));
  for (const [i, decision] of decisions.entries()) {
    report("adrs", i / decisions.length);
    const existing = adrs.get(decision.id);
    if (existing && existing.status !== "proposto") {
      result.skipped++;
      continue;
    }
    const window = evidenceWindow(ctx.segments, decision);
    const { text } = formatWindow(window);
    try {
      const adr = await deps.generate({
        system: SYSTEM_ADR,
        user: adrUser({ decision: decision.description, summary, window: text }),
        schema: AdrSugerido,
        numCtx: POST_NUM_CTX,
        label: `ADR ${tag} ${i + 1}/${decisions.length}`,
        meetingId,
      });
      if (await deps.upsertAdr(meetingId, decision.id, adr)) result.generated++;
      else result.skipped++;
    } catch (err) {
      if (!isInvalidLlm(err)) throw err;
      result.failed++;
      console.warn(`[pós ${tag}] ADR descartado: ${(err as Error).message}`);
    }
  }
  report("adrs", 1);
  return result;
}

/** Lotes de até `limit` itens sem separar um tipo (repetidos são sempre do mesmo tipo). */
export function batchByType(items: Item[], limit: number): Item[][] {
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.type, [...(groups.get(item.type) ?? []), item]);
  const batches: Item[][] = [];
  let batch: Item[] = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += limit) {
      const part = group.slice(start, start + limit);
      if (batch.length + part.length > limit) {
        batches.push(batch);
        batch = [];
      }
      batch.push(...part);
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Segmentos das evidências com ±60 s de contexto.
export function evidenceWindow(segments: WindowSegment[], item: Item): WindowSegment[] {
  const ranges = item.evidence.map((e) => [e.start - ADR_CONTEXT_S, e.end + ADR_CONTEXT_S] as const);
  if (!ranges.length) return [];
  return segments.filter((s) => ranges.some(([from, to]) => s.end >= from && s.start <= to));
}
