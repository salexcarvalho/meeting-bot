# Data Model — F6 (uso e custo de IA, auditoria, retenção)

Postgres 16. Migração **apenas aditiva e idempotente** em `apps/backend/src/schema.ts`
(`CREATE ... IF NOT EXISTS`), como o resto do projeto. Antes de aplicar no banco real: `pg_dump` e
confirmação do usuário.

## Diagrama

```text
users 1─* ai_usage_logs  (user_id, ON DELETE SET NULL)
meetings 1─* ai_usage_logs (meeting_id, ON DELETE SET NULL)
audit_log 1─0..1 ai_usage_logs (audit_log_id, só linhas incorporadas do histórico)
audit_log (inalterada: ganha kinds novos e user_id nos envios externos)
```

## Tabela nova: `ai_usage_logs`

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | fim da chamada (ou do flush, no ao vivo) |
| `user_id` | `UUID NULL REFERENCES users(id) ON DELETE SET NULL` | dono da reunião; nulo = instância ou usuário removido |
| `meeting_id` | `UUID NULL REFERENCES meetings(id) ON DELETE SET NULL` | |
| `category` | `TEXT NOT NULL CHECK (category IN ('llm','asr'))` | |
| `purpose` | `TEXT NOT NULL CHECK (purpose IN ('ata','adr','itens','resumo','ao_vivo','asr_final','asr_ao_vivo','outro'))` | `outro` só para histórico não classificável |
| `provider` | `TEXT NOT NULL` | `ollama`, `openrouter`, `claude`, `codex`, `whisper`, `deepgram` |
| `model` | `TEXT NULL` | rótulo livre (≤ 120) |
| `channel` | `TEXT NULL` | `mic`, `remote`, `mixed` (só ASR) |
| `input_tokens` | `BIGINT NULL CHECK (>= 0)` | nulo = não informado |
| `output_tokens` | `BIGINT NULL CHECK (>= 0)` | |
| `audio_seconds` | `NUMERIC(12,2) NULL CHECK (>= 0)` | só ASR |
| `cost_usd` | `NUMERIC(14,8) NULL CHECK (>= 0)` | informado pelo provedor; nulo = sem custo por chamada ou não informado |
| `duration_ms` | `INTEGER NULL CHECK (>= 0)` | tempo de parede da chamada ao provedor (sem fila) |
| `compute_ms` | `INTEGER NULL CHECK (>= 0)` | tempo de inferência local (Ollama, Whisper); nulo se não mensurável |
| `attempts` | `SMALLINT NOT NULL DEFAULT 1` | tentativas somadas na linha |
| `success` | `BOOLEAN NOT NULL` | |
| `error_code` | `TEXT NULL CHECK (error_code IN ('timeout','unavailable','schema_invalid','refused','truncated','disabled','cancelled','other') OR error_code ~ '^http_[0-9]{3}$')` | só quando `success = false` |
| `label` | `TEXT NULL CHECK (char_length(label) <= 80)` | rótulo interno ("extração final 1/3"); nunca conteúdo |
| `source` | `TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','audit_backfill'))` | |
| `audit_log_id` | `BIGINT NULL` | id da linha incorporada de `audit_log`; único quando preenchido |

Restrições de consistência:

- `CHECK (success OR error_code IS NOT NULL)`: falha sempre com código.
- `CHECK (category = 'asr' OR audio_seconds IS NULL)`.
- `CHECK (category = 'llm' OR purpose IN ('asr_final','asr_ao_vivo','outro'))` e o inverso para LLM.

Índices:

```sql
CREATE INDEX IF NOT EXISTS idx_usage_user_at ON ai_usage_logs (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_at ON ai_usage_logs (at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_meeting ON ai_usage_logs (meeting_id) WHERE meeting_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_audit_log ON ai_usage_logs (audit_log_id) WHERE audit_log_id IS NOT NULL;
```

Notas:

- Linhas são **imutáveis** (append-only): sem `UPDATE`, só `INSERT` e a poda por prazo.
- Sem coluna de conteúdo. O teste de contrato (T019 e T048) varre todas as colunas `TEXT`.
- Exclusão de reunião ou usuário não apaga linhas (FK `SET NULL`): preserva o histórico (FR-022).
- Reunião transferida de dono: as linhas antigas mantêm o `user_id` da época.

## Tabela existente: `audit_log` (sem alteração de schema)

- **Novos `kind`** (adicionados a `AuditKind` em `security/audit.ts`):
  `auth_login`, `auth_login_failed`, `auth_logout`, `auth_password_changed`, `retention_pruned`.
- **`detail` por kind novo** (só metadados):

| kind | `user_id` | `detail` |
|---|---|---|
| `auth_login` | quem entrou | `{}` |
| `auth_login_failed` | usuário encontrado ou nulo | `{ ip, usernameKnown: boolean }` (sem a senha e sem o nome digitado; IP conforme Q5) |
| `auth_logout` | quem saiu | `{}` |
| `auth_password_changed` | quem trocou | `{ sessionsRevoked: number }` |
| `retention_pruned` | nulo | `{ table: 'ai_usage_logs'\|'audit_log', deleted: number, olderThanDays: number }` |

- **Mudança em kinds existentes**: `external_llm` e `external_asr` passam a gravar `user_id` (dono
  da reunião); a `detail` ganha `purpose` e `success`. `external_asr` passa a ser gravado
  também no fim (com sucesso/erro), além do início.
- **Quem lê**: `GET /audit/me` (ator = `user_id` **ou** alvo = `detail->>'target'`) e
  `GET /admin/audit` (`audit.read`), sempre via projeção permitida (`audit/projection.ts`).
- **Índice novo opcional**: `CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log ((detail->>'target')) WHERE detail ? 'target'` para a visão do usuário como alvo.

### Projeção de exibição (lista permitida)

| kind | Campos exibidos | Rótulo pt-BR (exemplo) |
|---|---|---|
| `auth_login` / `auth_logout` | — | "Entrada na conta" / "Saída da conta" |
| `auth_login_failed` | `ip` (só para o próprio usuário e admin) | "Tentativa de entrada recusada" |
| `auth_password_changed` | `sessionsRevoked` | "Senha alterada" |
| `admin_user_created/updated/activated/deactivated/password_reset/settings_reset` | ator, alvo | "Administrador X redefiniu sua senha" |
| `admin_user_roles_changed` | `from`, `to` (papéis) | "Papéis alterados de A para B" |
| `teams_account_connected/removed/expired` | — | "Conta Teams conectada" |
| `external_llm` | `provider`, `model`, `purpose`, `success` | "Texto enviado ao OpenRouter para gerar a ata" (sem título e sem reunião) |
| `external_asr` | `model`, `seconds` | "Áudio enviado para transcrição externa" |
| `generation_requested` | `step`, `provider` | "Geração solicitada" |
| `egress_blocked`, `llm_provider_blocked`, `agent_auth_failed`, `agent_calendar_import*` | só admin: `host`/`provider`/`reason` | |
| `retention_pruned` | só admin: `table`, `deleted` | |
| qualquer outro | nenhum campo | só o tipo e a data |

`meetingId` e `title` nunca fazem parte da projeção.

## Permissões (RBAC)

| Permissão | Nova? | Papéis |
|---|---|---|
| `ai_usage.read` | sim (`PERMISSIONS` em `contracts/platform.ts`) | ADMIN, SUPER_ADMIN |
| `audit.read` | já existe | ADMIN, SUPER_ADMIN |
| painel do próprio usuário | sem permissão nova: qualquer sessão autenticada lê **só** `user_id = eu` | todos |

O seed idempotente (`rbacSeedStatements`) cria a permissão nova e a liga ao ADMIN; SUPER_ADMIN já
recebe todas (exceto `meetings.read_all`).

## Configuração (nomes; valores só no `.env`/`.env.example`)

| Variável | Padrão | Efeito |
|---|---|---|
| `USAGE_RETENTION_DAYS` | `730` (Q2-A) | poda de `ai_usage_logs`; `0` = não poda |
| `AUDIT_RETENTION_DAYS` | `365` (Q2-A) | poda de `audit_log`; `0` = não poda |
| `USAGE_ASR_FLUSH_MINUTES` | `10` | descarga do acumulador de ASR ao vivo |

## Estados e transições

- Linha de uso: criada pronta (`success` true/false); não muda. Removida só pela poda.
- Acumulador de ASR ao vivo (memória): `acumulando → flush (INSERT delta) → zerado → ... → close (flush final)`.
- Incorporação do histórico: `external_llm`/`external_asr` do `audit_log` sem `ai_usage_logs.audit_log_id`
  correspondente → `INSERT ... ON CONFLICT (audit_log_id) DO NOTHING` (com `source='audit_backfill'`,
  `purpose` deduzido do `label` por regra tolerante, desconhecido → `outro`, `success = true`).

## Validações (contrato Zod em `packages/contracts/src/usage.ts`)

- `UsagePurpose`, `UsageProvider`, `UsageCategory` como `z.enum`.
- `UsagePeriod` (`month=AAAA-MM` **ou** `from`/`to` ISO, `to > from`, janela ≤ 24 meses).
- Paginação por cursor `(at, id)` opaco; `limit` 1–100.
