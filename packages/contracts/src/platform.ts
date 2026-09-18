import { z } from "zod";

// ---------- RBAC ----------

export const ROLE_KEYS = ["SUPER_ADMIN", "ADMIN", "USER", "VIEWER"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: "Super administrador",
  ADMIN: "Administrador",
  USER: "Usuário",
  VIEWER: "Leitor",
};

export const PERMISSIONS = {
  "users.read": "Ver usuários",
  "users.create": "Criar usuários",
  "users.update": "Editar usuários e papéis",
  "users.deactivate": "Ativar e desativar usuários",
  "users.reset": "Redefinir senha e configurações de usuários",
  "agents.read": "Ver o próprio agente",
  "agents.manage": "Configurar o próprio agente",
  "meetings.read": "Ver reuniões próprias ou compartilhadas",
  "meetings.manage": "Criar, editar, gravar e excluir reuniões próprias",
  "meetings.read_all": "Ver reuniões de todos os usuários",
  "transcripts.read": "Ver transcrições",
  "transcripts.delete": "Excluir transcrições e áudio",
  "documents.generate": "Gerar documentos com IA",
  "documents.read": "Ver documentos",
  "settings.manage": "Alterar as próprias configurações",
  "projects.manage": "Renomear e excluir projetos do catálogo",
  "providers.manage": "Gerenciar provedores e modelos de IA",
  "audit.read": "Ver auditoria",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

// ---------- usuário ----------

export const LANGUAGES = ["pt-BR", "en-US", "es-ES"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface UserProfile {
  id: string;
  username: string;
  realName: string | null;
  displayName: string | null;
  /** e-mail do convite (Outlook/Teams), para reconhecer o dono entre os participantes */
  email: string | null;
  /** nome efetivo: exibição > real > usuário */
  name: string;
  language: Language;
  timezone: string;
  hasAvatar: boolean;
  avatarVersion: string | null;
  active: boolean;
  roles: RoleKey[];
  createdAt: string;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "e-mail inválido")
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .nullable();

export const ProfilePatch = z
  .object({
    realName: optionalText(120),
    displayName: optionalText(60),
    email: optionalEmail,
    language: z.enum(LANGUAGES),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "fuso horário inválido"),
  })
  .partial();
export type ProfilePatch = z.infer<typeof ProfilePatch>;

// ---------- agente ----------

export const DETAIL_LEVELS = ["resumido", "normal", "detalhado"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const TONES = ["formal", "neutro", "direto"] as const;
export type Tone = (typeof TONES)[number];

export const DOC_FORMATS = ["markdown", "topicos", "tabela"] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

export interface AgentProfile {
  name: string;
  description: string | null;
  role: string | null;
  specialty: string | null;
  basePrompt: string | null;
  professionalContext: string | null;
  priorityTechnologies: string[];
  highlightDecisionTypes: string[];
  docFormat: DocFormat;
  language: Language;
  tone: Tone;
  detailLevel: DetailLevel;
  hasAvatar: boolean;
  avatarVersion: string | null;
  hasVoice: boolean;
  voiceVersion: string | null;
  voiceDurationSeconds: number | null;
  updatedAt: string | null;
}

const tagList = z.array(z.string().trim().min(1).max(60)).max(30);

export const AgentPatch = z
  .object({
    name: z.string().trim().min(2, "Nome do agente muito curto.").max(40),
    description: optionalText(500),
    role: optionalText(120),
    specialty: optionalText(200),
    basePrompt: optionalText(4000),
    professionalContext: optionalText(4000),
    priorityTechnologies: tagList,
    highlightDecisionTypes: tagList,
    docFormat: z.enum(DOC_FORMATS),
    language: z.enum(LANGUAGES),
    tone: z.enum(TONES),
    detailLevel: z.enum(DETAIL_LEVELS),
  })
  .partial();
export type AgentPatch = z.infer<typeof AgentPatch>;

// ---------- identidade na reunião ----------

export const DISPLAY_IDENTITIES = ["user", "agent", "custom"] as const;
export type DisplayIdentity = (typeof DISPLAY_IDENTITIES)[number];

export const DISPLAY_IDENTITY_LABELS: Record<DisplayIdentity, string> = {
  user: "Meu nome",
  agent: "Nome do agente",
  custom: "Nome personalizado",
};

export const IdentityChoice = z.object({
  mode: z.enum(DISPLAY_IDENTITIES),
  customName: optionalText(40).optional(),
});
export type IdentityChoice = z.infer<typeof IdentityChoice>;

// ---------- configurações por categoria ----------

export const MeetingSettingsFields = z.object({
  displayIdentity: z.enum(DISPLAY_IDENTITIES),
  customDisplayName: optionalText(40),
});

export const DocumentationSettingsFields = z.object({
  detailLevel: z.enum(DETAIL_LEVELS),
  formats: z.array(z.enum(DOC_FORMATS)).min(1).max(DOC_FORMATS.length),
});

export const SETTINGS_SECTIONS = {
  meetings: MeetingSettingsFields,
  documentation: DocumentationSettingsFields,
} as const;

export interface UserSettings {
  meetings: z.infer<typeof MeetingSettingsFields>;
  documentation: z.infer<typeof DocumentationSettingsFields>;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  meetings: { displayIdentity: "agent", customDisplayName: null },
  documentation: { detailLevel: "normal", formats: ["markdown"] },
};

// Sem defaults de propósito: campo ausente no patch não altera o valor salvo.
export const UserSettingsPatch = z
  .object({
    meetings: MeetingSettingsFields.partial().strict().optional(),
    documentation: DocumentationSettingsFields.partial().strict().optional(),
  })
  .strict();
export type UserSettingsPatch = z.infer<typeof UserSettingsPatch>;

export interface MeResponse {
  profile: UserProfile;
  settings: UserSettings;
  agent: AgentProfile;
  permissions: Permission[];
  /** como o bot aparecerá na reunião com a configuração atual */
  botDisplayName: string;
}

// ---------- administração ----------

export interface AdminUser extends UserProfile {
  lastSeenAt: string | null;
  meetingCount: number;
}

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "Use 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.");

export const AdminUserCreate = z.object({
  username,
  password: z.string().min(1).max(200),
  realName: optionalText(120).optional(),
  displayName: optionalText(60).optional(),
  role: z.enum(ROLE_KEYS).default("USER"),
});
export type AdminUserCreate = z.infer<typeof AdminUserCreate>;

export const AdminUserPatch = z
  .object({
    realName: optionalText(120),
    displayName: optionalText(60),
    active: z.boolean(),
    roles: z.array(z.enum(ROLE_KEYS)).min(1).max(ROLE_KEYS.length),
  })
  .partial();
export type AdminUserPatch = z.infer<typeof AdminUserPatch>;

// ---------- Modo Agente: etapas de entrada ----------

export const BOT_STAGES = ["preparing", "launching", "opening", "joining", "waiting_admission", "in_call"] as const;
export type BotStage = (typeof BOT_STAGES)[number];

export const BOT_STAGE_LABELS: Record<BotStage, string> = {
  preparing: "Preparando agente…",
  launching: "Conectando…",
  opening: "Abrindo reunião…",
  joining: "Entrando…",
  waiting_admission: "Aguardando admissão…",
  in_call: "Conectado",
};

export interface BotProgress {
  stage: BotStage;
  /** ms desde o pedido */
  elapsedMs: number;
  displayName: string;
}
