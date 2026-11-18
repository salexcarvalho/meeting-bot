import { pool } from "../db";

export type AuditKind =
  | "egress_blocked"
  | "llm_provider_blocked"
  | "agent_auth_failed"
  | "agent_calendar_import"
  | "agent_calendar_import_failed"
  | "external_asr"
  | "external_llm"
  | "generation_requested"
  | "admin_user_created"
  | "admin_user_updated"
  | "admin_user_roles_changed"
  | "admin_user_activated"
  | "admin_user_deactivated"
  | "admin_user_password_reset"
  | "admin_user_settings_reset"
  | "teams_account_connected"
  | "teams_account_removed"
  | "teams_account_expired"
  | "meeting_share_granted"
  | "meeting_share_changed"
  | "meeting_share_revoked"
  | "meeting_share_left"
  | "task_created_from_item"
  | "auth_login"
  | "auth_login_failed"
  | "auth_logout"
  | "auth_password_changed"
  | "retention_pruned"
  | "speaker_timeline_recorded"
  | "speaker_names_applied";

// Nunca registrar conteúdo de reunião aqui — só metadados.
export function audit(kind: AuditKind, detail: Record<string, unknown>, userId: string | null = null): void {
  console.warn(`[audit] ${kind} ${JSON.stringify(detail)}`);
  pool
    .query(`INSERT INTO audit_log (kind, detail, user_id) VALUES ($1, $2, $3)`, [kind, detail, userId])
    .catch((err) => console.error("[audit] falha ao gravar:", err));
}
