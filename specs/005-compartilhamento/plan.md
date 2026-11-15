# Implementation Plan: Compartilhamento de reunião

**Branch**: `feat/005-compartilhamento` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: `specs/005-compartilhamento/spec.md`

## Summary

Entregar a tela e as rotas que faltam sobre a base de acesso já pronta (`meeting_shares`, guards e filtros por
dono). O dono compartilha por busca de usuário, lista, altera e revoga; o destinatário encontra a reunião em
"Compartilhadas comigo" com selo de nível; grant, mudança e revogação chegam ao vivo pelo WebSocket com
revogação imediata; tudo auditado só com ids. Abordagem: serviço fino `authz/shares.ts`, rotas novas em
`shares/routes.ts`, busca mínima `GET /users/lookup`, evento direcionado `meeting_access` no `LiveHub` e um
`ShareDialog` no frontend. Nenhuma permissão nova, nenhuma tabela nova (só duas colunas em `meeting_shares`).

## Technical Context

**Language/Version**: TypeScript 5 (Node 24) no backend e contracts; React 19 + Vite 8 no frontend.

**Primary Dependencies**: Express 5, `ws`, `pg`, zod 4 (contracts), `express-rate-limit` (já usado no login),
`react-router`, `lucide-react`. Nenhuma dependência nova.

**Storage**: PostgreSQL 16; migração aditiva idempotente em `apps/backend/src/schema.ts`.

**Testing**: Vitest (`npm test`), testes de banco (`npm run test:db -w @meeting-bot/backend`, Postgres descartável),
E2E Playwright (`npm run test:e2e -w @meeting-bot/backend`, desktop e celular).

**Target Platform**: instância única (localhost ou VPS de teste), HTTPS no servidor.

**Project Type**: monorepo web (`apps/backend`, `apps/frontend`, `packages/contracts`).

**Performance Goals**: revogação refletida no WS em até 2 s; `GET /meetings` com a projeção por espectador sem
regressão perceptível (uma junção por `(meeting_id, user_id)` na PK); lookup abaixo de 50 ms com 100 usuários.

**Constraints**: guard decide pelo padrão da rota; 404 sem acesso e 403 sem ser dono; sem conteúdo no
`audit_log`; sem egress; mutações com `requireSameOrigin`.

**Scale/Scope**: dezenas de usuários no máximo; até 500 ocorrências por série (`SERIES_ABSOLUTE_CAP`).

## Constitution Check

*Constituição 2.2.0. Reavaliado depois do design.*

| Princípio | Avaliação |
|---|---|
| I. Local-first e privacidade | OK. Nada sai da máquina: sem e-mail, sem serviço externo. O acesso é entre contas da mesma instância. Conteúdo só vai a quem o dono escolheu. |
| II. Políticas da organização | N/A. |
| III. Humano no controle | OK. `edit` continua podendo aprovar ou rejeitar itens (comportamento atual da F2); a IA não ganha poder novo. A UI do dono avisa o que o destinatário verá. |
| IV. Rastreabilidade | OK. Edições do destinatário gravam o autor no histórico do item (já existe); grants e revogações vão para `audit_log`. |
| V. GPU | N/A. |
| VI. Desktop nativo | OK. Sem mudança no host-agent; alertas e gravação seguem do dono. |
| VII. Evolução incremental e verificável | OK. Tarefas com teste antes; entrega por história (US1 a US5). |
| VIII. Stack e idioma | OK. TS/React, textos em pt-BR, commits em português. |
| Regra "Acesso" (operacional) | OK e reforçada: administradores não leem conteúdo de terceiros; o diretório de busca é mínimo e limitado; consumo de IA deixa de mostrar custo do dono ao destinatário. |

Sem violações; a tabela de complexidade fica vazia. As perguntas #1 a #5 da spec não exigem emenda
constitucional (a opção C da #3, e-mail, exigiria).

## Design

### Backend

1. **Guard** (`authz/index.ts`, `routes.ts`): `ownerOnly(req, pattern)` passa a considerar um segundo conjunto
   `OWNER_ONLY_ANY_METHOD = {"/meetings/:id/shares", "/meetings/:id/shares/:userId"}`; para esses padrões o modo é
   `owner` também em `GET`. Nenhuma outra rota muda.
2. **Serviço** `apps/backend/src/shares/service.ts` (funções puras de SQL, sem Express):
   `listShares(meetingId)`, `grantShare(actor, meetingId, {userId, access, scope})`,
   `changeShare(...)`, `revokeShare(...)`, `leaveShare(user, meetingId)`, `markSeen(user, meetingId)`,
   `seriesOccurrences(ref)`. Cada escrita roda em `withTransaction`, trava a reunião, valida e devolve
   `{ affected, entries }`. Efeitos colaterais (auditoria, hub) ficam nas rotas, depois do commit.
3. **Rotas** `apps/backend/src/shares/routes.ts` (`features.authedRouters`, registrado em `modules.ts`):
   `GET|POST /meetings/:id/shares`, `PUT|DELETE /meetings/:id/shares/:userId`,
   `POST /shared-with-me/:meetingId/seen`, `DELETE /shared-with-me/:meetingId`. Validação com zod
   (`parseBody`). Rotas do destinatário ficam sem `:id` para fugir do `router.param("id")`.
4. **Busca** `apps/backend/src/users/lookup.ts` + rota `GET /users/lookup` (`requirePermission("meetings.manage")`)
   com `rateLimit` por `req.user.id`. Escape de curingas ILIKE em função pura testável.
5. **Listas por espectador**: `db.ts` ganha `meetingSelectFor(userId)` (junção `LEFT JOIN meeting_shares s ON
   s.meeting_id = m.id AND s.user_id = $1` e subconsulta de contagem só para o dono) e `listMeetings({scope})`;
   `meetings/summary.ts` ganha `toMeetingListItem(row, viewer)`. `calendar/service.ts#getAgenda` usa o mesmo.
   O resumo difundido (`toMeetingSummary`) não muda.
6. **Hub** (`live/hub.ts`): `publishToUser(userId, msg)`, `revokeUser(meetingId, userId)` e chamada real de
   `invalidateAudience`. Ordem do revoke definida na pesquisa (D11).
7. **Exclusão** (`DELETE /meetings/:id`): captura `meetingAudience` antes de apagar e publica
   `meeting_access` com `change: "deleted"` para os destinatários.
8. **Auditoria**: quatro `AuditKind` novos; detalhe só com ids.
9. **Consumo de IA**: `llm/usage.ts` filtra por `m.created_by = $user` (sem `visibleMeetingsSql`).

### Frontend

- `components/ShareDialog.tsx`: busca com debounce (300 ms, mínimo 3 caracteres), resultado com iniciais e nível
  permitido, seletor Leitura/Edição, aviso "o destinatário verá link, participantes, transcrição e áudio", seletor
  de alcance (quando há série), lista "Quem tem acesso" com troca de nível e remoção (com confirmação).
- `components/ShareBadge.tsx`: ícone + texto ("Compartilhada · leitura|edição", "Compartilhada com N", "Nova").
- `pages/Reunioes.tsx`: abas Todas, Minhas, Compartilhadas comigo (e Compartilhadas por mim) sincronizadas com a URL
  (`?escopo=`); contador de "Nova"; mesclagem de `meeting` ao vivo preservando os campos por espectador.
- `pages/Hoje.tsx` e `AgendaItem.tsx`: selo.
- `pages/Reuniao.tsx`: botão **Compartilhar** (dono), **Sair desta reunião** (destinatário), reação a
  `meeting_access` (atualiza `access`, aviso e redirecionamento ao revogar), `seen` ao abrir.
- Acessibilidade: `<dialog>` nativo (`Dialog.tsx`), foco no campo de busca, lista de resultados com
  `role="listbox"`, estados anunciados por `aria-live`, confirmação sem `window.confirm`.

### Ordem de entrega (cada história é independentemente testável)

US1 (conceder) → US2 (alterar, revogar, ao vivo) → US3 (lista, selos, sair) → US5 (isolamento, em paralelo à US3 nos
testes) → US4 (série). O MVP útil é US1 + US2 + US3.

## Project Structure

### Documentation (this feature)

```text
specs/005-compartilhamento/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   ├── rest-api.md
│   └── ws-live.md
└── checklists/requirements.md
```

### Source Code (arquivos tocados)

```text
packages/contracts/src/
├── platform.ts            # ShareAccess, ShareScope, ShareInput, ShareEntry, UserLookupItem
├── domain.ts              # MeetingListItem, MeetingDetail.ownerName
└── events.ts              # meeting_access em LiveServerMessage

apps/backend/src/
├── schema.ts              # colunas updated_at/seen_at + índice parcial
├── security/audit.ts      # 4 AuditKind
├── authz/index.ts         # ownerOnly para qualquer método nas rotas /shares
├── routes.ts              # OWNER_ONLY_ANY_METHOD, scope em GET /meetings, publish no DELETE
├── db.ts                  # meetingSelectFor, listMeetings({scope})
├── meetings/summary.ts    # toMeetingListItem
├── shares/service.ts      # novo
├── shares/routes.ts       # novo
├── users/lookup.ts        # novo (+ rota)
├── live/hub.ts            # publishToUser, revokeUser
├── calendar/service.ts    # getAgenda com MeetingListItem
├── llm/usage.ts           # só reuniões próprias
└── modules.ts             # registrar shares/routes

apps/backend/test/
├── compartilhamento-unit.test.ts   # escape do lookup, série (função pura), ownerOnly
└── db/compartilhamento.test.ts     # matriz, WS, escopos, série, desativado

apps/frontend/src/
├── components/ShareDialog.tsx, ShareBadge.tsx
├── pages/Reunioes.tsx, Hoje.tsx, Reuniao.tsx
├── components/AgendaItem.tsx
├── hooks.ts, api.ts, live.ts
└── styles.css

apps/backend/e2e/                    # cenário de compartilhar e revogar ao vivo
README.md, README.en.md, README.es.md, CHANGELOG.md, docs/ARCHITECTURE.md,
docs/analise/plataforma-multiusuario.md
```

**Structure Decision**: monorepo existente, sem pacote novo. O serviço de compartilhamento fica em
`apps/backend/src/shares/` (pasta própria, como `items/` e `projects/`) e se registra por `features.authedRouters`.

## Riscos e pontos de atenção

- Quem revisa a segurança deve olhar primeiro: (1) o conjunto `OWNER_ONLY_ANY_METHOD`, (2) a ordem do revoke,
  (3) que `toMeetingSummary` continua sem campos por espectador, (4) o limite de taxa do lookup.
- A migração roda em banco real: aplicar só com confirmação e depois de checar reuniões em processamento
  (regra de deploy com backend ocioso).
- Perguntas #1 a #5 da spec devem ser respondidas antes de `/speckit-implement`; as recomendações já estão
  refletidas neste plano e nos contratos.

## Complexity Tracking

Nenhuma violação da constituição a justificar.
