import { USAGE_PURPOSE_LABELS, type AuditEventViewValue, type UsagePurposeValue } from "@meeting-bot/contracts";

// Projeção de exibição da auditoria (specs/004-uso-custo/data-model.md): lista PERMITIDA de campos
// por tipo de evento. Tipo desconhecido ou sem regra => só tipo e data; campo fora da lista nunca
// é exibido; `meetingId` e título de reunião nunca fazem parte da projeção (default deny).

export interface Person {
  id: string | null;
  username: string | null;
}

export interface RuleContext {
  /** quem está vendo (para "você" e para o ponto de vista do alvo) */
  viewerId: string | null;
  actor: Person | null;
  target: Person | null;
  detail: Record<string, unknown>;
}

interface KindRule {
  label: string;
  /** visível ao próprio usuário em /audit/me; false = só quem tem `audit.read` */
  userVisible: boolean;
  /** únicas chaves de `detail` que podem aparecer */
  fields: readonly string[];
  title: (ctx: RuleContext) => string;
}

const MAX_TEXT = 120;
const MAX_LIST = 10;

const PROVIDER_NAMES: Record<string, string> = { openrouter: "OpenRouter", claude: "Claude", codex: "Codex" };

function subject(person: Person | null, viewerId: string | null): string {
  if (person?.id && person.id === viewerId) return "você";
  return person?.username ?? "alguém";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ação de administrador sobre uma conta, no ponto de vista de quem vê. */
function adminAction(whenTarget: string, other: (target: string) => string): (ctx: RuleContext) => string {
  return (ctx) => {
    const isTarget = ctx.viewerId !== null && ctx.target?.id === ctx.viewerId;
    if (isTarget) return `Administrador ${subject(ctx.actor, ctx.viewerId)} ${whenTarget}`;
    return capitalized(`${subject(ctx.actor, ctx.viewerId)} ${other(subject(ctx.target, ctx.viewerId))}`);
  };
}

function externalProvider(detail: Record<string, unknown>): string {
  const provider = typeof detail.provider === "string" ? detail.provider : "openrouter";
  return PROVIDER_NAMES[provider] ?? provider;
}

function purposeLabel(detail: Record<string, unknown>): string | null {
  const purpose = detail.purpose;
  return typeof purpose === "string" && purpose in USAGE_PURPOSE_LABELS ? USAGE_PURPOSE_LABELS[purpose as UsagePurposeValue] : null;
}

function externalLlmTitle(ctx: RuleContext): string {
  const purpose = purposeLabel(ctx.detail);
  const base = `Texto enviado ao ${externalProvider(ctx.detail)}${purpose ? ` (${purpose.toLowerCase()})` : ""}`;
  return ctx.detail.success === false ? `${base}: recusado` : base;
}

function externalAsrTitle(ctx: RuleContext): string {
  if (ctx.detail.phase !== "end") return "Áudio enviado para transcrição externa";
  return ctx.detail.success === false ? "Transcrição externa falhou" : "Transcrição externa concluída";
}

const fixed = (text: string) => () => text;

const RULES: Record<string, KindRule> = {
  auth_login: { label: "Entrada na conta", userVisible: true, fields: [], title: fixed("Entrada na conta") },
  auth_logout: { label: "Saída da conta", userVisible: true, fields: [], title: fixed("Saída da conta") },
  auth_login_failed: {
    label: "Tentativa de entrada recusada",
    userVisible: true,
    fields: ["ip", "rateLimited"],
    title: (ctx) => (ctx.detail.rateLimited === true ? "Tentativa de entrada bloqueada (limite de tentativas)" : "Tentativa de entrada recusada"),
  },
  auth_password_changed: { label: "Senha alterada", userVisible: true, fields: ["sessionsRevoked"], title: fixed("Senha alterada") },
  teams_account_connected: { label: "Conta Teams conectada", userVisible: true, fields: [], title: fixed("Conta Teams conectada") },
  teams_account_removed: { label: "Conta Teams removida", userVisible: true, fields: [], title: fixed("Conta Teams removida") },
  teams_account_expired: { label: "Sessão da conta Teams expirou", userVisible: true, fields: [], title: fixed("Sessão da conta Teams expirou") },
  admin_user_created: {
    label: "Usuário criado",
    userVisible: true,
    fields: ["role"],
    title: adminAction("criou sua conta", (t) => `criou o usuário ${t}`),
  },
  admin_user_updated: {
    label: "Perfil alterado por administrador",
    userVisible: true,
    fields: ["fields"],
    title: adminAction("alterou seu perfil", (t) => `alterou o perfil de ${t}`),
  },
  admin_user_roles_changed: {
    label: "Papéis alterados",
    userVisible: true,
    fields: ["from", "to"],
    title: adminAction("alterou seus papéis", (t) => `alterou os papéis de ${t}`),
  },
  admin_user_activated: {
    label: "Conta ativada",
    userVisible: true,
    fields: [],
    title: adminAction("ativou sua conta", (t) => `ativou a conta de ${t}`),
  },
  admin_user_deactivated: {
    label: "Conta desativada",
    userVisible: true,
    fields: [],
    title: adminAction("desativou sua conta", (t) => `desativou a conta de ${t}`),
  },
  admin_user_password_reset: {
    label: "Senha redefinida por administrador",
    userVisible: true,
    fields: [],
    title: adminAction("redefiniu sua senha", (t) => `redefiniu a senha de ${t}`),
  },
  admin_user_settings_reset: {
    label: "Configurações redefinidas por administrador",
    userVisible: true,
    fields: [],
    title: adminAction("redefiniu suas configurações", (t) => `redefiniu as configurações de ${t}`),
  },
  external_llm: {
    label: "Texto enviado a um modelo externo",
    userVisible: true,
    fields: ["provider", "model", "purpose", "success"],
    title: externalLlmTitle,
  },
  external_asr: {
    label: "Áudio enviado para transcrição externa",
    userVisible: true,
    fields: ["model", "seconds", "success"],
    title: externalAsrTitle,
  },
  generation_requested: {
    label: "Geração solicitada",
    userVisible: true,
    fields: ["step", "provider"],
    title: fixed("Geração solicitada"),
  },
  egress_blocked: { label: "Saída de rede bloqueada", userVisible: false, fields: ["host", "protocol"], title: fixed("Saída de rede bloqueada") },
  llm_provider_blocked: {
    label: "Provedor de IA bloqueado",
    userVisible: false,
    fields: ["provider"],
    title: fixed("Provedor de IA bloqueado"),
  },
  agent_auth_failed: {
    label: "Falha de autenticação do agente",
    userVisible: false,
    fields: ["ip", "where"],
    title: fixed("Falha de autenticação do agente"),
  },
  agent_calendar_import: {
    label: "Agenda importada pelo agente",
    userVisible: false,
    fields: ["source", "mode", "created", "updated", "cancelled"],
    title: fixed("Agenda importada pelo agente"),
  },
  agent_calendar_import_failed: {
    label: "Importação de agenda falhou",
    userVisible: false,
    fields: ["reason", "mode"],
    title: fixed("Importação de agenda falhou"),
  },
  retention_pruned: {
    label: "Poda de registros antigos",
    userVisible: false,
    fields: ["table", "deleted", "olderThanDays"],
    title: fixed("Poda de registros antigos"),
  },
};

export function knownKinds(): string[] {
  return Object.keys(RULES);
}

export function isKnownKind(kind: string): boolean {
  return Object.hasOwn(RULES, kind);
}

/** Tipos visíveis ao próprio usuário em /audit/me. */
export function userKinds(): string[] {
  return Object.entries(RULES)
    .filter(([, rule]) => rule.userVisible)
    .map(([kind]) => kind);
}

export function kindLabel(kind: string): string {
  return Object.hasOwn(RULES, kind) ? RULES[kind].label : kind;
}

type FieldValue = AuditEventViewValue["fields"][string];

function safeValue(value: unknown): FieldValue | null {
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string").slice(0, MAX_LIST);
    return list.map((v) => v.slice(0, MAX_TEXT));
  }
  return null;
}

export interface RawEvent {
  id: number;
  at: Date;
  kind: string;
  detail: Record<string, unknown>;
  actor: Person | null;
  target: Person | null;
}

/** Monta a visão exibível: título pt-BR e só os campos da lista permitida do tipo. */
export function project(event: RawEvent, viewerId: string | null): AuditEventViewValue {
  const base = { id: event.id, at: event.at.toISOString(), kind: event.kind };
  if (!isKnownKind(event.kind)) return { ...base, title: event.kind, actor: null, target: null, fields: {} };
  const rule = RULES[event.kind];
  const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
  const fields: AuditEventViewValue["fields"] = {};
  for (const key of rule.fields) {
    if (!Object.hasOwn(detail, key)) continue;
    const value = safeValue(detail[key]);
    if (value !== null) fields[key] = value;
  }
  return {
    ...base,
    title: rule.title({ viewerId, actor: event.actor, target: event.target, detail }),
    actor: event.actor,
    target: event.target,
    fields,
  };
}
