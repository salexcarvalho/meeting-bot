import { z } from "zod";

// Busca e chat sobre as reuniões (specs/003-busca-chat/contracts). O conteúdo de trechos só trafega
// nas respostas ao próprio usuário e nunca vai para log nem para auditoria (FR-033).

export const SEARCH_KINDS = ["transcript", "analysis", "item", "adr", "meeting"] as const;
export const SearchKind = z.enum(SEARCH_KINDS);
export type SearchKindValue = z.infer<typeof SearchKind>;

export const SEARCH_KIND_LABELS: Record<SearchKindValue, string> = {
  transcript: "Transcrição",
  analysis: "Ata",
  item: "Item",
  adr: "ADR",
  meeting: "Reunião",
};

export const SEARCH_MODES = ["hybrid", "text", "semantic"] as const;
export const SearchMode = z.enum(SEARCH_MODES);
export type SearchModeValue = z.infer<typeof SearchMode>;

export const SEARCH_QUERY_MAX = 500;
export const SEARCH_MAX_MEETING_FILTER = 20;
export const SEARCH_MAX_OFFSET = 100;
export const CHAT_HISTORY_MAX = 6;
export const CHAT_QUESTION_MAX = 500;
export const CHAT_MESSAGE_MAX = 1000;

/** Lista na query string: `a,b` ou `a&a=b`. */
function listParam<T extends z.ZodType>(item: T, max: number) {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === "") return undefined;
    const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(","));
    return parts.map((v) => v.trim()).filter(Boolean);
  }, z.array(item).max(max).optional());
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/;

const dateParam = z
  .string()
  .refine((v) => DATE_ONLY.test(v) || DATE_TIME.test(v), "use AAAA-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "data inválida");

export const SearchQuery = z.object({
  q: z.string().trim().min(1, "informe o que procurar").max(SEARCH_QUERY_MAX),
  mode: SearchMode.default("hybrid"),
  kind: listParam(SearchKind, SEARCH_KINDS.length),
  projectId: z.uuid().optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
  meetingId: listParam(z.uuid(), SEARCH_MAX_MEETING_FILTER),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(SEARCH_MAX_OFFSET).default(0),
});
export type SearchQueryInput = z.infer<typeof SearchQuery>;

export const SearchTarget = z.object({
  meetingId: z.string(),
  kind: SearchKind,
  segmentId: z.number().int().nullable(),
  start: z.number().nullable(),
  end: z.number().nullable(),
  itemId: z.string().nullable(),
  adrId: z.string().nullable(),
});
export type SearchTargetValue = z.infer<typeof SearchTarget>;

export const SnippetPart = z.object({ text: z.string(), match: z.boolean() });
export type SnippetPartValue = z.infer<typeof SnippetPart>;

export const SEARCH_MATCHED_BY = ["text", "semantic"] as const;
export const SEARCH_REVIEW_STATUS = ["proposto", "aprovado", "rejeitado"] as const;

export const SearchHit = z.object({
  id: z.number().int(),
  kind: SearchKind,
  meeting: z.object({
    id: z.string(),
    title: z.string(),
    date: z.string(),
    project: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
  snippet: z.array(SnippetPart),
  speaker: z.string().nullable(),
  matchedBy: z.array(z.enum(SEARCH_MATCHED_BY)),
  reviewStatus: z.enum(SEARCH_REVIEW_STATUS).nullable(),
  target: SearchTarget,
});
export type SearchHitValue = z.infer<typeof SearchHit>;

export const SEARCH_SEMANTIC_REASONS = [
  "ollama_indisponivel",
  "modelo_ausente",
  "sem_pgvector",
  "desligada",
  "indexando",
] as const;
export type SearchSemanticReason = (typeof SEARCH_SEMANTIC_REASONS)[number];

export const SearchSemanticInfo = z.object({
  available: z.boolean(),
  reason: z.enum(SEARCH_SEMANTIC_REASONS).nullable(),
});

export const SearchResponse = z.object({
  query: z.string(),
  mode: SearchMode,
  modeUsed: z.enum(["hybrid", "text", "semantic"]),
  semantic: SearchSemanticInfo,
  hits: z.array(SearchHit),
  total: z.number().int(),
  tookMs: z.number(),
});
export type SearchResponseValue = z.infer<typeof SearchResponse>;

// ---------- Chat ----------

export const ChatHistoryMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(CHAT_MESSAGE_MAX),
});

export const ChatScope = z
  .object({
    projectId: z.uuid().optional(),
    from: dateParam.optional(),
    to: dateParam.optional(),
    meetingIds: z.array(z.uuid()).max(SEARCH_MAX_MEETING_FILTER).optional(),
  })
  .strict();
export type ChatScopeValue = z.infer<typeof ChatScope>;

/** Estrito: `llm`, `provider` e qualquer outro campo desconhecido são recusados (o chat é sempre local, Q1-A). */
export const ChatRequest = z
  .object({
    question: z.string().trim().min(1).max(CHAT_QUESTION_MAX),
    history: z.array(ChatHistoryMessage).max(CHAT_HISTORY_MAX).optional(),
    scope: ChatScope.optional(),
  })
  .strict();
export type ChatRequestInput = z.infer<typeof ChatRequest>;

/** Saída do LLM local (contracts/chat-llm.md); os limites são conferidos depois com zod. */
export const ChatLlmOutput = z.object({
  answered: z.boolean(),
  answer: z.string().max(2500),
  citations: z
    .array(
      z.object({
        ref: z.number().int().min(1),
        quote: z.string().max(300),
      }),
    )
    .max(8),
});
export type ChatLlmOutputValue = z.infer<typeof ChatLlmOutput>;

export const ChatCitation = z.object({
  ref: z.number().int(),
  quote: z.string().nullable(),
  exact: z.boolean(),
  label: z.string(),
  proposed: z.boolean(),
  target: SearchTarget,
});
export type ChatCitationValue = z.infer<typeof ChatCitation>;

export const ChatResponse = z.object({
  answered: z.boolean(),
  answer: z.string(),
  citations: z.array(ChatCitation),
  sources: z.array(SearchHit),
  retrieval: z.object({
    modeUsed: z.enum(["hybrid", "text"]),
    chunks: z.number().int(),
    belowThreshold: z.boolean(),
  }),
  model: z.string(),
  liveBusy: z.boolean(),
  tookMs: z.number(),
});
export type ChatResponseValue = z.infer<typeof ChatResponse>;

export const CHAT_NOT_FOUND_ANSWER = "Não encontrei registro sobre isso nas reuniões que você pode ler.";

// ---------- Estado do índice ----------

export const SEARCH_INDEX_STATUSES = ["pending", "indexing", "text_ready", "indexed", "failed"] as const;
export const SearchIndexStatus = z.enum(SEARCH_INDEX_STATUSES);
export type SearchIndexStatusValue = z.infer<typeof SearchIndexStatus>;

export const SearchStatus = z.object({
  enabled: z.boolean(),
  semantic: z.object({
    available: z.boolean(),
    model: z.string(),
    dim: z.number().int(),
    reason: z.enum(SEARCH_SEMANTIC_REASONS).nullable(),
  }),
  /** o chat precisa do LLM local e da busca semântica ligada (no servidor de teste fica desligado, Q3-A) */
  chat: z.object({ available: z.boolean(), reason: z.enum(["desligado", "ollama_indisponivel"]).nullable() }),
  paused: z.literal("reuniao_ao_vivo").nullable(),
  totals: z.object({
    meetings: z.number().int(),
    indexed: z.number().int(),
    textReady: z.number().int(),
    pending: z.number().int(),
    failed: z.number().int(),
    chunks: z.number().int(),
  }),
  failures: z.array(z.object({ meetingId: z.string(), title: z.string(), error: z.string(), attempts: z.number().int() })),
});
export type SearchStatusValue = z.infer<typeof SearchStatus>;

export const SearchMeetingStatus = z.object({
  meetingId: z.string(),
  status: SearchIndexStatus,
  chunkCount: z.number().int(),
  embeddedCount: z.number().int(),
  indexedAt: z.string().nullable(),
});
export type SearchMeetingStatusValue = z.infer<typeof SearchMeetingStatus>;

export const SearchReindexInput = z.object({ meetingId: z.uuid().optional() }).strict();
export type SearchReindexInputValue = z.infer<typeof SearchReindexInput>;

/** Resumo no `GET /system/status`. */
export const SearchSystemInfo = z.object({ enabled: z.boolean(), semantic: z.boolean(), paused: z.boolean() });
export type SearchSystemInfoValue = z.infer<typeof SearchSystemInfo>;
