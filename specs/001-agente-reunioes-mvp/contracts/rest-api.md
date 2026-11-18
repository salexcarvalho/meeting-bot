# Contrato — API REST do backend

Base: `http://127.0.0.1:3000/api`. As respostas são JSON. Erros usam o formato
`{ "error": "mensagem em pt-BR" }`.

**Autenticação:**
- **UI:** cookie `mb_session` (httpOnly). Métodos que alteram estado exigem `Origin` igual ao
  host, quando o cabeçalho vier.
- **host-agent:** `Authorization: Bearer <AGENT_TOKEN>` e somente nas rotas `/api/agent/*`. Essas
  rotas não aceitam cookie. As rotas de UI não aceitam o token.

Tipos (definidos em zod em `packages/contracts`):

```ts
MeetingSummary = {
  id, title, platform, url|null, status, statusLabel, source,
  scheduledStart|null, scheduledEnd|null, startedAt|null, endedAt|null,
  project: {id, name, suggested}|null, skipRecording, offDay, autoOnOffDay, organizer|null,
  attendees: {name, email|null}[], errorMessage|null, botActive, createdAt
}
Segment = { id, channel, pass, speaker, speakerName, text, start, end }
Item = {
  id, meetingId, type, description, owner|null, due|null, attributes, reviewStatus, origin,
  evidence: {segmentId|null, start, end, channel, quote|null}[],
  createdAt, updatedAt, reviewedBy|null, reviewedAt|null
}
Adr = {
  id, itemId, meetingId, number|null, code|null /* "ADR-001" */, title, context, problem,
  alternatives: {opcao, pros, contras}[], decision, consequences, risks: string[], status,
  approvedAt|null
}
```

## Autenticação (existente, sem mudança)

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/auth/login` | `{username, password}` | `200 {user}` + cookie; `401`; `429` |
| POST | `/auth/logout` | — | `204` |
| GET | `/auth/me` | — | `{user: {id, username}, displayName}` |
| POST | `/auth/password` | `{current, next}` | `204`; `400` (senha fraca); `401` |

## Agenda e calendário

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/agenda?date=YYYY-MM-DD` | data no fuso `APP_TIMEZONE`; padrão = hoje | `{date, timezone, meetings: MeetingListItem[], hostAgent: {online, lastSeenAt, capture}, recordingMeetingId}` |
| POST | `/calendar/import` | multipart `files` (1–10 arquivos `.ics`, ≤ 2 MB cada) | `{created, updated, cancelled, unchanged, ignored, errors: [{file, message}]}` |
| POST | `/meetings/scheduled` | `{title, start (ISO), durationMinutes (5–720), url?, projectId?}` | `201 MeetingSummary`; `400` |
| PATCH | `/meetings/:id` | `{title?, start?, durationMinutes?, url?, projectId?\|null}` | `MeetingSummary`; `409` se já gravou |
| POST | `/meetings/:id/skip` | `{skip: boolean}` | `MeetingSummary`; `409` se já está gravando |
| POST | `/meetings/:id/auto-off-day` | `{enabled: boolean}` | `MeetingSummary`; liga/desliga o lembrete e a entrada automática numa reunião em dia fora de `WORKING_DAYS` (`autoOnOffDay`); `409` se não está `scheduled`/`skipped` |
| POST | `/meetings/:id/record` | — | `MeetingSummary` (`recording`); `409` com `{error, conflictMeetingId}` se houver outra gravação; `503` se o host-agent estiver offline |
| POST | `/meetings/:id/end` | — | `202`; para gravação local (`stop_requested`) ou bot |

Regras do import (FR-001/FR-002):
- Chave de upsert: `(UID, RECURRENCE-ID ou início da ocorrência)`.
- Atualiza título, horário, participantes e link somente se `SEQUENCE` ≥ o atual e a reunião
  ainda estiver em `scheduled`, `skipped` ou `missed`.
- Ocorrências expandidas de ontem até +30 dias.
- `METHOD:CANCEL` ou `STATUS:CANCELLED` → `cancelled` (se ainda não gravou).
- Eventos de dia inteiro são ignorados (`ignored`).

## Reuniões

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/meetings?limit=50&before=ISO&projectId=&scope=all\|mine\|shared\|shared_by_me` | — | `{meetings: MeetingListItem[]}` (`MeetingSummary` + `access`, `ownerName`, `shareCount`, `shareUnseen` do espectador); `scope` inválido = `400`. Compartilhamento: `specs/005-compartilhamento/contracts/rest-api.md` |
| POST | `/meetings` | `{title, url}` (Modo Agente, existente) | `201 MeetingSummary`; `429` (limite de bots) |
| POST | `/meetings/upload` | multipart `audio` + `title` (existente) | `201 MeetingSummary` |
| GET | `/meetings/:id` | — | `{meeting: MeetingSummary, segments: Segment[], speakers: {label, displayName, isUser}[], audio: {channel, format, durationSeconds}[], liveSummary, liveSummaryAt, hasScreenshot, legacyAta, access, ownerName}` |
| DELETE | `/meetings/:id` | — | `204`; `409` se estiver gravando ou processando |
| GET | `/meetings/:id/audio?channel=mic\|remote\|mixed` | — | stream `audio/ogg` (range suportado) |
| GET | `/meetings/:id/screenshot` | — | `image/png` (Modo Agente) |
| POST | `/meetings/:id/reprocess` | `{step: "all"\|"analysis"}` | `202` |
| PATCH | `/meetings/:id/speakers/:label` | `{displayName}` | `{label, displayName}` |
| GET | `/meetings/:id/items` | — | `{items: Item[]}` |
| POST | `/meetings/:id/items` | `{type, description, owner?, due?, attributes?}` | `201 Item` (origin `manual`, `aprovado`) |
| GET | `/meetings/:id/adrs` | — | `{adrs: Adr[]}` |
| GET | `/meetings/:id/ata` | — | `{markdown, generatedAt, hasAnalysis}`, renderizado na hora com o estado atual |
| GET | `/meetings/:id/ata.md` | — | `text/markdown` com `Content-Disposition: attachment` |

## Itens e ADRs (revisão humana)

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| PATCH | `/items/:id` | `{type?, description?, owner?\|null, due?\|null, attributes?}` | `Item` (histórico `edited` só com os campos alterados) |
| POST | `/items/:id/approve` | — | `Item` (com `tasks.manage`: `Item & { task, taskNotice? }`, ver Tarefas pessoais) |
| POST | `/items/:id/reject` | — | `Item` |
| POST | `/items/:id/reopen` | — | `Item` |
| GET | `/items/:id/history` | — | `{history: [{action, before, after, actor: {id, username}\|null, createdAt}]}` |
| PATCH | `/adrs/:id` | `{title?, context?, problem?, alternatives?, decision?, consequences?, risks?}` | `Adr` |
| POST | `/adrs/:id/approve` | — | `Adr` com `number` atribuído, se ainda não tinha |
| POST | `/adrs/:id/reject` | — | `Adr` (o número, se houver, é mantido) |

Toda alteração publica o evento `items` ou `adrs` no WebSocket da reunião.

## Tarefas pessoais (specs/002-pendencias-tarefas)

Contrato completo em `specs/002-pendencias-tarefas/contracts/rest-api.md`. Resumo: `GET /tasks` (filtros, `counts`), `POST /tasks`, `GET|PATCH|DELETE /tasks/:id`,
`POST /tasks/:id/status`, `GET /tasks/:id/history`, `GET /tasks/summary`, `POST /tasks/from-item` e `GET /meetings/:id/tasks`.
Exigem `tasks.read` (GET) ou `tasks.manage` (demais); toda rota filtra por `owner_id`, e tarefa alheia (inclusive para ADMIN) é `404`.
`POST /items/:id/approve` passa a devolver `Item & { task: TaskRef | null, taskNotice? }` para quem tem `tasks.manage`.

## Projetos

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/projects` | — | `{projects: [{id, name, keywords, meetingCount}]}` |
| POST | `/projects` | `{name, keywords?: string[]}` | `201`; `409` (nome já existe) |
| PATCH | `/projects/:id` | `{name?, keywords?}` | projeto |
| DELETE | `/projects/:id` | — | `204`; as reuniões ficam sem projeto |

## Uso e custo de IA e auditoria visível (specs/004-uso-custo)

Só leitura. Contratos completos em `specs/004-uso-custo/contracts/`. Período: `month=AAAA-MM` ou `from`/`to` (ISO,
janela máxima de 24 meses, nunca os dois); sem nada = mês corrente no fuso `APP_TIMEZONE`.

| Método | Rota | Resposta |
|---|---|---|
| GET | `/usage/me` | `{period, totals, byPurpose[], byProvider[], byModel[], byDay[], asr: {local, external}, topMeetings[], retention}`; só linhas com `user_id` = sessão (reunião compartilhada não entra) |
| GET | `/usage/me/calls` | `{items[], nextCursor}`; filtros `status` (all, ok, error), `purpose`, `provider`, `cursor`, `limit` 1–100 |
| GET | `/admin/usage` | `ai_usage.read`; mesmos agregados com `byUser[]` e **sem nenhum campo de reunião**; `403` sem a permissão |
| GET | `/audit/me` | `{items[], nextCursor}` eventos em que o usuário é ator ou alvo, projetados (lista permitida de campos); IP só em `auth_login_failed` |
| GET | `/admin/audit` | `audit.read`; eventos do sistema projetados; filtros `kind`, `userId`, `from`, `to`, `cursor`, `limit`; `403` sem a permissão |
| GET | `/audit/kinds` | `{items: [{kind, label}]}` para os filtros, conforme o papel |

Erros: `400` (período, filtro ou cursor inválidos), `401`, `403`. O custo é o informado pelo provedor (`null` =
"sem custo por chamada"). `GET /llm/usage` foi removido. Novos eventos de auditoria: `auth_login`,
`auth_login_failed`, `auth_logout`, `auth_password_changed`, `retention_pruned`; `external_llm`/`external_asr`
passam a gravar o `user_id` do dono.

## Busca e chat (specs/003-busca-chat)

Contratos completos em `specs/003-busca-chat/contracts/`. Toda rota exige `meetings.read`; trechos de transcrição exigem
`transcripts.read` e ata, item, ADR e metadados exigem `documents.read` (o filtro `kind` é interseção com o que o papel pode
ler). O conteúdo sai só de reuniões visíveis (`visibleMeetingsSql`: dono ou `meeting_shares`), com a permissão **dentro da
consulta**; reunião fora do alcance é indistinguível de inexistente. Com `SEARCH_ENABLED=false` as rotas respondem `404`.
Consulta, pergunta, resposta e trechos nunca vão para log nem para `audit_log`.

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/search` | `q` (1–500), `mode=hybrid\|text\|semantic`, `kind=a,b`, `projectId`, `from`, `to`, `meetingId` (≤ 20), `limit` (1–50), `offset` (0–100) | `{query, mode, modeUsed, semantic: {available, reason}, hits: SearchHit[], total, tookMs}`; 60/min por usuário |
| POST | `/search/chat` | `{question (≤ 500), history? (≤ 6 de ≤ 1000), scope? {projectId, from, to, meetingIds}}`, estrito (`llm`, `provider` e campos desconhecidos → 400) | `{answered, answer, citations[], sources: SearchHit[], retrieval, model, liveBusy, tookMs}`; sempre LLM local; 12/min por usuário; `503` com o modelo local fora ou o chat desligado (`SEARCH_SEMANTIC=off`) |
| GET | `/search/status` | `meetingId?` | global: `{enabled, semantic: {available, model, dim, reason}, chat: {available, reason}, paused, totals, failures[]}` só das reuniões visíveis; com `meetingId`: `{meetingId, status, chunkCount, embeddedCount, indexedAt}` (`404` se não visível) |
| POST | `/search/reindex` | `{meetingId?}` | `202 {queued}`; só reuniões do próprio usuário (`meetings.manage`); `404` para alheia; 6/hora |

Erros: `400` (consulta vazia, só pontuação, > 500 caracteres, filtro inválido), `401`, `403`, `404`, `429`, `503` (chat).
O evento WebSocket `{type: "search_index", meetingId, status}` informa o estado do índice da reunião (sem conteúdo).
Navegação: `/reunioes/:id?seg=<segmentId>&t=<segundos>` (transcrição), `?item=<id>`, `?adr=<id>`; `/busca?q=…&tab=perguntar`.

## Sistema

| Método | Rota | Resposta |
|---|---|---|
| GET | `/system/status` | `{hostAgent: {online, lastSeenAt, version, capture}, worker: {ok, model, diarization}, llm: {ok, model}, gpu: {utilization, memoryUsedMb, memoryTotalMb}\|null, recordingMeetingId, queue: {pending, current}, search: {enabled, semantic, paused}}` |
| GET | `/healthz` (fora de `/api`) | `{ok: true}` |

## host-agent (`Authorization: Bearer AGENT_TOKEN`)

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/agent/heartbeat` | `{version, capture: null \| {meetingId, channels: {mic\|remote: {state: "recording"\|"restarting"\|"unavailable", device, bytes}}}}` | `{now, userDisplayName, timezone, alerts: {minutesBefore: [15,5,1]}, meetings: AgentMeeting[], recording: {meetingId, title} \| null}` |
| POST | `/agent/meetings/:id/skip` | — | `{ok: true}`; `409` se já estiver gravando |
| POST | `/agent/calendar/import` | `AgentCalendarImportInput` (abaixo) | `AgentCalendarImportResult`; `400` corpo ou `.ics` inválido; `413` corpo acima de 256 kB; `503` sem `AGENT_OWNER` |
| GET | `/agent/meetings?date=YYYY-MM-DD` | `date` opcional (padrão hoje em `APP_TIMEZONE`) | `{date, meetings: AgentDayMeeting[]}`; `400` data inválida; `503` sem `AGENT_OWNER` |
| WS | `/agent/audio` | ver [ws-audio.md](ws-audio.md) | — |

```ts
AgentMeeting = { id, title, start, end, url|null, platform, skipRecording, noAlerts, status }
// noAlerts: dia fora de WORKING_DAYS (fuso APP_TIMEZONE) sem pedido do usuário; o host-agent não faz lembrete.
// Reuniões com scheduled_start entre agora-5min e agora+24h,
// status scheduled|skipped|recording, sem cancelled.
```

O heartbeat vai a cada 5 s. `recording` é o estado desejado, e o host-agent converge para ele:
- `meetingId` diferente do atual → para a captura atual e inicia a nova;
- `null` → para a captura e envia `end` nos dois canais.

Token inválido → `401` + `audit_log` (`agent_auth_failed`), com limite de taxa.

### Agenda do dia pela Aurora (`POST /api/agent/calendar/import`)

A Aurora (assistente externo, sem sessão de usuário) envia toda manhã a agenda do dia do Outlook. As reuniões
são gravadas em nome do `AGENT_OWNER` (como as de um `.ics`: `source = 'ics'`), com limite de 10 envios por
minuto além do limite geral do agente. Sucesso grava `audit_log` `agent_calendar_import` (só contagens, nunca
títulos ou participantes); falha de validação (`400`), `.ics` inválido ou falta de dono (`503`) grava
`agent_calendar_import_failed` com `reason` (`invalid_body`, `rejected`, `no_owner`), o modo e contagens, sem
conteúdo do envio. Corpo acima de 256 kB (limite do servidor) responde `413` com "Corpo da requisição excede o
limite." (essa falha não é auditada pela rota).

```ts
AgentCalendarImportInput = {
  source: "aurora-outlook",
  date: "AAAA-MM-DD",                 // o dia, no fuso da aplicação (APP_TIMEZONE)
  // exatamente um de:
  events: {                           // no máximo 100; cada ocorrência de série vem como evento próprio
    uid: string, title: string,
    start: string, end: string,       // ISO 8601 com fuso (Z ou ±hh:mm); início dentro de `date`
    organizer?: string, location?: string,
    teams?: string,                   // link https da reunião
    status?: string,                  // "cancelled"/"canceled" cancela; outro valor é informativo
    recurring?: boolean               // true em ocorrência de série: muda a chave (ver "Identidade")
  }[],
  ics?: string,                       // alternativa: texto de um .ics (até 150 000 caracteres)
  confirmEmpty?: boolean,             // padrão false; ver "Lista vazia"
}
AgentCalendarImportResult = {
  source, date, created, updated, cancelled, removed, unchanged, ignored, partialSeries, errors,
  ignoredEvents: { uid, reason: "outside_date" | "non_working_day" }[],        // até 20
  removalSkipped?: "empty_without_confirm",                 // só quando a remoção foi pulada
}
```

```bash
curl -sS -X POST "$MEETBOT_URL/api/agent/calendar/import" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"aurora-outlook","date":"2026-11-14","events":[
        {"uid":"AAMk-123","title":"Daily","start":"2026-11-14T09:00:00-03:00","end":"2026-11-14T09:30:00-03:00",
         "teams":"https://teams.microsoft.com/l/meetup-join/..."}]}'
```

Regras:
- **Identidade e idempotência:** `uid` + início. Evento único (sem `recurring`) usa `recurrence_key` vazia, a
  mesma do `.ics`: um evento enviado pela Aurora e depois importado de um `.ics` (ou o contrário) é a mesma
  reunião, sem duplicar. Ocorrência de série deve vir com `recurring: true` (cada ocorrência é um evento próprio
  com o mesmo `uid`) e usa o ISO do início como chave. Se um evento sem a marca chegar com um `uid` que já tem
  reunião em outro dia, o envio o trata como ocorrência de série (chave = início) em vez de falhar, mas a
  marca evita duplicar contra um `.ics` que traga a série. Reenviar o mesmo envio não duplica; mudou
  título/horário/link, atualiza a mesma reunião.
- **Remarcação no mesmo dia:** evento único movido de horário já é a mesma linha (chave vazia). Para ocorrência de
  série (`recurring: true`), a chave nova (novo início) não casa com a linha existente; então, no mesmo envio
  (mesma origem, mesmo dia, mesmo `uid`), a linha futura `scheduled`/`skipped` da origem que não casa com nenhum
  evento enviado é pareada com um evento enviado do mesmo `uid` que não tem linha, por ordem de início, e ganha a
  chave nova: início, fim e dados são atualizados e as escolhas do usuário (Não gravar, Gerar itens, projeto,
  descrição) ficam. Sem par (mais eventos que linhas), o evento vira reunião nova; linha sem par segue a regra
  de "Sumiu da lista". Mover para outro dia não é remarcação (o evento sai de `date`).
- **Concorrência:** envios simultâneos do mesmo dono, origem e dia são serializados por `pg_advisory_xact_lock`
  (chave `agent-calendar:<dono>:<origem>:<data>`); ambos respondem `200`, sem duplicar nem violar o índice único.
- **Sequência do convite:** a Aurora não envia `SEQUENCE`. Numa reunião vinda de `.ics` com sequência maior que 0,
  o envio atualiza ou cancela normalmente, e nunca rebaixa a sequência gravada. A importação manual de `.ics`
  segue com as regras de sempre.
- **O dia:** só valem eventos cujo início cai em `date` no fuso `APP_TIMEZONE`. Evento fora do dia (fuso ou dia
  trocado) não derruba o envio: é contado em `ignored`, listado em `ignoredEvents` (`outside_date`) e os demais
  seguem. O `uid` ignorado conta como presente: nunca causa a remoção de reunião existente com o mesmo `uid`.
  Nada de outro dia é tocado.
- **Dia sem agenda (`WORKING_DAYS`):** ocorrência de série (`recurring: true`, ou RRULE do `.ics` enviado) que cai em
  dia fora de `WORKING_DAYS` (padrão sábado e domingo, no fuso `APP_TIMEZONE`) não gera reunião: conta em `ignored`,
  entra em `ignoredEvents` com `non_working_day` e, como `outside_date`, seu `uid` nunca causa a remoção de reunião
  existente. Evento único em dia não útil entra normalmente, mas sem lembrete nem entrada/gravação automática.
- **Sumiu da lista:** reunião do mesmo `import_source`, do mesmo dia, ainda `scheduled`/`skipped` e com início
  no futuro que não veio no envio vira `cancelled` (com `import_removed_at`). Se voltar à lista, é reativada.
  Reunião manual, de `.ics`, passada, `missed`, em andamento, gravada, em processamento ou cancelada pelo usuário
  nunca é removida nem reativada pelo envio.
- **Lista vazia:** `events: []` (ou `.ics` sem eventos) não remove nada por padrão: responde `200` com contagens
  zero e `removalSkipped: "empty_without_confirm"`. Só com `confirmEmpty: true` o dia da origem é limpo; a
  Aurora deve confirmar apenas quando o dia realmente está vazio. Se todos os eventos enviados foram ignorados
  (fora do dia), também não é lista vazia, e nada é removido.
- **Erros:** `.ics` ilegível responde `400` com mensagem fixa ("Arquivo .ics inválido."), sem repassar o texto do parser.
- **Escolhas do usuário:** reenviar nunca muda "Não gravar" (`skip_recording`), "Gerar itens" (`extract_items`),
  projeto, nem apaga descrição, participantes, organizador, local ou link que o envio não informou. O envio não
  altera as regras de gravação: o assistente entra nas reuniões com link no horário, exceto "Não gravar".

### Agenda do dia, leitura (`GET /api/agent/meetings`)

Mesmo token (`AGENT_TOKEN`) e mesmo escopo do envio e do heartbeat: só as reuniões agendadas (`source` `ics` ou
`manual`) do `AGENT_OWNER`. Somente leitura: não registra heartbeat, não grava nada e não faz auditoria. Devolve
as reuniões cujo início cai no dia `date` (`AAAA-MM-DD`, fuso `APP_TIMEZONE`; sem `date`, hoje), em ordem de início,
em qualquer status (inclusive `cancelled`; filtre por `status` se não quiser as canceladas). `date` inválida
(formato, dia inexistente ou repetida) responde `400` com `{error: "date: ..."}`; token ausente ou errado, `401`.

```ts
AgentDayMeeting = {
  id, icalUid: string|null,          // uid do evento de origem (.ics/Aurora); null em reunião cadastrada à mão
  title, start, end,                 // ISO 8601 (UTC)
  url: string|null, platform: "meet"|"teams"|"upload"|"other"|null,   // null = sem link reconhecido
  skipRecording: boolean,            // "Não gravar"
  status: MeetingStatus,             // scheduled, skipped, recording, done, cancelled, ...
  recurring: boolean,                // ocorrência de série (recorrência manual, .ics ou Aurora)
}
// resposta: { date: "AAAA-MM-DD", meetings: AgentDayMeeting[] }
```

```bash
curl -sS "$MEETBOT_URL/api/agent/meetings?date=2026-11-14" -H "Authorization: Bearer $AGENT_TOKEN"
```
