---
description: "Tarefas do compartilhamento de reunião"
---

# Tasks: Compartilhamento de reunião

**Input**: `specs/005-compartilhamento/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: as 5 perguntas da spec respondidas (Clarifications — Session 2026-11-14, todas na opção recomendada).

**Tests**: a Constituição (princípio VII) exige teste quando viável; em cada história, os testes vêm antes da
implementação e devem falhar primeiro.

**Organization**: por história (US1 a US5 da spec). Marque `[X]` conforme concluir.

## Format: `[ID] [P?] [Story] Descrição com caminho`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 a US5

## Path Conventions

`apps/backend/src/`, `apps/backend/test/`, `apps/frontend/src/`, `packages/contracts/src/`.

---

## Phase 1: Setup (contratos, banco, auditoria)

- [X] T001 [P] Contratos zod em `packages/contracts/src/platform.ts` e `domain.ts`: `ShareAccess`, `ShareScope`, `ShareInput` (userId uuid, access, scope padrão `occurrence`), `ShareEntry`, `UserLookupItem`, `MeetingListItem` (`MeetingSummary` + `access`, `ownerName`, `shareCount`, `shareUnseen`) e `MeetingDetail.ownerName`
- [X] T002 [P] Evento `meeting_access` (`change`, `access`, `by`, `title`, `meeting`) em `packages/contracts/src/events.ts` e `LiveServerMessage`
- [X] T003 [P] Teste de contratos (`apps/backend/test/contracts-schemas.test.ts`): `ShareInput` recusa nível inválido e alcance inválido; `meeting` difundido não aceita campos por espectador
- [X] T004 Migração aditiva em `apps/backend/src/schema.ts` (bloco `DO $$` com `seen_at`/`updated_at` e backfill único + índice parcial de não vistos), conforme `data-model.md`; conferir idempotência rodando `migrate` duas vezes
- [X] T005 [P] Quatro `AuditKind` (`meeting_share_granted|changed|revoked|left`) em `apps/backend/src/security/audit.ts`
- [X] T006 [P] Esqueleto `apps/backend/test/db/compartilhamento.test.ts` com os usuários (dono, destinatário, viewer, admin, super, desativado), reuniões fixture e o helper `call` reaproveitados de `multiusuario.test.ts`

**Checkpoint**: contratos compilam, `npm run typecheck` passa, migração idempotente.

---

## Phase 2: Foundational (bloqueia as histórias)

- [X] T007 [P] Teste (unitário + db) do guard: `GET /meetings/:id/shares` e `/shares/:userId` são "dono para qualquer método"; destinatário `read` e `edit` recebem 403 em GET; variações `/MEETINGS/...` e `//` seguem 404 (com mutação que prova que o teste pega o erro) em `apps/backend/test/compartilhamento-unit.test.ts`
- [X] T008 Guard: conjunto `OWNER_ONLY_ANY_METHOD` em `apps/backend/src/routes.ts` e `ownerOnly` cobrindo GET para esses padrões (mudança mínima em `authz/index.ts` só se o tipo exigir)
- [X] T009 `apps/backend/src/db.ts`: `meetingSelectFor(userId)` (junção da linha própria de `meeting_shares`, `owner_name`, `share_count` só para o dono, `share_unseen`) e `listMeetings({scope})`; `apps/backend/src/meetings/summary.ts`: `toMeetingListItem(row)`; `toMeetingSummary` permanece igual
- [X] T010 `apps/backend/src/live/hub.ts`: `publishToUser(userId, msg)`, `revokeUser(meetingId, userId)` (remove de `state.meetings` em todas as conexões) e exportar um helper que encadeia `invalidateAudience` + `revokeUser`

**Checkpoint**: fundação pronta; as histórias podem começar.

---

## Phase 3: User Story 1 - Compartilhar (Priority: P1) — MVP parte 1

**Goal**: o dono concede leitura ou edição a outro usuário, por busca.

**Independent Test**: Ana compartilha com Bia (leitura); Bia abre a reunião (200) e recebe 403 ao editar item.

### Tests (escrever primeiro)

- [X] T011 [P] [US1] Teste db: conceder `read` e `edit`; recusas (próprio dono, usuário inexistente, desativado, VIEWER com `edit` = 422; duplicado = 409); não-dono 403/404; auditoria `granted` sem título — em `test/db/compartilhamento.test.ts`
- [X] T012 [P] [US1] Teste db e unitário da busca: mínimo 3 caracteres, máximo 8, só ativos, sem o próprio, `%`/`_` literais, campos exatos (`id`, `username`, `name`, `canEdit`), 403 para VIEWER, 429 após o limite

### Implementation

- [X] T013 [US1] `apps/backend/src/shares/service.ts`: `listShares`, `grantShare` (transação, `SELECT ... FOR SHARE` na reunião, valida dono, alvo ativo e `meetings.manage` para `edit`, `INSERT ... ON CONFLICT DO NOTHING`, retorno `ShareEntry`)
- [X] T014 [US1] `apps/backend/src/shares/routes.ts`: `GET` e `POST /meetings/:id/shares` com `parseBody`, auditoria `meeting_share_granted` e `publishToUser(meeting_access granted)` depois do commit; registrar em `apps/backend/src/modules.ts`
- [X] T015 [P] [US1] `apps/backend/src/users/lookup.ts` (função pura de escape + consulta) e rota `GET /users/lookup` com `requirePermission("meetings.manage")` e `rateLimit` por usuário (30/min)
- [X] T016 [P] [US1] Frontend: tipos e chamadas em `apps/frontend/src/api.ts`; hook `useUserLookup` com debounce de 300 ms em `hooks.ts`
- [X] T017 [US1] `apps/frontend/src/components/ShareDialog.tsx`: busca (`role="listbox"`), seletor de nível, aviso do que o destinatário verá, lista simples dos acessos atuais, estados de carregamento e erro
- [X] T018 [US1] Botão **Compartilhar** em `apps/frontend/src/pages/Reuniao.tsx` (só `access === "owner"` e `meetings.manage`) e estilos em `styles.css`

**Checkpoint**: US1 funciona e é testável sozinha.

---

## Phase 4: User Story 2 - Alterar, revogar e refletir ao vivo (Priority: P1) — MVP parte 2

**Goal**: o dono troca o nível e remove o acesso, e o efeito é imediato.

**Independent Test**: Bia com a reunião aberta e WS inscrito; a Ana revoga; em até 2 s nenhum evento chega e a próxima requisição devolve 404.

### Tests

- [X] T019 [P] [US2] Teste db: `PUT` (troca de nível, `seen_at` zerado ao subir, 404 se o alvo não tem acesso, mesmos 422) e `DELETE` (204, 404, auditoria); acesso some na requisição seguinte
- [X] T020 [P] [US2] Teste de WebSocket com hub real: após revoke, nenhum `segments`/`items` chega em até 2 s mesmo sem esperar o `sweep`; `changed` mantém a inscrição; `granted` chega em todas as abas do alvo; `meeting` difundido não carrega campos por espectador

### Implementation

- [X] T021 [US2] `changeShare` e `revokeShare` em `shares/service.ts`; rotas `PUT` e `DELETE /meetings/:id/shares/:userId` com auditoria `changed` e `revoked`
- [X] T022 [US2] Ordem do revoke e do change (pesquisa D11): commit, `invalidateAudience`, `revokeUser`, `publishToUser`, em `shares/routes.ts` usando o helper do T010
- [X] T023 [P] [US2] Em `ShareDialog.tsx`: lista "Quem tem acesso" com troca de nível, remoção com confirmação, selos Desativado, "ainda não abriu" e "só leitura efetiva"
- [X] T024 [US2] Frontend ao vivo: tratar `meeting_access` em `live.ts`/`useLive`; em `Reuniao.tsx` atualizar `access` sem recarregar e, ao revogar, mostrar "Seu acesso a esta reunião foi removido" e voltar para a lista (sem perder rascunho: o erro 403 aparece no formulário)
- [X] T025 [US2] `DELETE /meetings/:id` (`apps/backend/src/routes.ts`): capturar `meetingAudience` antes de apagar e publicar `meeting_access` com `change: "deleted"` aos destinatários

**Checkpoint**: US1 e US2 completas = núcleo do compartilhamento.

---

## Phase 5: User Story 3 - "Compartilhadas comigo" e selos (Priority: P1)

**Goal**: o destinatário acha, reconhece e abandona reuniões compartilhadas; "Nova" até abrir.

**Independent Test**: após o grant, Bia vê a reunião em "Compartilhadas comigo" com selo; abre e a marca some; "Minhas" não a lista.

### Tests

- [X] T026 [P] [US3] Teste db: `scope=all|mine|shared|shared_by_me` (inválido = 400), projeção por espectador (`access`, `ownerName`, `shareCount` só do dono, `shareUnseen`) em `GET /meetings` e `/agenda`; combinação com `projectId`, `status` e `before`
- [X] T027 [P] [US3] Teste db: `POST /shared-with-me/:id/seen` e `DELETE /shared-with-me/:id` (só a própria linha; dono e sem linha = 404; auditoria `left`; `meeting_access` nulo só ao próprio)

### Implementation

- [X] T028 [US3] `GET /meetings` com `scope` (validação) e `getAgenda` (`apps/backend/src/calendar/service.ts`) devolvendo `MeetingListItem`
- [X] T029 [US3] Rotas `/shared-with-me/:meetingId/seen` e `DELETE` em `shares/routes.ts` e `markSeen`/`leaveShare` em `shares/service.ts`
- [X] T030 [P] [US3] `MeetingDetail.ownerName` em `loadMeetingDetail` (`apps/backend/src/routes.ts`)
- [X] T031 [P] [US3] `apps/frontend/src/components/ShareBadge.tsx` (ícone e texto; nunca só cor) com os textos da spec
- [X] T032 [US3] `apps/frontend/src/pages/Reunioes.tsx`: abas de escopo sincronizadas com a URL, contador de "Nova", selo por linha e mesclagem do evento `meeting` preservando os campos por espectador
- [X] T033 [P] [US3] Selo em `pages/Hoje.tsx` e `components/AgendaItem.tsx`
- [X] T034 [US3] `Reuniao.tsx`: "Compartilhada por <nome>", **Sair desta reunião** (Dialog de confirmação) e `POST seen` ao abrir
- [X] T035 [US3] Toast do `granted` ("<nome> compartilhou «<título>» com você (<nível>)") e inserção ao vivo na lista

**Checkpoint**: fluxo completo ponta a ponta para dois usuários.

---

## Phase 6: User Story 4 - Série recorrente (Priority: P2)

**Goal**: compartilhar, alterar e revogar "esta e as próximas", sem expor o passado.

**Independent Test**: série com 2 passadas e 3 futuras; "esta e as próximas" cria 3 linhas; revogar "só esta" remove 1.

- [X] T036 [P] [US4] Teste db: `following` em série manual (`series_id`) e `.ics` (`created_by` + `ical_uid`), passadas fora do lote, ocorrência criada depois não herda, atomicidade (falha no meio não grava nada), idempotência, 422 sem série; `GET shares` devolve `series.following`
- [X] T037 [US4] `seriesOccurrences(ref)` em `shares/service.ts` (SQL de `data-model.md`)
- [X] T038 [US4] `scope` em `grant`, `change` e `revoke` com `affected`, uma auditoria por chamada
- [X] T039 [US4] `ShareDialog.tsx`: seletor de alcance quando há série, contagem "Vale para N ocorrências" e aviso de que as futuras criadas depois não herdam

**Checkpoint**: série funcionando sem alterar o resultado de US1 a US3.

---

## Phase 7: User Story 5 - Isolamento, papéis e desativados (Priority: P1, regressão)

**Goal**: provar que nada abre porta.

- [X] T040 [P] [US5] Matriz papel x nível x rota (pelo menos 40 combinações: dono, `edit`, `read`, admin, super, viewer, desativado, sem relação) para todas as rotas de `OWNER_ONLY_ROUTES` e as novas, incluindo maiúsculas, `//` e codificação
- [X] T041 [P] [US5] Admin e super sem acesso: 404 nas rotas de share, nenhuma rota `/admin/*` lista shares, `audit_log` sem título; admin dono compartilha normalmente
- [X] T042 [P] [US5] Desativado: fora da busca, 422 no grant, aparece "Desativado" ao dono, perde sessão e WS, reativação restaura o acesso
- [X] T043 [US5] `apps/backend/src/llm/usage.ts` limitado a `m.created_by = $usuario` (FR-015) e ajuste de `test/llm-usage.test.ts` e do teste db correspondente
- [X] T044 [P] [US5] Teste: nenhum evento difundido (`meeting`, `items`, `adrs`) carrega `access`, `shareCount` ou `shareUnseen`

---

## Phase 8: Polish e entrega

- [ ] T045 E2E Playwright (`apps/backend/e2e/`, desktop e celular): Ana compartilha, Bia vê e abre, Ana revoga e a tela da Bia reage ao vivo. **Escrito e verde (desktop e celular), mas fora do repositório**: o hook `e2e-location-guard` do plugin Montreal bloqueia gravar E2E em `apps/backend/e2e/`; o cenário foi acrescentado a uma cópia de `plataforma.spec.ts` e fica à espera da decisão do dono de onde versioná-lo
- [X] T046 [P] Documentação: `README.md`, `README.en.md`, `README.es.md` (recurso e permissões), `CHANGELOG.md`, `docs/ARCHITECTURE.md` (seção de isolamento), `docs/analise/plataforma-multiusuario.md` §13 (tela de compartilhamento feita; revogação ao vivo)
- [X] T047 [P] Checklist do Sonar nos arquivos alterados: complexidade cognitiva até 15, sem regex com backtracking sobre entrada, sem `console.log`, sem catch vazio, sem literal repetido 3 vezes ou mais, `Object.hasOwn`, sem segredo ou IP fixo
- [X] T048 Rodar `npm run typecheck`, `npm test`, `npm run test:db -w @meeting-bot/backend`, build e `npm run test:e2e -w @meeting-bot/backend`; validar `quickstart.md` no navegador (desktop e celular)
- [X] T049 Reavaliar o Constitution Check do `plan.md` e marcar os itens de `checklists/requirements.md`; commit em português, sem assinatura de ferramenta

---

## Dependencies & Execution Order

- **Fase 1** sem dependências; T001 antes de T002 e T003 (mesmo pacote), demais [P].
- **Fase 2** depende da Fase 1; T008 depende de T007 (teste primeiro); T009 e T010 independentes entre si.
- **US1** depende da Fase 2; T013 antes de T014; T015 e T016 paralelos; T017 depende de T016; T018 depende de T017.
- **US2** depende de US1 (T013, T014); T022 depende de T010 e T021; T024 depende de T002 e T010.
- **US3** depende da Fase 2 (T009) e de T014 para o `granted`; pode andar em paralelo com US2 após US1.
- **US4** depende de T013 e T021 (estende o serviço); **US5** pode começar quando US1 e US2 existirem (T040 a T042
  são testes de regressão; T043 é independente).
- **Fase 8** por último; T046 e T047 podem andar durante as histórias.

## Parallel Example

```bash
# Depois de T014: testes e UI andam juntos
T015  # lookup (backend)
T016  # tipos e hook (frontend)
T019 + T020  # testes de US2 em arquivos separados
```

## Implementation Strategy

1. Fases 1 e 2, depois **US1 + US2 + US3** = MVP utilizável (compartilhar, alterar, revogar ao vivo, achar).
2. US5 em paralelo como rede de segurança antes de qualquer merge.
3. US4 (série) depois, isolada atrás do seletor de alcance (padrão `occurrence`).
4. Nenhum deploy sem backend ocioso; migração real só com confirmação do usuário.

## Resumo de contagem

| Fase | Tarefas | Quantidade |
|---|---|---|
| 1 Setup | T001 a T006 | 6 |
| 2 Foundational | T007 a T010 | 4 |
| 3 US1 | T011 a T018 | 8 |
| 4 US2 | T019 a T025 | 7 |
| 5 US3 | T026 a T035 | 10 |
| 6 US4 | T036 a T039 | 4 |
| 7 US5 | T040 a T044 | 5 |
| 8 Polish | T045 a T049 | 5 |
| **Total** | | **49** |
