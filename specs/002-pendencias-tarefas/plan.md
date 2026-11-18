# Implementation Plan: Minhas pendências e tarefas

**Branch**: `feat/002-pendencias-tarefas` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-pendencias-tarefas/spec.md`

## Summary

Itens aprovados da reunião (em especial `pendencia`) e o cadastro manual passam a existir como **tarefas pessoais**,
com status, prioridade, prazo, projeto e responsável, numa tela **Minhas pendências** com filtros. O trabalho é, em
essência, um módulo CRUD com isolamento estrito por dono, mais um ponto de entrada a partir da revisão de itens.

Abordagem:

1. **Banco:** duas tabelas aditivas em `schema.ts` (`tasks`, `task_history`). A unicidade `(source_item_id,
   owner_id)` garante uma tarefa por item e por pessoa, inclusive sob concorrência e reprocessamento.
2. **Backend:** módulo `apps/backend/src/tasks/` registrado em `modules.ts` (mesmo padrão de `projects/routes.ts`),
   com serviço, consulta com filtros, funções puras (título, prazo, "responsável sou eu"), criação a partir de item e
   rotas REST. A aprovação de `pendencia` (`POST /items/:itemId/approve`) chama a criação depois do commit.
3. **Contratos:** `packages/contracts/src/tasks.ts` (zod) e duas permissões novas (`tasks.read`, `tasks.manage`).
4. **Frontend:** página `Pendencias`, componentes de tarefa, ação **Virar tarefa** e chip no `ItemCard`, seção na
   página da reunião e cartão na tela Hoje.
5. **Sem IA nova, sem rede nova, sem tempo real:** nada de LLM, ASR ou egress; a tela atualiza por refetch.

Documentos (`documents`) e `generation_jobs` ficam fora (research R1). O gancho do Azure DevOps é só o campo
`external_ref` (contrato em `contracts/azure-devops-hook.md`).

Questões em aberto Q1–Q4 (spec): o plano segue a recomendação de cada uma e isola o que depende delas; cada tarefa
afetada em `tasks.md` leva a marca `[Q1]`…`[Q4]`.

## Technical Context

**Language/Version**:
- Backend: Node 24 + TypeScript 5.9 (ES2022, CommonJS).
- Frontend: React 19 + Vite + TypeScript.
- Contratos: `packages/contracts` (zod 4).

**Primary Dependencies**: nenhuma nova. Express 5, `pg`, `zod`, `react-router`, `lucide-react` já presentes.

**Storage**: Postgres 16; `tasks` e `task_history` em `apps/backend/src/schema.ts` (idempotente, aditivo).

**Testing**:
- Vitest unitário para as funções puras (`deriveTitle`, `parseDueText`, `isSelfOwner`, montagem de filtros) e contratos.
- `npm run test:db -w @meeting-bot/backend` (Postgres descartável) para repositório, autorização, idempotência e
  migração (inclui `zz-migracao-legado`).
- E2E Playwright (`npm run test:e2e`, desktop + celular) para o fluxo aprovar → tarefa → filtrar → concluir.
- Verificação manual no navegador real (a UI nova é parte do aceite).

**Target Platform**: o mesmo do MVP (Docker Engine nativo, UI em `127.0.0.1`; VPS de teste opcional sem mudanças).

**Project Type**: aplicação web (backend + frontend) em monorepo npm workspaces.

**Performance Goals**:
- Lista filtrada com 500 tarefas em < 1 s (índices por `owner_id`).
- Tarefa visível em ≤ 2 s após aprovar.

**Constraints**:
- `LOCAL_ONLY`: nenhuma chamada de LLM, ASR ou serviço externo; nenhuma regra de egress nova.
- Tarefa pessoal: 404 para qualquer não dono, inclusive administradores.
- Migração apenas aditiva; nada retroativo.
- README nos 3 idiomas ao entregar.

**Scale/Scope**: 1–2 usuários, centenas de tarefas por dono; 1 tela nova, 1 diálogo, 1 cartão, ajustes em 2 telas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| I. Local-first | Nada sai da máquina; sem IA; sem egress novo. Tarefa e instantâneo ficam no Postgres do dono. O gancho do Azure DevOps é só um campo nulo, sem rede (FR-016, FR-028). | OK |
| II. Políticas da org. | Sem scraping, sem Graph. A integração corporativa futura está condicionada ao aval da TI (`contracts/azure-devops-hook.md`). | OK |
| III. Humano no controle | Tarefa só nasce de item **aprovado** por humano ou de cadastro manual; a IA nunca cria tarefa. A interface distingue "da reunião (aprovada)" de "manual" e mostra "Responsável não confirmado". | OK |
| IV. Rastreabilidade | Tarefa guarda item de origem, reunião e instantâneo com a primeira citação (tempo e canal); `task_history` registra valor anterior, novo, autor e data. | OK |
| V. GPU | Não usa GPU. | OK |
| VI. Desktop nativo | Sem mudança no host-agent. Lembretes por alerta nativo ficam fora de escopo. | OK |
| VII. Incremental e verificável | Critério de aceite por história, testes unitários, de banco e E2E; validação manual no navegador e com reunião real antes de declarar pronto. Questões que dependem do usuário estão perguntadas (Q1–Q4), não decididas. | OK |
| VIII. Stack | Node/TS, Postgres, React, zod em `packages/contracts`. Sem dependência nova. | OK |
| Regras operacionais → Acesso | RBAC por permissão nova, isolamento por dono, administrador sem leitura de conteúdo alheio, `meeting_shares` respeitado na criação a partir de item. | OK |

Reavaliação pós-design (Phase 1): sem violações. O contrato de API não cria nenhuma rota de leitura entre usuários, o
modelo não cria tabela de visibilidade cruzada e a única leitura de dados da reunião passa por `meetingAccess`.

Sem emenda à constituição (research R19).

## Project Structure

### Documentation (this feature)

```text
specs/002-pendencias-tarefas/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md             # rotas e tipos de tarefas
│   ├── ui.md                   # telas, rotas do frontend, estados
│   └── azure-devops-hook.md    # gancho (não implementado)
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/contracts/src/
├── tasks.ts                    # NOVO: enums, rótulos, TaskInput/Patch/Query/Task/Counts/History, TaskFromItemInput
├── platform.ts                 # + tasks.read, tasks.manage em PERMISSIONS
└── index.ts                    # + export * from "./tasks"

apps/backend/src/
├── schema.ts                   # + tasks, task_history, índices
├── modules.ts                  # + import "./tasks/routes"
├── authz/matrix.ts             # + tasks.* em OWN_CONTENT
├── items/routes.ts             # approve: chama createFromApproval e estende a resposta
└── tasks/                      # NOVO
    ├── derive.ts               # deriveTitle, parseDueText (puras)
    ├── identity.ts             # isSelfOwner (pura)
    ├── query.ts                # TaskQuery → SQL parametrizado + contadores (puro/testável)
    ├── service.ts              # CRUD, histórico, status, escopo por dono
    ├── fromItem.ts             # criar de item (acesso, elegibilidade, dedupe, ON CONFLICT, instantâneo)
    ├── serialize.ts            # linha → Task (acesso atual à reunião em lote)
    └── routes.ts               # /tasks*, /meetings/:id/tasks, /tasks/summary

apps/backend/test/
├── tasks-derive.test.ts        # NOVO (unit)
├── tasks-identity.test.ts      # NOVO (unit)
├── tasks-query.test.ts         # NOVO (unit)
├── contracts-schemas.test.ts   # + schemas de tarefas
├── tasks-scope.test.ts         # NOVO (estático: toda consulta escopada por owner_id)
└── db/tarefas-*.test.ts        # NOVO (Postgres: base, origem, lista, edicao, acesso, resumo)
apps/backend/e2e/tarefas-*.spec.ts  # NOVO (Playwright por história)

apps/frontend/src/
├── App.tsx                     # + rota /pendencias
├── components/shell/nav.ts     # + "Minhas pendências" (permission tasks.read)
├── tasks.ts                    # NOVO: cliente da API e hook de lista com filtros na URL
├── pages/Pendencias.tsx        # NOVO
├── pages/Hoje.tsx              # + cartão (P3)
├── pages/Reuniao.tsx           # + mapa item→tarefa e seção "Tarefas desta reunião"
├── components/ItemCard.tsx     # + Virar tarefa / chip Tarefa criada
├── components/tasks/           # NOVO
│   ├── TaskFilters.tsx
│   ├── TaskList.tsx
│   ├── TaskDialog.tsx
│   ├── TaskStatusSelect.tsx
│   ├── TaskHistory.tsx
│   ├── TaskBadges.tsx          # prioridade, atrasada, origem, "Responsável não confirmado"
│   └── TasksSummaryCard.tsx    # P3
└── styles.css                  # + estilos da lista, filtros e cartões
```

**Structure Decision**: o módulo `tasks/` segue o padrão de `projects/` e `items/` (serviço + rotas registradas em
`features.authedRouters`), sem novo serviço, container ou dependência. As funções puras ficam separadas para teste
unitário sem banco, como `agent/dedup.ts` e `calendar/ics.ts`.

## Fases e riscos

| Fase | Entrega | Depende de |
|---|---|---|
| Fundação | contratos, permissões, schema, funções puras, serviço, rotas CRUD e testes de acesso | — |
| US1 | criar de item (aprovar e **Virar tarefa**), idempotência, reprocessamento, mapa na reunião | Fundação |
| US2 | tela Minhas pendências, filtros, contadores, status na lista | Fundação (US1 alimenta com dados) |
| US3 | tarefa manual, edição completa, histórico, exclusão | Fundação |
| US4 | compartilhamento e isolamento cruzado, revogação, exclusão de reunião, VIEWER | US1 |
| US5 | cartão em Hoje e "pendências a revisar" | US2 |
| Polimento | documentação nos 3 idiomas, Sonar, regressão, validação manual | todas |

| Risco | Mitigação |
|---|---|
| Vazamento de tarefa entre usuários | Toda consulta passa por `owner_id` no serviço (uma função de escopo); testes de acesso cruzado em `db/tarefas-acesso.test.ts` (outro USER, ADMIN, SUPER_ADMIN, VIEWER, dono da reunião, `meetings.read_all`); `taskParamGuard` devolve 404 antes do handler. |
| Duplicação por reprocessamento ou clique duplo | Índice único parcial + `ON CONFLICT` + Jaccard; teste de 10 reprocessamentos (SC-002). |
| Falso positivo de "responsável sou eu" | Regra conservadora (research R5); o custo do erro é um clique. |
| Migração quebrar o boot | Só `CREATE ... IF NOT EXISTS`; teste de migração sobre cópia do banco real; aplicar só com backend ocioso e confirmação. |
| Respostas das questões Q1–Q4 mudarem o desenho | Dependências isoladas: gatilho de aprovação (um handler), elegibilidade (uma função), serializador (um arquivo), modelo de pessoal (uma coluna a mais se Q3 mudar). |

## Complexity Tracking

Sem violações da constituição a justificar.
