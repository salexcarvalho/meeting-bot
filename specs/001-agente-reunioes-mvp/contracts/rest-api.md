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
  project: {id, name, suggested}|null, skipRecording, organizer|null,
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
| GET | `/agenda?date=YYYY-MM-DD` | data no fuso `APP_TIMEZONE`; padrão = hoje | `{date, timezone, meetings: MeetingSummary[], hostAgent: {online, lastSeenAt, capture}, recordingMeetingId}` |
| POST | `/calendar/import` | multipart `files` (1–10 arquivos `.ics`, ≤ 2 MB cada) | `{created, updated, cancelled, unchanged, ignored, errors: [{file, message}]}` |
| POST | `/meetings/scheduled` | `{title, start (ISO), durationMinutes (5–720), url?, projectId?}` | `201 MeetingSummary`; `400` |
| PATCH | `/meetings/:id` | `{title?, start?, durationMinutes?, url?, projectId?\|null}` | `MeetingSummary`; `409` se já gravou |
| POST | `/meetings/:id/skip` | `{skip: boolean}` | `MeetingSummary`; `409` se já está gravando |
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
| GET | `/meetings?limit=50&before=ISO&projectId=` | — | `{meetings: MeetingSummary[]}` |
| POST | `/meetings` | `{title, url}` (Modo Agente, existente) | `201 MeetingSummary`; `429` (limite de bots) |
| POST | `/meetings/upload` | multipart `audio` + `title` (existente) | `201 MeetingSummary` |
| GET | `/meetings/:id` | — | `{meeting: MeetingSummary, segments: Segment[], speakers: {label, displayName, isUser}[], audio: {channel, format, durationSeconds}[], liveSummary, liveSummaryAt, hasScreenshot, legacyAta}` |
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
| POST | `/items/:id/approve` | — | `Item` |
| POST | `/items/:id/reject` | — | `Item` |
| POST | `/items/:id/reopen` | — | `Item` |
| GET | `/items/:id/history` | — | `{history: [{action, before, after, actor: {id, username}\|null, createdAt}]}` |
| PATCH | `/adrs/:id` | `{title?, context?, problem?, alternatives?, decision?, consequences?, risks?}` | `Adr` |
| POST | `/adrs/:id/approve` | — | `Adr` com `number` atribuído, se ainda não tinha |
| POST | `/adrs/:id/reject` | — | `Adr` (o número, se houver, é mantido) |

Toda alteração publica o evento `items` ou `adrs` no WebSocket da reunião.

## Projetos

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/projects` | — | `{projects: [{id, name, keywords, meetingCount}]}` |
| POST | `/projects` | `{name, keywords?: string[]}` | `201`; `409` (nome já existe) |
| PATCH | `/projects/:id` | `{name?, keywords?}` | projeto |
| DELETE | `/projects/:id` | — | `204`; as reuniões ficam sem projeto |

## Sistema

| Método | Rota | Resposta |
|---|---|---|
| GET | `/system/status` | `{hostAgent: {online, lastSeenAt, version, capture}, worker: {ok, model, diarization}, llm: {ok, model}, gpu: {utilization, memoryUsedMb, memoryTotalMb}\|null, recordingMeetingId, queue: {pending, current}}` |
| GET | `/healthz` (fora de `/api`) | `{ok: true}` |

## host-agent (`Authorization: Bearer AGENT_TOKEN`)

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/agent/heartbeat` | `{version, capture: null \| {meetingId, channels: {mic\|remote: {state: "recording"\|"restarting"\|"unavailable", device, bytes}}}}` | `{now, userDisplayName, timezone, alerts: {minutesBefore: [15,5,1]}, meetings: AgentMeeting[], recording: {meetingId, title} \| null}` |
| POST | `/agent/meetings/:id/skip` | — | `{ok: true}`; `409` se já estiver gravando |
| WS | `/agent/audio` | ver [ws-audio.md](ws-audio.md) | — |

```ts
AgentMeeting = { id, title, start, end, url|null, platform, skipRecording, status }
// Reuniões com scheduled_start entre agora-5min e agora+24h,
// status scheduled|skipped|recording, sem cancelled.
```

O heartbeat vai a cada 5 s. `recording` é o estado desejado, e o host-agent converge para ele:
- `meetingId` diferente do atual → para a captura atual e inicia a nova;
- `null` → para a captura e envia `end` nos dois canais.

Token inválido → `401` + `audit_log` (`agent_auth_failed`), com limite de taxa.
