# Data Model — Agente Local de Reuniões (MVP)

Postgres 16. As migrações ficam em `apps/backend/src/schema.ts`: são idempotentes e **apenas
aditivas** (`CREATE ... IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`). Os dados atuais
(usuários, sessões, 4 reuniões, segmentos) são preservados. Antes da primeira execução, fazer
backup com `pg_dump`.

## Diagrama

```text
users 1─* sessions
users 1─* meetings (created_by)
projects 1─* meetings
meetings 1─* meeting_audio        (um por canal)
meetings 1─* transcript_segments  (pass live|final, canal)
meetings 1─* meeting_speakers     (rótulo → nome exibido)
meetings 1─* meeting_notes        (resumos de janela / consolidação / chunk)
meetings 1─* meeting_items 1─* item_evidence *─1 transcript_segments
meeting_items 1─* item_history
meeting_items 1─0..1 adrs         (só decisao_arquitetural)
audit_log
```

## Tabelas existentes (alterações)

### users

A tabela não muda. O nome exibido do dono da máquina vem da configuração (`USER_DISPLAY_NAME`,
padrão "Sérgio").

### meetings

| Coluna | Tipo | Regra |
|---|---|---|
| id | UUID PK | já existe |
| title | TEXT NOT NULL | 1–300 caracteres |
| platform | TEXT NOT NULL | `meet` \| `teams` \| `upload` \| `other` \| `none` (detectado a partir da URL) |
| url | TEXT | https; para `ics`/`manual` qualquer https é aceito (Zoom etc. → `other`) |
| status | TEXT NOT NULL | ver máquina de estados |
| error_message | TEXT | |
| created_by | UUID FK users | null quando vem do host-agent/ics sem usuário |
| audio_path | TEXT | legado (bot/upload); espelhado em `meeting_audio` |
| created_at, started_at, ended_at, transcribed_at | TIMESTAMPTZ | `started_at`/`ended_at` = gravação real |
| transcription_provider | TEXT | `worker-gpu` para dados novos |
| ata_markdown | TEXT | legado (atas antigas); a ata nova é renderizada |
| **source** | TEXT NOT NULL DEFAULT `'bot'` | `bot` \| `upload` \| `ics` \| `manual`; backfill: `platform='upload'` → `upload` |
| **scheduled_start** | TIMESTAMPTZ | obrigatório para `ics`/`manual` |
| **scheduled_end** | TIMESTAMPTZ | > `scheduled_start`; duração de 5 min a 12 h |
| **organizer** | TEXT | nome ou e-mail |
| **attendees** | JSONB NOT NULL DEFAULT `'[]'` | `[{name, email}]` |
| **description** | TEXT | texto do convite (limite de 20 KB) |
| **location** | TEXT | |
| **ical_uid** | TEXT | UID do convite |
| **recurrence_key** | TEXT NOT NULL DEFAULT `''` | ISO do início da ocorrência para eventos recorrentes; `''` para únicos |
| **ical_sequence** | INT NOT NULL DEFAULT 0 | atualização só se `SEQUENCE` ≥ atual |
| **project_id** | UUID FK projects ON DELETE SET NULL | |
| **project_suggested** | BOOLEAN NOT NULL DEFAULT false | true quando o projeto foi sugerido por palavra-chave e ainda não confirmado |
| **skip_recording** | BOOLEAN NOT NULL DEFAULT false | "Não gravar" |
| **stop_requested** | BOOLEAN NOT NULL DEFAULT false | botão Parar |
| **last_speech_at** | TIMESTAMPTZ | última fala detectada (qualquer canal) |
| **live_summary** | TEXT | resumo corrente (consolidação) |
| **live_summary_at** | TIMESTAMPTZ | |
| **analysis** | JSONB | narrativa da ata: `{objetivo, resumo_executivo, assuntos[], observacoes_arquiteto[]}` |
| **analyzed_at** | TIMESTAMPTZ | |

Índices:
- `UNIQUE (ical_uid, recurrence_key) WHERE ical_uid IS NOT NULL`
- `(scheduled_start)`
- `(status)`

#### Máquina de estados

```text
agendada (ics/manual):
  scheduled ──(Não gravar)──► skipped ──(Gravar manual)──► recording
  scheduled ──(cancelamento .ics)──► cancelled
  scheduled ──(fim previsto passou sem gravar)──► missed ──(Gravar manual)──► recording
  scheduled ──(início chegou | Gravar manual)──► recording
  recording ──(regra de parada | Parar | 4 h | agente sumiu > 5 min após o fim)──► stopping
  stopping ──(canais encerrados ou 2 min)──► transcribing ──► generating_ata ──► done
  stopping ──(nenhum áudio recebido)──► error

bot (Modo Agente):  queued → joining → waiting_admission → in_call → transcribing → generating_ata → done
upload:             queued → transcribing → generating_ata → done
qualquer processamento: → error (com error_message); "Reprocessar" → queued
```

Rótulos na UI:

| Rótulo | Estados |
|---|---|
| Próxima | `scheduled` |
| Em andamento | `recording`, `stopping`, `joining`, `waiting_admission`, `in_call` |
| Transcrevendo | `queued`, `transcribing` |
| Processando | `generating_ata` |
| Concluída | `done` |
| Não gravada | `skipped`, `missed` |
| Cancelada | `cancelled` |
| Erro | `error` |

Invariante: no máximo uma reunião com `source IN ('ics','manual')` em
`recording`/`stopping` ao mesmo tempo. O scheduler garante isso sob advisory lock.

### transcript_segments

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | já existe |
| meeting_id | UUID FK | já existe |
| speaker | TEXT | rótulo: `user` (canal mic), `Speaker N`, `Remoto` (sem diarização) ou legado `Participante N` |
| text | TEXT NOT NULL | já existe |
| start_seconds, end_seconds | NUMERIC | relativos ao início da gravação; `end ≥ start` |
| **channel** | TEXT NOT NULL DEFAULT `'mixed'` | `mic` \| `remote` \| `mixed` |
| **pass** | TEXT NOT NULL DEFAULT `'final'` | `live` \| `final` |

Índice: `(meeting_id, pass, start_seconds)`.

Regra: quando o passe final termina, dentro de uma única transação, o sistema:
1. insere os segmentos `final`;
2. remapeia `item_evidence`;
3. apaga os `live`.

## Tabelas novas

### projects

| Coluna | Tipo | Regra |
|---|---|---|
| id | UUID PK | |
| name | TEXT NOT NULL UNIQUE | 2–80 caracteres |
| keywords | TEXT[] NOT NULL DEFAULT `'{}'` | termos extras para sugestão (o nome já conta) |
| created_at | TIMESTAMPTZ | |

Seed idempotente: Farmácia Digital, SUS Escolha, Portal SES, InfraVision, Agenith.

Sugestão: título normalizado (minúsculas, sem acento) contém o nome ou uma keyword →
`project_id` + `project_suggested=true`. A sugestão nunca sobrescreve uma escolha manual.

### meeting_audio

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| meeting_id | UUID FK ON DELETE CASCADE | |
| channel | TEXT NOT NULL | `mic` \| `remote` \| `mixed` |
| path | TEXT NOT NULL | dentro de `DATA_DIR/audio/<meeting>/` |
| format | TEXT NOT NULL | `pcm_s16le_16k` (durante a gravação) \| `ogg_opus` |
| bytes | BIGINT NOT NULL DEFAULT 0 | offset confirmado (PCM) ou tamanho final |
| duration_seconds | NUMERIC | |
| updated_at | TIMESTAMPTZ | |

`UNIQUE (meeting_id, channel)`.

### meeting_speakers

| Coluna | Tipo | Regra |
|---|---|---|
| meeting_id | UUID FK ON DELETE CASCADE | |
| label | TEXT | `user`, `Speaker 1`, … |
| display_name | TEXT NOT NULL | 1–60 caracteres; padrão = label (`user` → `USER_DISPLAY_NAME`) |

PK `(meeting_id, label)`. O nome é aplicado na leitura (transcrição, ata, itens).

### meeting_notes

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| meeting_id | UUID FK ON DELETE CASCADE | |
| kind | TEXT NOT NULL | `window` (extração ao vivo) \| `chunk` (map pós-reunião) |
| pass | TEXT NOT NULL | `live` \| `final` |
| start_seconds, end_seconds | NUMERIC | faixa coberta |
| text | TEXT NOT NULL | resumo do trecho (≤ 2 frases) |
| created_at | TIMESTAMPTZ | |

### meeting_items

| Coluna | Tipo | Regra |
|---|---|---|
| id | UUID PK | |
| meeting_id | UUID FK ON DELETE CASCADE | |
| type | TEXT NOT NULL | `decisao`, `decisao_arquitetural`, `pendencia`, `risco`, `requisito_funcional`, `requisito_nao_funcional`, `regra_negocio`, `restricao`, `premissa`, `pergunta_aberta`, `debito_tecnico` |
| description | TEXT NOT NULL | 5–1000 caracteres |
| owner | TEXT | responsável |
| due | TEXT | prazo como dito ("sexta-feira", "até 30/09") |
| attributes | JSONB NOT NULL DEFAULT `'{}'` | ver abaixo |
| review_status | TEXT NOT NULL DEFAULT `'proposto'` | `proposto` \| `aprovado` \| `rejeitado` |
| origin | TEXT NOT NULL | `live` \| `final` \| `manual` |
| created_at, updated_at | TIMESTAMPTZ | |
| reviewed_by | UUID FK users | |
| reviewed_at | TIMESTAMPTZ | |

`attributes` por tipo (todos opcionais):
- `pendencia`: `{dependencia, status_acao: "aberta"|"concluida"}`
- `decisao` / `decisao_arquitetural`: `{motivacao, impacto, sistema}`
- `risco`: `{categoria: arquitetura|seguranca|infraestrutura|prazo|integracao|dados|performance|escalabilidade|governanca, impacto}`

Regras:
- `origin` `live`/`final` → nasce `proposto`.
- `origin` `manual` (criado por humano) → nasce `aprovado`.
- Todo item de IA exige ≥ 1 `item_evidence` na criação (verificado no serviço, dentro da mesma
  transação).
- Índice: `(meeting_id, type)`.

Transições de `review_status`:

```text
proposto ──aprovar──► aprovado
proposto ──rejeitar──► rejeitado
aprovado|rejeitado ──reabrir──► proposto
```

Editar não muda o status, mas registra histórico.

### item_evidence

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| item_id | UUID FK ON DELETE CASCADE | |
| segment_id | BIGINT FK transcript_segments ON DELETE SET NULL | |
| start_seconds, end_seconds | NUMERIC NOT NULL | cópia do segmento, usada no remapeamento |
| channel | TEXT NOT NULL | |
| quote | TEXT | citação curta validada |

Remapeamento live → final: para cada evidência, escolher o segmento `final` do mesmo canal com
maior sobreposição temporal. Se não houver sobreposição, usar o mais próximo em até 10 s. Sem
candidato, `segment_id` fica null e os tempos são mantidos, o que ainda permite ouvir o áudio.

### item_history

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| item_id | UUID FK ON DELETE CASCADE | |
| action | TEXT NOT NULL | `created`, `edited`, `approved`, `rejected`, `reopened`, `merged`, `evidence_remapped`, `adr_edited`, `adr_approved`, `adr_rejected` |
| before | JSONB | campos alterados, valor anterior |
| after | JSONB | campos alterados, valor novo |
| actor_id | UUID FK users ON DELETE SET NULL | null = agente |
| created_at | TIMESTAMPTZ | |

### adrs

| Coluna | Tipo | Regra |
|---|---|---|
| id | UUID PK | |
| item_id | UUID FK meeting_items UNIQUE ON DELETE CASCADE | item do tipo `decisao_arquitetural` |
| meeting_id | UUID FK ON DELETE CASCADE | |
| number | INT UNIQUE | null até aprovar; `MAX(number)+1` sob advisory lock |
| title | TEXT NOT NULL | |
| context, problem, decision, consequences | TEXT NOT NULL | |
| alternatives | JSONB NOT NULL DEFAULT `'[]'` | `[{opcao, pros, contras}]` |
| risks | JSONB NOT NULL DEFAULT `'[]'` | `[string]` |
| status | TEXT NOT NULL DEFAULT `'proposto'` | `proposto` \| `aprovado` \| `rejeitado` |
| approved_by | UUID FK users | |
| approved_at, created_at, updated_at | TIMESTAMPTZ | |

Regras:
- Exibido como `ADR-001` apenas com `number` preenchido.
- Aprovar o ADR não aprova o item, e vice-versa. A UI oferece as duas ações.

### audit_log

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| at | TIMESTAMPTZ DEFAULT now() | |
| kind | TEXT NOT NULL | `egress_blocked`, `llm_provider_blocked`, `agent_auth_failed` |
| detail | JSONB NOT NULL | host, método e origem; nunca conteúdo de reunião |
| user_id | UUID FK users ON DELETE SET NULL | |

## Estado em memória (não persistido)

- **Host-agent:** `lastSeenAt`, versão e estado de captura por canal (`state`, `device`, `bytes`,
  `lastFrameAt`). É online quando `lastSeenAt` tem < 15 s.
- **LiveSession por canal:** buffer do chunker, offset do chunk, fila de chunks e atraso.
- **LiveAgent:** cursor (último segmento analisado), horário da última extração e da última
  consolidação. No boot, é reconstruído a partir de `meeting_notes` e dos segmentos.
- **Última leitura de GPU:** amostrada a cada 5 s enquanto houver gravação ou processamento.
