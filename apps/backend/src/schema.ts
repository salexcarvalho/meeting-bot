import { Pool } from "pg";
import { rbacSeedStatements } from "./authz/matrix";

// Idempotente: roda a cada boot. Mudanças futuras entram como novos
// ALTER ... IF NOT EXISTS no fim da lista.
const statements = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS meetings (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     title TEXT NOT NULL,
     platform TEXT NOT NULL,
     url TEXT,
     status TEXT NOT NULL,
     error_message TEXT,
     created_by UUID REFERENCES users(id) ON DELETE SET NULL,
     audio_path TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     started_at TIMESTAMPTZ,
     ended_at TIMESTAMPTZ,
     transcribed_at TIMESTAMPTZ,
     transcription_provider TEXT,
     ata_markdown TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_segments (
     id BIGSERIAL PRIMARY KEY,
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     speaker TEXT,
     text TEXT NOT NULL,
     start_seconds NUMERIC,
     end_seconds NUMERIC
   )`,
  `CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments (meeting_id, start_seconds)`,

  // ---- v0.3: agente local de reuniões (specs/001-agente-reunioes-mvp/data-model.md) ----
  `CREATE TABLE IF NOT EXISTS projects (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name TEXT NOT NULL UNIQUE,
     keywords TEXT[] NOT NULL DEFAULT '{}',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `INSERT INTO projects (name) VALUES
     ('Farmácia Digital'), ('SUS Escolha'), ('Portal SES'), ('InfraVision'), ('Agenith')
   ON CONFLICT (name) DO NOTHING`,

  `ALTER TABLE meetings
     ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'bot',
     ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS organizer TEXT,
     ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]',
     ADD COLUMN IF NOT EXISTS description TEXT,
     ADD COLUMN IF NOT EXISTS location TEXT,
     ADD COLUMN IF NOT EXISTS ical_uid TEXT,
     ADD COLUMN IF NOT EXISTS recurrence_key TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS ical_sequence INT NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
     ADD COLUMN IF NOT EXISTS project_suggested BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS skip_recording BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS last_speech_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS live_summary TEXT,
     ADD COLUMN IF NOT EXISTS live_summary_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS analysis JSONB,
     ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS asr_provider TEXT`,
  `UPDATE meetings SET source = 'upload' WHERE platform = 'upload' AND source <> 'upload'`,
  // Chave do convite por dono: o mesmo .ics importado por duas pessoas vira duas reuniões.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_ical_owner
     ON meetings (created_by, ical_uid, recurrence_key) WHERE ical_uid IS NOT NULL`,
  `DROP INDEX IF EXISTS uq_meetings_ical`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_scheduled ON meetings (scheduled_start)`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings (status)`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings (project_id)`,

  `ALTER TABLE transcript_segments
     ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'mixed',
     ADD COLUMN IF NOT EXISTS pass TEXT NOT NULL DEFAULT 'final'`,
  `CREATE INDEX IF NOT EXISTS idx_segments_meeting_pass
     ON transcript_segments (meeting_id, pass, start_seconds)`,

  `CREATE TABLE IF NOT EXISTS meeting_audio (
     id BIGSERIAL PRIMARY KEY,
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     channel TEXT NOT NULL,
     path TEXT NOT NULL,
     format TEXT NOT NULL,
     bytes BIGINT NOT NULL DEFAULT 0,
     duration_seconds NUMERIC,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (meeting_id, channel)
   )`,
  `INSERT INTO meeting_audio (meeting_id, channel, path, format)
     SELECT id, 'mixed', audio_path, CASE WHEN source = 'upload' THEN 'original' ELSE 'ogg_opus' END
     FROM meetings WHERE audio_path IS NOT NULL
   ON CONFLICT (meeting_id, channel) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS meeting_speakers (
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     label TEXT NOT NULL,
     display_name TEXT NOT NULL,
     PRIMARY KEY (meeting_id, label)
   )`,

  `CREATE TABLE IF NOT EXISTS meeting_notes (
     id BIGSERIAL PRIMARY KEY,
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     pass TEXT NOT NULL,
     start_seconds NUMERIC,
     end_seconds NUMERIC,
     text TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_meeting ON meeting_notes (meeting_id, kind, created_at)`,

  `CREATE TABLE IF NOT EXISTS meeting_items (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     description TEXT NOT NULL,
     owner TEXT,
     due TEXT,
     attributes JSONB NOT NULL DEFAULT '{}',
     review_status TEXT NOT NULL DEFAULT 'proposto',
     origin TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
     reviewed_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_meeting ON meeting_items (meeting_id, type)`,
  // Itens (decisões, pendências, riscos…) só saem em reunião com a chave ligada; o padrão é desligado.
  // Reuniões que já tinham itens ou análise ficam ligadas, só na criação da coluna.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'meetings' AND column_name = 'extract_items'
     ) THEN
       ALTER TABLE meetings ADD COLUMN extract_items BOOLEAN NOT NULL DEFAULT false;
       UPDATE meetings SET extract_items = true
        WHERE analyzed_at IS NOT NULL OR EXISTS (SELECT 1 FROM meeting_items i WHERE i.meeting_id = meetings.id);
     END IF;
   END $$`,

  `CREATE TABLE IF NOT EXISTS item_evidence (
     id BIGSERIAL PRIMARY KEY,
     item_id UUID NOT NULL REFERENCES meeting_items(id) ON DELETE CASCADE,
     segment_id BIGINT REFERENCES transcript_segments(id) ON DELETE SET NULL,
     start_seconds NUMERIC NOT NULL,
     end_seconds NUMERIC NOT NULL,
     channel TEXT NOT NULL,
     quote TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_item ON item_evidence (item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_segment ON item_evidence (segment_id)`,

  `CREATE TABLE IF NOT EXISTS item_history (
     id BIGSERIAL PRIMARY KEY,
     item_id UUID NOT NULL REFERENCES meeting_items(id) ON DELETE CASCADE,
     action TEXT NOT NULL,
     before JSONB,
     after JSONB,
     actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_history_item ON item_history (item_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS adrs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     item_id UUID NOT NULL UNIQUE REFERENCES meeting_items(id) ON DELETE CASCADE,
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     number INT UNIQUE,
     title TEXT NOT NULL,
     context TEXT NOT NULL,
     problem TEXT NOT NULL,
     alternatives JSONB NOT NULL DEFAULT '[]',
     decision TEXT NOT NULL,
     consequences TEXT NOT NULL,
     risks JSONB NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'proposto',
     approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
     approved_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_adrs_meeting ON adrs (meeting_id)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     kind TEXT NOT NULL,
     detail JSONB NOT NULL DEFAULT '{}',
     user_id UUID REFERENCES users(id) ON DELETE SET NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC)`,

  // ---------- plataforma multiusuário (docs/analise/plataforma-multiusuario.md §5) ----------
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS real_name TEXT,
     ADD COLUMN IF NOT EXISTS display_name TEXT,
     ADD COLUMN IF NOT EXISTS email TEXT,
     ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'pt-BR',
     ADD COLUMN IF NOT EXISTS timezone TEXT,
     ADD COLUMN IF NOT EXISTS avatar_file TEXT,
     ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
     ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS user_settings (
     user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data JSONB NOT NULL DEFAULT '{}',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS teams_accounts (
     user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     account_name TEXT NOT NULL,
     session_enc BYTEA NOT NULL,
     expired_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS agents (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     description TEXT,
     role TEXT,
     specialty TEXT,
     base_prompt TEXT,
     professional_context TEXT,
     priority_technologies TEXT[] NOT NULL DEFAULT '{}',
     highlight_decision_types TEXT[] NOT NULL DEFAULT '{}',
     doc_format TEXT NOT NULL DEFAULT 'markdown',
     language TEXT NOT NULL DEFAULT 'pt-BR',
     tone TEXT NOT NULL DEFAULT 'neutro',
     detail_level TEXT NOT NULL DEFAULT 'normal',
     avatar_file TEXT,
     avatar_updated_at TIMESTAMPTZ,
     voice_file TEXT,
     voice_seconds NUMERIC(6,1),
     voice_updated_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Um agente por usuário por enquanto; a tabela já comporta vários no futuro.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_owner ON agents (owner_id)`,

  `CREATE TABLE IF NOT EXISTS roles (
     id SMALLSERIAL PRIMARY KEY,
     key TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     system BOOLEAN NOT NULL DEFAULT true
   )`,
  `CREATE TABLE IF NOT EXISTS permissions (
     key TEXT PRIMARY KEY,
     description TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
     role_id SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
     permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
     PRIMARY KEY (role_id, permission_key)
   )`,
  `CREATE TABLE IF NOT EXISTS user_roles (
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role_id SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
     granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
     granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, role_id)
   )`,
  `CREATE TABLE IF NOT EXISTS meeting_shares (
     meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     access TEXT NOT NULL CHECK (access IN ('read', 'edit')),
     granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (meeting_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_shares_user ON meeting_shares (user_id)`,
  // Compartilhamento (specs/005): seen_at nulo = destinatário ainda não abriu ("Nova"). O backfill roda só na
  // primeira vez (coluna ainda inexistente), para os acessos que já existiam não aparecerem como novos.
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'meeting_shares' AND column_name = 'seen_at') THEN
       ALTER TABLE meeting_shares
         ADD COLUMN seen_at TIMESTAMPTZ,
         ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
       UPDATE meeting_shares SET seen_at = created_at, updated_at = created_at;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_shares_unseen ON meeting_shares (user_id) WHERE seen_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings (created_by, scheduled_start)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, at DESC)`,

  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS bot_display_name TEXT`,
  // Quem gerou cada análise/item/ADR: "local:<modelo>" ou "openrouter:<modelo>" (Constituição 1.3.0)
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_provider TEXT`,
  `ALTER TABLE meeting_items ADD COLUMN IF NOT EXISTS generated_by TEXT`,
  `ALTER TABLE adrs ADD COLUMN IF NOT EXISTS generated_by TEXT`,

  // Recorrência de cadastro manual: cada ocorrência já nasce como linha própria em
  // `meetings` (mesmo padrão do import .ics), ligadas pelo series_id.
  `ALTER TABLE meetings
     ADD COLUMN IF NOT EXISTS series_id UUID,
     ADD COLUMN IF NOT EXISTS recurrence_rule JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_series ON meetings (series_id)`,
  // Evita duplicar ocorrência se o job de extensão da série rodar duas vezes.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_series_start
     ON meetings (series_id, scheduled_start) WHERE series_id IS NOT NULL`,

  // Agenda enviada por assistente externo (POST /api/agent/calendar/import): import_source marca de onde
  // a reunião veio (só essas podem ser canceladas quando somem da lista do dia); import_removed_at
  // distingue "sumiu da lista" de um cancelamento feito pelo usuário (só o primeiro volta se reaparecer).
  `ALTER TABLE meetings
     ADD COLUMN IF NOT EXISTS import_source TEXT,
     ADD COLUMN IF NOT EXISTS import_removed_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_import
     ON meetings (created_by, import_source, scheduled_start) WHERE import_source IS NOT NULL`,

  // Dia não útil (WORKING_DAYS): a reunião não tem lembrete nem entrada automática, a menos que o
  // usuário peça. true = o usuário pediu para tratá-la como a de um dia útil.
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS auto_on_off_day BOOLEAN NOT NULL DEFAULT false`,
  // Minhas pendências e tarefas (specs/002-pendencias-tarefas): tarefas pessoais (owner_id), só aditivo.
  // A tarefa sobrevive à reunião e ao item de origem (SET NULL) e guarda o instantâneo da origem.
  `CREATE TABLE IF NOT EXISTS tasks (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'a_fazer'
       CHECK (status IN ('a_fazer', 'em_andamento', 'bloqueada', 'concluida', 'cancelada')),
     priority TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa', 'media', 'alta', 'urgente')),
     due_date DATE,
     due_hint TEXT,
     assignee_kind TEXT NOT NULL DEFAULT 'self' CHECK (assignee_kind IN ('self', 'other', 'none')),
     assignee_name TEXT,
     project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
     meeting_id UUID REFERENCES meetings(id) ON DELETE SET NULL,
     source_item_id UUID REFERENCES meeting_items(id) ON DELETE SET NULL,
     source_snapshot JSONB,
     origin TEXT NOT NULL CHECK (origin IN ('item_auto', 'item_manual', 'manual')),
     external_ref JSONB,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     CHECK (assignee_kind <> 'other' OR assignee_name IS NOT NULL),
     CHECK (assignee_kind <> 'self' OR assignee_name IS NULL),
     CHECK (status <> 'concluida' OR completed_at IS NOT NULL)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_item_owner
     ON tasks (source_item_id, owner_id) WHERE source_item_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_due ON tasks (owner_id, status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_project ON tasks (owner_id, project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_meeting ON tasks (owner_id, meeting_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_updated ON tasks (owner_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS task_history (
     id BIGSERIAL PRIMARY KEY,
     task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     action TEXT NOT NULL CHECK (action IN ('created', 'edited', 'status_changed')),
     before JSONB,
     after JSONB,
     actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history (task_id, id)`,
  // ---------- F6 uso e custo de IA (specs/004-uso-custo): só metadados e números, append-only ----------
  `CREATE TABLE IF NOT EXISTS ai_usage_logs (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     meeting_id UUID REFERENCES meetings(id) ON DELETE SET NULL,
     category TEXT NOT NULL CHECK (category IN ('llm', 'asr')),
     purpose TEXT NOT NULL CHECK (purpose IN ('ata', 'adr', 'itens', 'resumo', 'ao_vivo', 'asr_final', 'asr_ao_vivo', 'outro')),
     provider TEXT NOT NULL,
     model TEXT CHECK (char_length(model) <= 120),
     channel TEXT CHECK (channel IN ('mic', 'remote', 'mixed')),
     input_tokens BIGINT CHECK (input_tokens >= 0),
     output_tokens BIGINT CHECK (output_tokens >= 0),
     audio_seconds NUMERIC(12, 2) CHECK (audio_seconds >= 0),
     cost_usd NUMERIC(14, 8) CHECK (cost_usd >= 0),
     duration_ms INTEGER CHECK (duration_ms >= 0),
     compute_ms INTEGER CHECK (compute_ms >= 0),
     attempts SMALLINT NOT NULL DEFAULT 1,
     success BOOLEAN NOT NULL,
     error_code TEXT CHECK (
       error_code IN ('timeout', 'unavailable', 'schema_invalid', 'refused', 'truncated', 'disabled', 'cancelled', 'other')
       OR error_code ~ '^http_[0-9]{3}$'
     ),
     label TEXT CHECK (char_length(label) <= 80),
     source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'audit_backfill')),
     audit_log_id BIGINT,
     CHECK (success OR error_code IS NOT NULL),
     CHECK (category = 'asr' OR audio_seconds IS NULL),
     CHECK (category = 'llm' OR purpose IN ('asr_final', 'asr_ao_vivo', 'outro')),
     CHECK (category = 'asr' OR purpose NOT IN ('asr_final', 'asr_ao_vivo'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_user_at ON ai_usage_logs (user_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_at ON ai_usage_logs (at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_meeting ON ai_usage_logs (meeting_id) WHERE meeting_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_audit_log ON ai_usage_logs (audit_log_id) WHERE audit_log_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log ((detail->>'target')) WHERE detail ? 'target'`,
];

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    for (const sql of [...statements, ...rbacSeedStatements()]) await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}
