import {
  ChatLlmOutput,
  CHAT_NOT_FOUND_ANSWER,
  type ChatLlmOutputValue,
  type ChatRequestInput,
  type ChatResponseValue,
  type LlmChoice,
  type SearchHitValue,
} from "@meeting-bot/contracts";
import { normalizeText } from "../../agent/text";
import { POST_NUM_CTX } from "../../agent/postAnalysis";
import { config } from "../../config";
import { pool } from "../../db";
import { generate as realGenerate, generationBlock, generationLabel, isSubscription } from "../../llm";
import type { GenerateRequest } from "../../llm/provider";
import type { User } from "../../types";
import { liveBusy } from "../gate";
import { fuseRetrieval, hydrate, retrieve, type HydratedHit, type ScopeFilters } from "../query";
import { buildMessages, estimateTokens, selectSources, type PromptSource } from "./prompt";
import { validateChat, type SegmentLocator } from "./validate";

// Chat RAG (specs/003-busca-chat/contracts/chat-llm.md). O contexto do LLM vem SOMENTE da
// consulta de `query.ts`, já filtrada por permissão e escopo; o histórico vive no cliente (Q2-A).
// Não há LLM local (constituição 3.0.0): a pergunta e os trechos recuperados vão ao mesmo provedor
// da geração automática (LLM_GENERATION_PROVIDER, exige ALLOW_EXTERNAL_LLM=true). A assinatura
// (claude/codex) é pessoal: só vale se o dono de cada reunião citada é o dono do host-agent.

const TOP_CANDIDATES = 12;
const LIVE_NUM_CTX = 4096;
const LABEL = "chat";

const GENERIC_UNAVAILABLE = "O LLM não respondeu agora. Tente de novo em instantes.";

export class ChatUnavailableError extends Error {
  constructor(message = GENERIC_UNAVAILABLE) {
    super(message);
    this.name = "ChatUnavailableError";
  }
}

type Generator = <T>(priority: "live" | "post", req: GenerateRequest<T>, provider: LlmChoice) => Promise<T>;

let generator: Generator = realGenerate;

/** Só para testes: troca o LLM (sem chamar provedor externo). */
export function setChatGenerator(fn: Generator | null): void {
  generator = fn ?? realGenerate;
}

function scopeOf(scope: ChatRequestInput["scope"]): ScopeFilters {
  return { projectId: scope?.projectId, from: scope?.from, to: scope?.to, meetingIds: scope?.meetingIds };
}

/** Pergunta de seguimento: o embedding leva também a última pergunta anterior do usuário. */
function semanticText(question: string, history: ChatRequestInput["history"]): string {
  const previous = [...(history ?? [])].reverse().find((m) => m.role === "user");
  return previous ? `${previous.content}\n${question}` : question;
}

interface Segment {
  id: number;
  text: string;
  start: number;
}

async function loadSegments(sources: PromptSource[]): Promise<Map<number, Segment[]>> {
  const out = new Map<number, Segment[]>();
  await Promise.all(
    sources
      .filter((s) => s.hit.kind === "transcript" && s.hit.target.start !== null)
      .map(async (s) => {
        const { rows } = await pool.query(
          `SELECT id, text, start_seconds FROM transcript_segments
            WHERE meeting_id = $1 AND pass = 'final' AND start_seconds >= $2 AND start_seconds <= $3
            ORDER BY start_seconds, id`,
          [s.hit.meeting.id, s.hit.target.start, s.hit.target.end ?? s.hit.target.start],
        );
        out.set(s.hit.id, rows.map((r) => ({ id: Number(r.id), text: r.text as string, start: Number(r.start_seconds) })));
      }),
  );
  return out;
}

function locatorFor(segments: Map<number, Segment[]>): SegmentLocator {
  return (source, quote) => {
    const list = segments.get(source.hit.id) ?? [];
    const found = list.find((s) => normalizeText(s.text).includes(quote));
    return found ? { segmentId: found.id, start: found.start } : null;
  };
}

function isRelevant(hit: HydratedHit, strictText: boolean): boolean {
  const min = config.search.chatMinSimilarity;
  return (strictText && hit.lexical) || (hit.similarity !== null && hit.similarity >= min);
}

function refusal(started: number, extra: Partial<ChatResponseValue["retrieval"]>, live: boolean): ChatResponseValue {
  return {
    answered: false,
    answer: CHAT_NOT_FOUND_ANSWER,
    citations: [],
    sources: [],
    retrieval: { modeUsed: "hybrid", chunks: 0, belowThreshold: true, ...extra },
    model: generationLabel(config.generationProvider),
    liveBusy: live,
    tookMs: Date.now() - started,
  };
}

/** Por que o provedor configurado não pode receber estes trechos agora (null = pode). */
async function providerBlock(sources: PromptSource[]): Promise<string | null> {
  const provider = config.generationProvider;
  if (!isSubscription(provider)) return generationBlock(provider, null);
  const ids = [...new Set(sources.map((s) => s.hit.meeting.id))];
  const { rows } = await pool.query(`SELECT DISTINCT created_by FROM meetings WHERE id = ANY($1::uuid[])`, [ids]);
  for (const row of rows) {
    const reason = await generationBlock(provider, row.created_by as string | null);
    if (reason) return reason;
  }
  return null;
}

async function callModel(user: User, messages: { system: string; user: string }, live: boolean, sources: PromptSource[]) {
  const blocked = await providerBlock(sources);
  if (blocked) throw new ChatUnavailableError(blocked);
  const request: GenerateRequest<ChatLlmOutputValue> = {
    system: messages.system,
    user: messages.user,
    schema: ChatLlmOutput,
    numCtx: live ? LIVE_NUM_CTX : POST_NUM_CTX,
    label: LABEL,
    purpose: "chat",
    userId: user.id,
  };
  try {
    return await generator("post", request, config.generationProvider);
  } catch (err) {
    throw err instanceof ChatUnavailableError ? err : new ChatUnavailableError();
  }
}

/** Pergunta → recuperação com permissão → limiar → LLM externo → validação das citações. */
export async function answerQuestion(user: User, input: ChatRequestInput): Promise<ChatResponseValue> {
  const started = Date.now();
  const live = await liveBusy();
  const filters = scopeOf(input.scope);
  const retrieval = await retrieve(user, input.question, filters, {
    mode: "hybrid",
    orFallback: true,
    semanticText: semanticText(input.question, input.history),
  });
  const ranked = fuseRetrieval(retrieval, false).slice(0, TOP_CANDIDATES);
  const hydrated = await hydrate(user, ranked, input.question, filters);
  const relevant = hydrated.filter((h) => isRelevant(h, retrieval.textStrict));
  if (!relevant.length) return refusal(started, {}, live);

  const budget = live ? config.search.chatContextTokensLive : config.search.chatContextTokens;
  const sources = selectSources(
    relevant.map((h) => ({ hit: h.hit, content: h.content })),
    { tokens: budget - estimateTokens(input.question) - 400 },
  );
  if (!sources.length) return refusal(started, { belowThreshold: false }, live);

  const messages = buildMessages(input.question, input.history ?? [], sources);
  const output = await callModel(user, messages, live, sources);
  const checked = validateChat(output, sources, locatorFor(await loadSegments(sources)));
  const modeUsed = retrieval.modeUsed === "text" ? "text" : "hybrid";
  if (!checked.answered) return refusal(started, { modeUsed, chunks: sources.length, belowThreshold: false }, live);
  const sourceHits: SearchHitValue[] = sources.map((s) => s.hit);
  return {
    answered: true,
    answer: checked.answer,
    citations: checked.citations,
    sources: sourceHits,
    retrieval: { modeUsed, chunks: sources.length, belowThreshold: false },
    model: generationLabel(config.generationProvider),
    liveBusy: live,
    tookMs: Date.now() - started,
  };
}
