import { z } from "zod";

// Uso e custo de IA e auditoria visível (specs/004-uso-custo). Só metadados e números: nenhum
// tipo daqui carrega texto de reunião. O custo é o informado pelo provedor, nunca calculado.

export const USAGE_PURPOSES = ["ata", "adr", "itens", "resumo", "ao_vivo", "asr_final", "asr_ao_vivo", "busca", "chat", "outro"] as const;
export const UsagePurpose = z.enum(USAGE_PURPOSES);
export type UsagePurposeValue = z.infer<typeof UsagePurpose>;

export const USAGE_PURPOSE_LABELS: Record<UsagePurposeValue, string> = {
  ata: "Ata",
  adr: "ADR",
  itens: "Itens",
  resumo: "Resumo",
  ao_vivo: "Análise ao vivo",
  asr_final: "Transcrição final",
  asr_ao_vivo: "Transcrição ao vivo",
  busca: "Busca (embeddings)",
  chat: "Chat sobre reuniões",
  outro: "Outros",
};

export const USAGE_PROVIDERS = ["ollama", "openrouter", "claude", "codex", "whisper", "deepgram"] as const;
export const UsageProvider = z.enum(USAGE_PROVIDERS);
export type UsageProviderValue = z.infer<typeof UsageProvider>;

export const USAGE_PROVIDER_LABELS: Record<UsageProviderValue, string> = {
  ollama: "Modelo local (Ollama)",
  openrouter: "OpenRouter",
  claude: "Claude (assinatura)",
  codex: "Codex (assinatura)",
  whisper: "Whisper local",
  deepgram: "Deepgram (externo)",
};

export const USAGE_CATEGORIES = ["llm", "asr"] as const;
export const UsageCategory = z.enum(USAGE_CATEGORIES);
export type UsageCategoryValue = z.infer<typeof UsageCategory>;

export const USAGE_ERROR_CODES = [
  "timeout",
  "unavailable",
  "schema_invalid",
  "refused",
  "truncated",
  "disabled",
  "cancelled",
  "other",
] as const;
export const UsageErrorCode = z.union([z.enum(USAGE_ERROR_CODES), z.string().regex(/^http_\d{3}$/)]);
export type UsageErrorCodeValue = z.infer<typeof UsageErrorCode>;

export const USAGE_MAX_WINDOW_MONTHS = 24;

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use AAAA-MM");
const instant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "data inválida");

/** `month` ou `from`/`to` (nunca os dois); janela máxima de 24 meses; sem nada = mês corrente. */
export const UsagePeriodQuery = z
  .object({ month: monthParam.optional(), from: instant.optional(), to: instant.optional() })
  .superRefine((q, ctx) => {
    const range = q.from !== undefined || q.to !== undefined;
    if (q.month !== undefined && range) ctx.addIssue({ code: "custom", message: "use month ou from/to, não os dois" });
    if (range && (q.from === undefined || q.to === undefined)) ctx.addIssue({ code: "custom", message: "informe from e to" });
  });
export type UsagePeriodQueryInput = z.infer<typeof UsagePeriodQuery>;

export const UsageTotals = z.object({
  calls: z.number(),
  failedCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** soma só das linhas com custo informado; null se nenhuma tiver */
  costUsd: z.number().nullable(),
  pricedCalls: z.number(),
  audioSeconds: z.number(),
  durationMs: z.number(),
  /** tempo de inferência local; null se nenhuma linha mensurou */
  computeMs: z.number().nullable(),
});
export type UsageTotalsValue = z.infer<typeof UsageTotals>;

export const UsageGroup = UsageTotals.extend({ key: z.string(), label: z.string() });
export type UsageGroupValue = z.infer<typeof UsageGroup>;

export const UsagePeriod = z.object({ from: z.string(), to: z.string(), month: z.string().nullable() });
export type UsagePeriodValue = z.infer<typeof UsagePeriod>;

export const UsageAsrSplit = z.object({
  local: z.object({ audioSeconds: z.number(), computeMs: z.number().nullable(), calls: z.number() }),
  external: z.object({ audioSeconds: z.number(), costUsd: z.number().nullable(), calls: z.number() }),
});
export type UsageAsrSplitValue = z.infer<typeof UsageAsrSplit>;

export const RetentionInfo = z.object({ usageDays: z.number(), auditDays: z.number() });
export type RetentionInfoValue = z.infer<typeof RetentionInfo>;

export const UsageTopMeeting = UsageTotals.extend({ meetingId: z.string(), title: z.string() });
export type UsageTopMeetingValue = z.infer<typeof UsageTopMeeting>;

export const UsageReport = z.object({
  period: UsagePeriod,
  totals: UsageTotals,
  byPurpose: z.array(UsageGroup),
  byProvider: z.array(UsageGroup),
  byModel: z.array(UsageGroup),
  byDay: z.array(UsageGroup),
  asr: UsageAsrSplit,
  topMeetings: z.array(UsageTopMeeting),
  retention: RetentionInfo,
});
export type UsageReportValue = z.infer<typeof UsageReport>;

/** Painel de admin: o tipo não tem nenhum campo de reunião (garantia em compilação). */
export const AdminUsageReport = z.object({
  period: UsagePeriod,
  totals: UsageTotals,
  byUser: z.array(UsageGroup),
  byPurpose: z.array(UsageGroup),
  byProvider: z.array(UsageGroup),
  byModel: z.array(UsageGroup),
  byDay: z.array(UsageGroup),
  asr: UsageAsrSplit,
  retention: RetentionInfo,
});
export type AdminUsageReportValue = z.infer<typeof AdminUsageReport>;

export const USAGE_CALL_STATUSES = ["all", "ok", "error"] as const;

export const UsageCallsQuery = z.object({
  status: z.enum(USAGE_CALL_STATUSES).default("all"),
  purpose: UsagePurpose.optional(),
  provider: UsageProvider.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type UsageCallsQueryInput = z.infer<typeof UsageCallsQuery>;

export const UsageCall = z.object({
  id: z.number(),
  at: z.string(),
  purpose: UsagePurpose,
  provider: z.string(),
  model: z.string().nullable(),
  category: UsageCategory,
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  audioSeconds: z.number().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  computeMs: z.number().nullable(),
  attempts: z.number(),
  success: z.boolean(),
  errorCode: z.string().nullable(),
  meetingId: z.string().nullable(),
  meetingTitle: z.string().nullable(),
});
export type UsageCallValue = z.infer<typeof UsageCall>;

export const UsageCallsPage = z.object({ items: z.array(UsageCall), nextCursor: z.string().nullable() });
export type UsageCallsPageValue = z.infer<typeof UsageCallsPage>;

// ---------- auditoria visível ----------

export const AuditActor = z.object({ id: z.string().nullable(), username: z.string().nullable() });
export const AuditFieldValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const AuditEventView = z.object({
  id: z.number(),
  at: z.string(),
  kind: z.string(),
  /** rótulo em pt-BR montado no servidor */
  title: z.string(),
  actor: AuditActor.nullable(),
  target: AuditActor.nullable(),
  /** só chaves da lista permitida do tipo; nunca `detail` cru */
  fields: z.record(z.string(), AuditFieldValue),
});
export type AuditEventViewValue = z.infer<typeof AuditEventView>;

export const AuditPage = z.object({ items: z.array(AuditEventView), nextCursor: z.string().nullable() });
export type AuditPageValue = z.infer<typeof AuditPage>;

export const AuditQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
  kind: z.string().max(60).optional(),
  userId: z.guid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type AuditQueryInput = z.infer<typeof AuditQuery>;

export const AuditKindInfo = z.object({ kind: z.string(), label: z.string() });
export type AuditKindInfoValue = z.infer<typeof AuditKindInfo>;
