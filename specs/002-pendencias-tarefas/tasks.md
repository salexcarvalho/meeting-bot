---
description: "Tarefas de Minhas pendências e tarefas"
---

# Tasks: Minhas pendências e tarefas

**Input**: documentos de design em `specs/002-pendencias-tarefas/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: a Constituição (princípio VII) exige teste automatizado quando viável. Há tarefas de teste para as funções
puras (Vitest), para o banco (Postgres descartável) e para o fluxo no navegador (Playwright), escritas **antes** da
implementação correspondente.

**Organization**: tarefas agrupadas por user story (US1–US5 da spec).

**Questões em aberto**: as marcas `[Q1]`…`[Q4]` apontam tarefas cujo comportamento depende de uma questão do
`spec.md`. A implementação segue a **recomendação** de cada uma; se o usuário responder outra opção, ajustar só as
tarefas marcadas (impacto em `data-model.md`, "Impacto das alternativas"). Não iniciar essas tarefas sem confirmar que
a recomendação continua valendo.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1…US5
- **[Qn]**: depende da questão n em aberto

## Path Conventions

Monorepo, conforme o plan.md:
- `apps/backend/src/tasks/`, `apps/backend/test/`, `apps/backend/e2e/`
- `apps/frontend/src/`
- `packages/contracts/src/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: criar os esqueletos dos três pacotes que a feature toca.

- [ ] T001 Criar `packages/contracts/src/tasks.ts` com as constantes `TASK_STATUSES` (`a_fazer`, `em_andamento`, `bloqueada`, `concluida`, `cancelada`), `OPEN_STATUSES`, `TASK_PRIORITIES` (`baixa`, `media`, `alta`, `urgente`), `ASSIGNEE_KINDS`, `TASK_ORIGINS` e os rótulos em português; exportar em `packages/contracts/src/index.ts`
- [ ] T002 [P] Criar o esqueleto `apps/backend/src/tasks/` (`derive.ts`, `identity.ts`, `query.ts`, `service.ts`, `fromItem.ts`, `serialize.ts`, `routes.ts`) com exports tipados vazios e registrar `import "./tasks/routes"` em `apps/backend/src/modules.ts`
- [ ] T003 [P] Criar o esqueleto do frontend: `apps/frontend/src/tasks.ts`, `apps/frontend/src/pages/Pendencias.tsx` (placeholder), pasta `apps/frontend/src/components/tasks/`, rota `/pendencias` em `apps/frontend/src/App.tsx` (redireciona para `/` sem `tasks.read`) e item "Minhas pendências" (ícone `ListChecks`, `permission: "tasks.read"`) no grupo "Pessoal" de `apps/frontend/src/components/shell/nav.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: contratos, permissões, tabelas e CRUD com isolamento por dono. Nenhuma user story começa antes.

**CRITICAL**: o escopo por dono (`owner_id`) é a regra de segurança central; nenhuma consulta de tarefa pode existir
fora dele.

- [ ] T004 Completar `packages/contracts/src/tasks.ts` com os schemas zod estritos (`.strict()`): `TaskInput`, `TaskPatch` (≥ 1 campo; `dueHint` só aceita `null`), `TaskQuery` (coerção de query string, `limit` 1–200, `due=range` exige `dueFrom`/`dueTo`), `TaskSourceSnapshot`, `Task`, `TaskCounts`, `TaskHistoryEntry`, `TaskFromItemInput`, `TaskRef`, `TaskNotice`, conforme `contracts/rest-api.md`; `externalRef`, `origin`, `source`, `completedAt` e `overdue` nunca aceitam escrita
- [ ] T005 [P] Estender `apps/backend/test/contracts-schemas.test.ts` com casos de tarefas: título curto ou longo, status e prioridade inválidos, `assignee.kind = "other"` sem nome, `externalRef` no corpo recusado, `due=range` incompleto, `limit` fora da faixa
- [ ] T006 Adicionar `tasks.read` e `tasks.manage` a `PERMISSIONS` em `packages/contracts/src/platform.ts` e a `OWN_CONTENT` em `apps/backend/src/authz/matrix.ts` (VIEWER sem as duas); atualizar `apps/backend/test/platform-units.test.ts` com a matriz esperada por papel
- [ ] T007 Adicionar `tasks` e `task_history` a `apps/backend/src/schema.ts` conforme `data-model.md` (colunas, `CHECK` de status, prioridade, `assignee_kind`, origem, `concluida` com `completed_at`; chaves estrangeiras com `ON DELETE SET NULL` para projeto, reunião e item; `UNIQUE (source_item_id, owner_id) WHERE source_item_id IS NOT NULL`; índices `(owner_id, status, due_date)`, `(owner_id, project_id)`, `(owner_id, meeting_id)`, `(owner_id, updated_at DESC)`), tudo com `IF NOT EXISTS` [Q3]
- [ ] T008 Implementar em `apps/backend/src/tasks/service.ts` o escopo por dono (toda consulta recebe `ownerId` e filtra por ele) e o CRUD básico: `createManualTask`, `getTask`, `patchTask` (histórico `edited` com `before`/`after` só dos campos alterados, no-op sem histórico), `setStatus` (histórico `status_changed`, `completed_at` ao entrar e sair de `concluida`), `deleteTask`, `getHistory` [Q3]
- [ ] T009 [P] Implementar `apps/backend/src/tasks/serialize.ts`: linha do banco → `Task` (`overdue` no fuso do usuário, `assignee`, `externalRef` somente leitura), resolvendo em **uma consulta em lote** (`visibleMeetingsSql`) quais reuniões o usuário ainda vê: sem acesso, `meeting` e `sourceItem` saem nulos e fica só o instantâneo `source` [Q4]
- [ ] T010 Implementar as rotas CRUD em `apps/backend/src/tasks/routes.ts` (`POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `POST /tasks/:id/status`, `DELETE /tasks/:id`, `GET /tasks/:id/history`) com `requirePermission("tasks.read"|"tasks.manage")`, `parseBody` e um `taskParamGuard` (`router.param("id")`) que responde 404 a id inválido, inexistente ou de outro dono, por padrão de rota, antes do handler
- [ ] T011 Criar `apps/backend/test/db/tarefas-base.test.ts` (Postgres descartável) com a base: migração idempotente (rodar `migrate` duas vezes), CRUD, histórico, `completed_at` ao concluir e reabrir, `externalRef` recusado em POST/PATCH e acesso cruzado (outro USER, ADMIN, SUPER_ADMIN e VIEWER recebem 404 ou 403 em todas as rotas de `:id`)

**Checkpoint**: tarefas manuais básicas funcionam por API com isolamento comprovado.

---

## Phase 3: User Story 1 - Aprovar uma pendência e ela virar tarefa (Priority: P1) 🎯 MVP

**Goal**: aprovar uma pendência cria a tarefa (sem duplicar) e qualquer item aprovado pode virar tarefa por ação
explícita, com a origem rastreável.

**Independent Test**: aprovar uma pendência com prazo "30/11" cria 1 tarefa com prazo 30/11; "Gerar ata" de novo
mantém 1 tarefa; um risco aprovado vira tarefa por **Virar tarefa**; item proposto é recusado.

### Tests for User Story 1

- [ ] T012 [P] [US1] Criar `apps/backend/test/tasks-derive.test.ts`: `deriveTitle` (frase curta, vários pontos, 300 caracteres cortados em palavra com `…`, texto de uma palavra, quebra de linha) e `parseDueText` (`30/11`, `30/11/2026`, `2026-11-30`, "até 5/12", "hoje", "amanhã", ano seguinte quando `dd/mm` cai antes da reunião, "sexta-feira", "semana que vem", "fim do mês" → só `hint`, entrada vazia)
- [ ] T013 [P] [US1] Criar `apps/backend/test/tasks-identity.test.ts`: `isSelfOwner` (eu, "eu mesmo", usuário, nome de exibição, e-mail, primeiro nome com 3+ letras; rejeita "João", "Sérgio Lima" quando o usuário é "Sérgio Alexandre", token de 2 letras, texto vazio)
- [ ] T014 [P] [US1] Criar `apps/backend/test/db/tarefas-origem.test.ts` com os casos de criação a partir de item: aprovado cria com título, descrição, prazo, projeto e instantâneo (com a citação); `proposto` e `rejeitado` dão 409 `item_not_approved`; criar duas vezes e em corrida (`Promise.all`) gera 1 tarefa; reabrir e aprovar mantém a mesma; excluir a tarefa e aprovar de novo cria outra; tarefa parecida (Jaccard) devolve `possible_duplicate` e `force` cria; 10 chamadas a `clearUnreviewedAiItems` + nova extração deixam o número de tarefas igual (SC-002); excluir a reunião deixa `meeting_id` e `source_item_id` nulos com o instantâneo

### Implementation for User Story 1

- [ ] T015 [P] [US1] Implementar `deriveTitle` e `parseDueText` em `apps/backend/src/tasks/derive.ts` (puras, sem regex com backtracking sobre entrada livre; fuso recebido por parâmetro)
- [ ] T016 [P] [US1] Implementar `isSelfOwner` em `apps/backend/src/tasks/identity.ts` (normalização sem acento, tokens, regra conservadora de `research.md` R5) [Q2]
- [ ] T017 [US1] Implementar `createFromItem` em `apps/backend/src/tasks/fromItem.ts`: exige item aprovado, acesso de leitura (`meetingAccess` + `meetings.read` + `tasks.manage`), devolve a tarefa existente do par `(item, dono)`, detecta tarefa parecida na mesma reunião com `normalizeTokens`/`jaccard` de `apps/backend/src/agent/dedup.ts`, insere com `ON CONFLICT (source_item_id, owner_id) WHERE source_item_id IS NOT NULL DO NOTHING RETURNING` (relendo se nada voltou), grava o instantâneo (primeira linha de `item_evidence`) e o histórico `created` com `origin = item_manual`
- [ ] T018 [US1] Implementar `createFromApproval` em `apps/backend/src/tasks/fromItem.ts`: só para item `pendencia`, só com `tasks.manage`, só quando o responsável é o aprovador (`isSelfOwner`) ou vazio, `origin = item_auto`; devolve `{ task, notice }` com `possible_duplicate` ou `assignee_other` quando não cria [Q1][Q2]
- [ ] T019 [US1] Adicionar `POST /tasks/from-item` em `apps/backend/src/tasks/routes.ts` com os códigos `item_not_approved`, `possible_duplicate` (corpo com `taskId`) e 404 sem acesso; `201` ao criar e `200` ao devolver a existente
- [ ] T020 [US1] Em `apps/backend/src/items/routes.ts`, no `POST /items/:itemId/approve`, chamar `createFromApproval` depois do commit de `reviewItem`, capturar e registrar qualquer erro (a aprovação nunca falha por causa da tarefa) e estender a resposta com `task` e `taskNotice`; adicionar `ItemReviewResult` em `packages/contracts/src/tasks.ts` [Q1]
- [ ] T021 [US1] Adicionar a `apps/backend/test/db/tarefas-origem.test.ts` os casos da rota de aprovação: pendência do próprio usuário e sem responsável cria `task`; pendência de "João" devolve `taskNotice.assignee_other` e não cria; item de outro tipo aprovado não cria sozinho; usuário sem `tasks.manage` recebe a resposta de hoje; aprovar duas vezes devolve 409 do item e nenhuma tarefa extra [Q1][Q2]
- [ ] T022 [US1] Adicionar `GET /meetings/:id/tasks` em `apps/backend/src/tasks/routes.ts`: só tarefas do usuário ligadas à reunião, com a guarda de leitura da reunião (`checkMeeting` modo `read`) e `tasks.read`

### Frontend for User Story 1

- [ ] T023 [P] [US1] Em `apps/frontend/src/tasks.ts`, adicionar `fetchMeetingTasks(meetingId)` e `createTaskFromItem(input)` com tratamento dos 409 (`possible_duplicate` pede confirmação e reenvia com `force`)
- [ ] T024 [US1] Criar `apps/frontend/src/components/tasks/TaskFromItemDialog.tsx` (título, prazo, prioridade, responsável já derivados e editáveis; aviso de "tarefa parecida") e ligar em `apps/frontend/src/components/ItemCard.tsx`: botão **Virar tarefa** em item aprovado e chip "Tarefa criada · status" com link para `/pendencias?tarefa=<id>`
- [ ] T025 [US1] Em `apps/frontend/src/pages/Reuniao.tsx`, carregar `/meetings/:id/tasks`, indexar por `sourceItem.id`, atualizar após cada ação, mostrar os toasts da aprovação (tarefa criada com **Abrir**, "Já existe uma tarefa parecida", "Esta pendência é de <nome>") e a seção "Tarefas desta reunião" [Q1][Q2]
- [ ] T026 [US1] Criar `apps/backend/e2e/tarefas-origem.spec.ts` (Playwright, desktop e celular) com aprovar pendência → tarefa → "Gerar ata" de novo → continua 1, e **Virar tarefa** num risco (S1, S4, S5, S6 do quickstart)

**Checkpoint**: aprovar vira tarefa, sem duplicar; testável só com a API e a página da reunião.

---

## Phase 4: User Story 2 - Tela "Minhas pendências" com filtros (Priority: P1)

**Goal**: tela única com contadores e filtros por status, projeto, prazo e responsável, edição do status na lista.

**Independent Test**: com 8 tarefas variadas, filtrar Atrasadas + projeto mostra só as que batem; a URL guarda o
filtro; concluir uma tarefa a tira de "Abertas" e atualiza os contadores.

### Tests for User Story 2

- [ ] T027 [P] [US2] Criar `apps/backend/test/tasks-query.test.ts`: `buildTaskQuery` gera SQL parametrizado (nada concatenado), `status=open` e `all`, `projectId=none`, `due` (`overdue`, `today`, `week`, `month`, `none`, `range`), `assignee` (`me`, `none`, `other` + `assigneeName`), `q` sem acento e sem maiúsculas, ordenações, limites; valor inválido lança erro de filtro
- [ ] T028 [P] [US2] Criar `apps/backend/test/db/tarefas-lista.test.ts` com os casos de lista e contadores: filtros combinados, ordenação por prazo com "sem prazo" no fim, paginação e `total`, `counts` independentes do filtro, "hoje" e "atrasada" no fuso `America/Sao_Paulo` perto da meia-noite UTC, busca com acento, 500 tarefas respondendo abaixo de 1 s (SC-007)

### Implementation for User Story 2

- [ ] T029 [US2] Implementar `buildTaskQuery` em `apps/backend/src/tasks/query.ts` (`TaskQuery` → `{ text, values }` sempre com `owner_id = $1`; busca normalizada com `translate(lower(...))`, sem extensão; ordenação e limites validados por lista fechada)
- [ ] T030 [US2] Implementar `listTasks` e `taskCounts` em `apps/backend/src/tasks/service.ts` e `GET /tasks` em `apps/backend/src/tasks/routes.ts` devolvendo `{ tasks, total, counts }`, com `400 {"error":"Filtro inválido: <parâmetro>."}` e fuso do usuário (`users.timezone` ou `APP_TIMEZONE`)
- [ ] T031 [P] [US2] Em `apps/frontend/src/tasks.ts`, criar `fetchTasks(query)` e o hook `useTaskFilters` que converte `useSearchParams` ↔ `TaskQuery` (parâmetros `status`, `projeto`, `prazo`, `resp`, `nome`, `prioridade`, `reuniao`, `q`, `ordem`), ignorando valores fora do conjunto
- [ ] T032 [P] [US2] Criar `apps/frontend/src/components/tasks/TaskFilters.tsx` (status, projeto com "sem projeto", prazo, responsável + nome, prioridade, reunião, busca, ordenação, **Limpar filtros**), com rótulos acessíveis
- [ ] T033 [P] [US2] Criar `apps/frontend/src/components/tasks/TaskBadges.tsx` (prioridade, atrasada com ícone e texto, origem "da reunião"/"manual", **Responsável não confirmado**, "dito: <prazo dito>") e `apps/frontend/src/components/tasks/TaskStatusSelect.tsx` (salva na hora, rótulo "Status da tarefa <título>", desfaz em caso de erro)
- [ ] T034 [US2] Criar `apps/frontend/src/components/tasks/TaskList.tsx`: tabela no desktop e cartões abaixo de 640 px, contadores clicáveis que aplicam filtro, estados de carregando, erro (**Tentar de novo**), vazio sem tarefas e vazio com filtros, **Carregar mais**
- [ ] T035 [US2] Montar `apps/frontend/src/pages/Pendencias.tsx` (cabeçalho, contadores, filtros, lista; refetch ao abrir, após cada ação e ao voltar o foco da janela; abre o diálogo da tarefa por `?tarefa=<id>`)
- [ ] T036 [US2] Adicionar a `apps/frontend/src/styles.css` os estilos da lista, filtros e cartões (tema claro e escuro, foco visível, alvos de toque ≥ 40 px, sem rolagem horizontal em 360 px)
- [ ] T037 [US2] Criar `apps/backend/e2e/tarefas-lista.spec.ts` com filtrar, recarregar mantendo a URL, mudar status, contadores e a lista em cartões no celular (S7, S8, S11)

**Checkpoint**: US1 e US2 entregam o fluxo principal completo (MVP).

---

## Phase 5: User Story 3 - Tarefa manual (Priority: P2)

**Goal**: criar, editar, ver histórico e excluir tarefas sem origem em item.

**Independent Test**: criar "Revisar contrato", prioridade alta, prazo sexta, projeto Portal SES; editar o prazo;
histórico mostra antes/depois; excluir.

- [ ] T038 [P] [US3] Criar `apps/backend/test/db/tarefas-edicao.test.ts` com os casos de edição: título 3–200, descrição ≤ 4000, prazo passado aceito, `assignee other` sem nome → 400, `projectId` inexistente → 404, `meetingId` sem acesso → 404, `meetingId` herda o projeto da reunião, histórico `edited` só com campos alterados, PATCH sem mudança não grava histórico, reabrir limpa `completed_at`, excluir libera o par `(item, dono)`
- [ ] T039 [US3] Em `apps/backend/src/tasks/service.ts`, completar `createManualTask`/`patchTask` com a ligação a reunião (acesso de leitura via `meetingAccess`, herança do projeto, imutável depois de criada) e a validação de projeto existente
- [ ] T040 [P] [US3] Criar `apps/frontend/src/components/tasks/TaskHistory.tsx` (linha do tempo "Prazo: 30/11 → 05/12 · autor · há 2 h", no padrão de `apps/frontend/src/components/ItemHistory.tsx`)
- [ ] T041 [US3] Criar `apps/frontend/src/components/tasks/TaskDialog.tsx` (criar e editar: título, descrição, status, prioridade, prazo + prazo dito com **Usar como prazo**, projeto, reunião só na criação, responsável; bloco **Origem** com os avisos "item reaberto/rejeitado" e "sem acesso à reunião"; **Excluir** com confirmação; erro do backend no próprio diálogo)
- [ ] T042 [US3] Ligar **Nova tarefa** em `apps/frontend/src/pages/Pendencias.tsx` e na seção "Tarefas desta reunião" de `apps/frontend/src/pages/Reuniao.tsx` (reunião pré-selecionada) e abrir o diálogo ao clicar numa tarefa
- [ ] T043 [US3] Criar `apps/backend/e2e/tarefas-edicao.spec.ts` com criar tarefa manual, editar o prazo, conferir o histórico e excluir (S9)

**Checkpoint**: a lista é fonte única, inclusive para o que não saiu de reunião.

---

## Phase 6: User Story 4 - Reunião compartilhada e isolamento (Priority: P2)

**Goal**: o destinatário de uma reunião compartilhada cria as próprias tarefas; ninguém lê tarefa alheia; perder o
acesso corta só o vínculo.

**Independent Test**: B (leitura) vira tarefa um item de A; A, ADMIN e SUPER_ADMIN recebem 404; revogar o acesso
mantém a tarefa de B sem link.

- [ ] T044 [P] [US4] Criar `apps/backend/test/db/tarefas-acesso.test.ts` com os casos de compartilhamento: B com `read` e com `edit` cria a própria tarefa; dono, ADMIN, SUPER_ADMIN e usuário com `meetings.read_all` recebem 404 em `GET /tasks/:id` e não veem a tarefa em listas, contadores nem `/tasks/summary`; VIEWER recebe 403; sem acesso à reunião `POST /tasks/from-item` dá 404; dois usuários no mesmo item geram duas tarefas; revogar `meeting_shares` mantém a tarefa com `meeting` e `sourceItem` nulos e `source` presente [Q3][Q4]
- [ ] T045 [US4] Criar `apps/backend/test/tasks-scope.test.ts`: teste estático que lê `apps/backend/src/tasks/*.ts` e falha se alguma consulta SQL sobre `tasks` ou `task_history` não passar pelo escopo por `owner_id` (guarda contra regressão de vazamento); documentar no teste a mutação que o valida [Q3]
- [ ] T046 [US4] No frontend (`apps/frontend/src/components/tasks/TaskDialog.tsx` e `TaskList.tsx`), tratar `meeting: null` com a nota "Você não tem mais acesso à reunião", esconder links de item e áudio e manter o instantâneo; garantir o redirecionamento de `/pendencias` e o item de menu ausente para VIEWER [Q4]
- [ ] T047 [US4] Criar o E2E multiusuário em `apps/backend/e2e/tarefas-acesso.spec.ts` (dois contextos de navegador): B cria tarefa de reunião compartilhada, A não a vê, revogar o acesso remove o link em B, VIEWER sem a tela (I1–I4)

**Checkpoint**: isolamento comprovado por teste para todos os papéis.

---

## Phase 7: User Story 5 - Resumo na tela Hoje e pendências a revisar (Priority: P3)

**Goal**: cartão com atrasadas, vencem hoje, abertas e propostas a revisar.

**Independent Test**: com 2 atrasadas, 1 vencendo hoje e 3 pendências propostas, o cartão mostra 2 / 1 / 3 e os links
filtram a lista.

- [ ] T048 [P] [US5] Criar `apps/backend/test/db/tarefas-resumo.test.ts` com os casos de `GET /tasks/summary`: contagens por status, atrasadas e hoje; `proposalsToReview` conta só `pendencia` `proposto` em reuniões visíveis com `extract_items = true`; nada de reunião alheia ou sem acesso
- [ ] T049 [US5] Implementar `taskSummary` em `apps/backend/src/tasks/service.ts` e `GET /tasks/summary` em `apps/backend/src/tasks/routes.ts` (declarada antes de `/tasks/:id`), usando `visibleMeetingsSql` para as propostas
- [ ] T050 [US5] Criar `apps/frontend/src/components/tasks/TasksSummaryCard.tsx` e incluí-lo em `apps/frontend/src/pages/Hoje.tsx`, oculto sem `tasks.read`, com cada número levando a `/pendencias` já filtrada e as propostas levando a `/reunioes`
- [ ] T051 [US5] Criar `apps/backend/e2e/tarefas-resumo.spec.ts` com o cartão da tela Hoje e seus links (S12)

**Checkpoint**: todas as histórias independentes e verificadas.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T052 [P] Documentar em `README.md`, `README.en.md` e `README.es.md` a seção "Minhas pendências e tarefas" (aprovar → tarefa, filtros, tarefa pessoal, instalação sem passo novo)
- [ ] T053 [P] Atualizar `CHANGELOG.md` (com a nota de implantação: backup, backend ocioso e confirmação antes de aplicar a migração no banco real) e `docs/ARCHITECTURE.md` (módulo `tasks`, permissões `tasks.*`, fluxo aprovar → tarefa, isolamento)
- [ ] T054 [P] Atualizar `docs/analise/plataforma-multiusuario.md` (§5: `tasks` entregue e `documents`/`generation_jobs` pendentes; §11: F4 parcial; §13: estado) e a linha de specs em `CLAUDE.md`
- [ ] T055 Verificar as regras do Sonar nos arquivos alterados (complexidade cognitiva ≤ 15, regex sem backtracking em `parseDueText`, `Object.hasOwn`, sem catch vazio, sem `console.log`, sem literal repetido ≥ 3x, sem segredo ou IP fixo); sem `NOSONAR`
- [ ] T056 Rodar a regressão completa (`npm run typecheck`, `npm test`, `npm run test:db -w @meeting-bot/backend` incluindo `zz-migracao-legado` sobre cópia do banco real, `npm run test:e2e`, `npm run build`) e confirmar que a migração não altera nenhuma tabela existente
- [ ] T057 Revisão de segurança de autorização: mutação manual (remover o escopo `owner_id` de uma consulta) deve fazer `apps/backend/test/db/tarefas-acesso.test.ts` e `apps/backend/test/tasks-scope.test.ts` falharem; registrar o resultado no PR
- [ ] T058 Validação manual do `quickstart.md` (S1–S12, I1–I6) no navegador com reunião real ou áudio de teste; confirmar que as questões Q1–Q4 foram respondidas (ou que a recomendação foi aceita) e reavaliar o Constitution Check antes de declarar a feature pronta

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → histórias.** A Fundação bloqueia tudo.
- **US1 (P1)** depende só da Fundação. Dentro dela: T012/T013/T014 (testes) antes de T015/T016/T017–T022; T017 antes de T018; T017 e T018 antes de T019 e T020.
- **US2 (P1)** depende só da Fundação (a lista funciona com tarefas manuais); fica melhor com US1 pronta. T027 antes de T029; T029 antes de T030; T031–T033 em paralelo; T034 depende de T031–T033; T035 depende de T034.
- **US3 (P2)** depende da Fundação; T041 usa os componentes de US2 (T033) e reaproveita o diálogo de US1 (T024) só como referência visual.
- **US4 (P2)** depende de US1 (`createFromItem`, `GET /meetings/:id/tasks`).
- **US5 (P3)** depende de US2 (filtros e rotas da lista).
- **Polish** depende de todas as histórias desejadas.
- As tarefas `[Q1]`…`[Q4]` só começam com a questão correspondente respondida ou a recomendação confirmada.

```text
Setup ─► Fundação ─┬─► US1 ──────────┬─► US4 ──┐
                   ├─► US2 ──► US5   │         ├─► Polish
                   └─► US3 ──────────┴─────────┘
```

## Parallel Examples

- **Fundação:** T005 (testes de contrato) e T009 (serialização) em paralelo depois de T004; T006 e T007 independentes.
- **US1:** T012, T013 e T014 (testes) em paralelo; depois T015 e T016 em paralelo; T021 e T023 em paralelo com a rota T019.
- **US2:** T027 e T028 (testes); depois T031, T032 e T033 (frontend) em paralelo enquanto T029/T030 (backend) andam.
- **Polish:** T052, T053 e T054 (documentação) em paralelo.

## Implementation Strategy

1. **MVP = Setup + Fundação + US1 + US2** (T001–T037): aprovar vira tarefa, e a lista com filtros existe. Validar com a
   reunião real antes de seguir.
2. **Incremento 2:** US3 (manual) e US4 (compartilhamento e isolamento) em paralelo; US4 é pré-requisito para liberar
   a feature a um segundo usuário.
3. **Incremento 3:** US5 (cartão em Hoje) e Polish.
4. Antes de T007 (schema) e de T020 (gancho da aprovação), confirmar com o usuário as questões Q1–Q4 ou registrar que a
   recomendação foi aceita. Aplicar a migração no banco real só com confirmação e com o backend ocioso.
