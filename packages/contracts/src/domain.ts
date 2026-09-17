import { z } from "zod";
import type { BotProgress } from "./platform";

// Vocabulário do domínio compartilhado por backend, frontend e documentação
// (specs/001-agente-reunioes-mvp/data-model.md).

export const PLATFORMS = ["meet", "teams", "upload", "other", "none"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SOURCES = ["bot", "upload", "ics", "manual"] as const;
export type MeetingSource = (typeof SOURCES)[number];

export const MEETING_STATUSES = [
  "scheduled",
  "skipped",
  "cancelled",
  "missed",
  "recording",
  "stopping",
  "queued",
  "joining",
  "waiting_admission",
  "in_call",
  "transcribing",
  "generating_ata",
  "done",
  "error",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export type StatusLabel =
  | "Próxima"
  | "Em andamento"
  | "Transcrevendo"
  | "Processando"
  | "Concluída"
  | "Não gravada"
  | "Cancelada"
  | "Erro";

export const STATUS_LABELS: Record<MeetingStatus, StatusLabel> = {
  scheduled: "Próxima",
  recording: "Em andamento",
  stopping: "Em andamento",
  joining: "Em andamento",
  waiting_admission: "Em andamento",
  in_call: "Em andamento",
  queued: "Transcrevendo",
  transcribing: "Transcrevendo",
  generating_ata: "Processando",
  done: "Concluída",
  skipped: "Não gravada",
  missed: "Não gravada",
  cancelled: "Cancelada",
  error: "Erro",
};

// Estados em que nada está rodando para a reunião.
export const IDLE_STATUSES: MeetingStatus[] = ["scheduled", "skipped", "cancelled", "missed", "done", "error"];

export const CHANNELS = ["mic", "remote", "mixed"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PASSES = ["live", "final"] as const;
export type TranscriptPass = (typeof PASSES)[number];

// Rótulo fixo do canal do microfone (nome exibido vem de USER_DISPLAY_NAME).
export const USER_SPEAKER_LABEL = "user";
export const REMOTE_SPEAKER_LABEL = "Remoto";

export const ITEM_TYPES = [
  "decisao",
  "decisao_arquitetural",
  "pendencia",
  "risco",
  "requisito_funcional",
  "requisito_nao_funcional",
  "regra_negocio",
  "restricao",
  "premissa",
  "pergunta_aberta",
  "debito_tecnico",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  decisao: "Decisão",
  decisao_arquitetural: "Decisão arquitetural",
  pendencia: "Pendência",
  risco: "Risco",
  requisito_funcional: "Requisito funcional",
  requisito_nao_funcional: "Requisito não funcional",
  regra_negocio: "Regra de negócio",
  restricao: "Restrição",
  premissa: "Premissa",
  pergunta_aberta: "Pergunta em aberto",
  debito_tecnico: "Débito técnico",
};

export const RISK_CATEGORIES = [
  "arquitetura",
  "seguranca",
  "infraestrutura",
  "prazo",
  "integracao",
  "dados",
  "performance",
  "escalabilidade",
  "governanca",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  arquitetura: "Arquitetura",
  seguranca: "Segurança",
  infraestrutura: "Infraestrutura",
  prazo: "Prazo",
  integracao: "Integração",
  dados: "Dados",
  performance: "Performance",
  escalabilidade: "Escalabilidade",
  governanca: "Governança",
};

export const REVIEW_STATUSES = ["proposto", "aprovado", "rejeitado"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ITEM_ORIGINS = ["live", "final", "manual"] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

export const ItemAttributes = z.object({
  dependencia: z.string().max(300).nullish(),
  status_acao: z.enum(["aberta", "concluida"]).nullish(),
  motivacao: z.string().max(500).nullish(),
  impacto: z.string().max(500).nullish(),
  sistema: z.string().max(200).nullish(),
  categoria: z.enum(RISK_CATEGORIES).nullish(),
});
export type ItemAttributes = z.infer<typeof ItemAttributes>;

export interface Attendee {
  name: string;
  email: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
  suggested: boolean;
}

export interface MeetingSummary {
  id: string;
  title: string;
  platform: Platform;
  url: string | null;
  status: MeetingStatus;
  statusLabel: StatusLabel;
  source: MeetingSource;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  project: ProjectRef | null;
  skipRecording: boolean;
  organizer: string | null;
  attendees: Attendee[];
  errorMessage: string | null;
  botActive: boolean;
  /** etapa de entrada do bot (Modo Agente), só enquanto ele entra */
  botProgress: BotProgress | null;
  /** nome com que o bot entrou/entra na reunião */
  botDisplayName: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface Segment {
  id: number;
  channel: Channel;
  pass: TranscriptPass;
  speaker: string | null;
  speakerName: string | null;
  text: string;
  start: number;
  end: number;
}

export interface Speaker {
  label: string;
  displayName: string;
  isUser: boolean;
}

export interface AudioChannelInfo {
  channel: Channel;
  format: string;
  durationSeconds: number | null;
}

export interface Evidence {
  segmentId: number | null;
  start: number;
  end: number;
  channel: Channel;
  quote: string | null;
}

export interface Item {
  id: string;
  meetingId: string;
  type: ItemType;
  description: string;
  owner: string | null;
  due: string | null;
  attributes: ItemAttributes;
  reviewStatus: ReviewStatus;
  origin: ItemOrigin;
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** quem gerou: "local:<modelo>" ou "openrouter:<modelo>"; null = manual ou anterior ao registro */
  generatedBy: string | null;
}

export interface ItemHistoryEntry {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: { id: string; username: string } | null;
  createdAt: string;
}

export interface AdrAlternative {
  opcao: string;
  pros: string;
  contras: string;
}

export interface Adr {
  id: string;
  itemId: string;
  meetingId: string;
  number: number | null;
  code: string | null;
  title: string;
  context: string;
  problem: string;
  alternatives: AdrAlternative[];
  decision: string;
  consequences: string;
  risks: string[];
  status: ReviewStatus;
  approvedAt: string | null;
  /** "local:<modelo>" ou "openrouter:<modelo>" da última geração */
  generatedBy: string | null;
}

export interface Project {
  id: string;
  name: string;
  keywords: string[];
  meetingCount: number;
}

export type CaptureState = "recording" | "restarting" | "unavailable";

export interface ChannelCapture {
  state: CaptureState;
  device: string | null;
  bytes: number;
}

export interface HostAgentCapture {
  meetingId: string;
  channels: Partial<Record<"mic" | "remote", ChannelCapture>>;
}

export interface HostAgentStatus {
  online: boolean;
  lastSeenAt: string | null;
  version: string | null;
  capture: HostAgentCapture | null;
}

export interface GpuStats {
  name?: string;
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

export interface AgentMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  url: string | null;
  platform: Platform;
  skipRecording: boolean;
  status: MeetingStatus;
}

export interface MeetingDetail {
  meeting: MeetingSummary;
  segments: Segment[];
  speakers: Speaker[];
  audio: AudioChannelInfo[];
  liveSummary: string | null;
  liveSummaryAt: string | null;
  hasScreenshot: boolean;
  legacyAta: string | null;
  hasAnalysis: boolean;
  /** "worker-gpu" ou "openrouter:<modelo>" (ASR externo de teste) */
  transcriptionProvider: string | null;
  /** escolha para o próximo passe final; null = padrão do .env */
  asrProvider: string | null;
  /** acesso de quem pediu: dono, compartilhada com edição ou só leitura */
  access: "owner" | "edit" | "read";
  /** quem gerou a análise da ata: "local:<modelo>", "openrouter:<modelo>", "claude:<modelo>" ou "codex:<modelo>" */
  analysisProvider: string | null;
}

export type AsrProvider = "local" | "openrouter";

// LLM das gerações (ata, itens pós-reunião, ADR). Ao vivo é sempre local (Constituição 1.4.0).
// claude/codex: CLI oficial com a assinatura do dono do host-agent, executado pelo host-agent.
export const LLM_CHOICES = ["local", "openrouter", "claude", "codex"] as const;
export type LlmChoice = (typeof LLM_CHOICES)[number];
export const SUBSCRIPTION_LLMS = ["claude", "codex"] as const;
export type SubscriptionLlm = (typeof SUBSCRIPTION_LLMS)[number];

export interface SubscriptionLlmOption {
  id: SubscriptionLlm;
  model: string;
  available: boolean;
  /** por que não dá para usar agora (host-agent desligado, sem login, reunião de outra pessoa) */
  reason: string | null;
}

export interface LlmOptions {
  /** provedor da geração automática ao fim da reunião (LLM_GENERATION_PROVIDER) */
  default: LlmChoice;
  local: { model: string };
  external: { model: string; available: boolean } | null;
  /** assinaturas habilitadas no .env (a disponibilidade depende da reunião e do host-agent) */
  subscriptions: SubscriptionLlmOption[];
}

export const GenerateAdrsRequest = z.object({
  llm: z.enum(LLM_CHOICES).optional(),
  /** só a decisão arquitetural indicada; sem ele, todas as pendentes */
  itemId: z.uuid().optional(),
});
export type GenerateAdrsRequest = z.infer<typeof GenerateAdrsRequest>;

export interface AsrOptions {
  default: AsrProvider;
  external: { model: string; available: boolean; isDefault: boolean } | null;
}

export interface AgendaResponse {
  date: string;
  timezone: string;
  meetings: MeetingSummary[];
  hostAgent: HostAgentStatus;
  recordingMeetingId: string | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  ignored: number;
  /** Reuniões que vieram só com a ocorrência do dia, sem a regra de repetição da série. */
  partialSeries: string[];
  errors: { file: string; message: string }[];
}

// ---------- corpos de requisição validados no backend ----------

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "data inválida");

export const ScheduledMeetingInput = z.object({
  title: z.string().trim().min(1, "Informe o título.").max(300),
  start: isoDate,
  durationMinutes: z.number().int().min(5, "Duração mínima de 5 min.").max(720, "Duração máxima de 12 h."),
  url: z.string().trim().max(2000).nullish(),
  projectId: z.uuid().nullish(),
});
export type ScheduledMeetingInput = z.infer<typeof ScheduledMeetingInput>;

export const ScheduledMeetingPatch = ScheduledMeetingInput.partial();
export type ScheduledMeetingPatch = z.infer<typeof ScheduledMeetingPatch>;

export const ItemPatch = z
  .object({
    type: z.enum(ITEM_TYPES),
    description: z.string().trim().min(5).max(1000),
    owner: z.string().trim().max(120).nullable(),
    due: z.string().trim().max(120).nullable(),
    attributes: ItemAttributes,
  })
  .partial();
export type ItemPatch = z.infer<typeof ItemPatch>;

export const NewItemInput = z.object({
  type: z.enum(ITEM_TYPES),
  description: z.string().trim().min(5).max(1000),
  owner: z.string().trim().max(120).nullish(),
  due: z.string().trim().max(120).nullish(),
  attributes: ItemAttributes.optional(),
});
export type NewItemInput = z.infer<typeof NewItemInput>;

export const AdrPatch = z
  .object({
    title: z.string().trim().min(3).max(300),
    context: z.string().trim().max(5000),
    problem: z.string().trim().max(5000),
    alternatives: z
      .array(z.object({ opcao: z.string().max(300), pros: z.string().max(2000), contras: z.string().max(2000) }))
      .max(10),
    decision: z.string().trim().max(5000),
    consequences: z.string().trim().max(5000),
    risks: z.array(z.string().max(1000)).max(20),
  })
  .partial();
export type AdrPatch = z.infer<typeof AdrPatch>;

export const ProjectInput = z.object({
  name: z.string().trim().min(2).max(80),
  keywords: z.array(z.string().trim().min(2).max(60)).max(30).optional(),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

const ChannelCaptureInput = z.object({
  state: z.enum(["recording", "restarting", "unavailable"]),
  device: z.string().max(300).nullable(),
  bytes: z.number().int().nonnegative(),
});

const CliStatusInput = z.object({
  available: z.boolean(),
  reason: z.string().max(300).nullable(),
  version: z.string().max(80).nullable(),
});
export type CliStatus = z.infer<typeof CliStatusInput>;

export const HeartbeatInput = z.object({
  version: z.string().max(40),
  /** "llm" = agente sem desktop (container do servidor): só executa gerações, não grava */
  mode: z.enum(["full", "llm"]).optional(),
  /** CLIs de assinatura que o host-agent consegue executar */
  llm: z.object({ claude: CliStatusInput.optional(), codex: CliStatusInput.optional() }).optional(),
  capture: z
    .object({
      meetingId: z.uuid(),
      channels: z.object({ mic: ChannelCaptureInput.optional(), remote: ChannelCaptureInput.optional() }),
    })
    .nullable(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** Pedido de geração entregue ao host-agent (GET /api/agent/llm/next). */
export interface AgentLlmJob {
  id: string;
  provider: SubscriptionLlm;
  /** vazio = modelo padrão do CLI */
  model: string;
  system: string;
  user: string;
  /** JSON Schema da resposta */
  schema: Record<string, unknown>;
  timeoutSeconds: number;
}

export const AgentLlmResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    output: z.unknown(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        model: z.string().max(120).nullable(),
      })
      .optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(1000) }),
]);
export type AgentLlmResult = z.infer<typeof AgentLlmResult>;

export interface HeartbeatResponse {
  now: string;
  userDisplayName: string;
  timezone: string;
  alerts: { minutesBefore: number[] };
  meetings: AgentMeeting[];
  recording: { meetingId: string; title: string; startedAt: string } | null;
}
