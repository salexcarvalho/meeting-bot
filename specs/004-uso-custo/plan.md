# Implementation Plan: Painel de Uso e Custo de IA e Auditoria Visível (F6)

**Branch**: `feat/004-uso-custo` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-uso-custo/spec.md`

## Summary

Hoje o consumo de IA é lido do `audit_log` (só chamadas externas bem-sucedidas, sem ASR, sem
usuário). A F6 passa a **registrar cada chamada de LLM e cada passe de ASR** numa tabela dedicada,
`ai_usage_logs`, a partir de dois pontos de instrumentação já centralizados: o funil
`llm/index.ts#generate` (cobre Ollama, OpenRouter e assinatura) e os três pontos de ASR (externo,
local final e ao vivo). O custo é só o que o provedor devolve na resposta (OpenRouter `usage.cost`);
local e assinatura mostram tokens e tempo.

Sobre esse registro entram: o painel do usuário (aba "Consumo de IA" reescrita, só `user_id = eu`),
o painel de admin agregado (`ai_usage.read`, sem nenhum campo de reunião), a **auditoria visível**
(aba "Segurança" do usuário e página "Auditoria" do admin, por projeção de lista permitida), novos
eventos de autenticação e a **retenção** por prazo, com incorporação única do histórico do
`audit_log`. Nada novo sai da máquina: nenhuma consulta extra ao OpenRouter.

## Technical Context

**Language/Version**: Node 24 + TypeScript 5.9 (backend, CommonJS), React 19 + Vite (frontend),
`packages/contracts` com zod 4. Sem Python novo (o worker-gpu e o host-agent não mudam).

**Primary Dependencies**: Express 5, `pg`, `zod`, `lucide-react`, react-router; **nenhuma
dependência nova** (gráfico em SVG/CSS próprio).

**Storage**: PostgreSQL 16; migração aditiva idempotente em `apps/backend/src/schema.ts`
(tabela `ai_usage_logs`; `audit_log` sem mudança de schema).

**Testing**: Vitest (unitários), `npm run test:db -w @meeting-bot/backend` (Postgres descartável),
Playwright (`npm run test:e2e`, desktop e celular); typecheck e build.

**Target Platform**: Docker Engine nativo no Ubuntu (e o servidor de teste do Dokploy, sem GPU:
ASR externo e assinatura continuam registrando; `compute_ms` fica nulo onde não mensurável).

**Project Type**: monorepo web (backend + frontend + contracts).

**Performance Goals**: painel < 1 s com 100 mil linhas; registro < 5 ms por chamada (assíncrono,
fora do caminho crítico).

**Constraints**: `LOCAL_ONLY` e egress guard intactos; sem conteúdo de reunião nos logs; admin sem
título/id/participantes de reunião alheia; sem bloqueio por orçamento (só visualizar); migração
destrutiva proibida; `.env`, compose principal, merge e deploy fora desta fase.

**Scale/Scope**: poucos usuários; centenas de linhas por dia; ~66 tarefas em 6 stories.

## Constitution Check

*GATE: passa antes da pesquisa; revalidado depois do design.*

| Princípio | Avaliação |
|---|---|
| I. Local-first e Privacidade | **Passa.** Nenhum dado novo sai da máquina e nenhuma consulta extra a provedor; o custo vem da resposta já existente. Registros só com metadados. `external_llm`/`external_asr` seguem no `audit_log` como rastro de saída, agora com `userId`. |
| II. Políticas da organização | Não se aplica (sem integração nova). |
| III. Humano no controle | **Passa.** Só leitura e visualização; nada de teto automático que bloqueie geração (decisão de 2026-09-17). |
| IV. Rastreabilidade | **Reforça.** Cada chamada e cada envio externo ficam ligados a usuário e reunião; eventos de autenticação passam a ser auditados; a poda é auditada. |
| V. Orçamento de GPU | **Passa.** Registro é assíncrono, sem uso de GPU; `compute_ms` só mede. A fila da GPU não muda. |
| VI. Desktop nativo, serviços em container | **Passa.** Tudo no backend; o host-agent não muda (usa `usage` que já devolve). |
| VII. Evolução incremental e verificável | **Passa.** Migração aditiva; stories independentes; testes unitários, de banco e E2E por story; mutação nos testes de isolamento. |
| VIII. Stack e idioma | **Passa.** Node/TS/React; textos e commits em português. |
| Regras Operacionais ("Acesso") | **Passa.** Admin gerencia contas e vê agregados, mas não lê conteúdo de terceiros. |
| Regras Operacionais ("Retenção") | **Lacuna a registrar:** hoje só o áudio tem política. Prazos de uso e auditoria (Q2) pedem emenda MINOR (T061), só com aprovação. |

**Re-check pós-design**: sem violações; a única pendência é a emenda da retenção (não bloqueia a
implementação: os prazos são configuráveis e 0 = comportamento atual).

## Project Structure

### Documentation (this feature)

```text
specs/004-uso-custo/
├── spec.md
├── plan.md              # este arquivo
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── usage-api.md
│   ├── audit-api.md
│   └── instrumentation.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/backend/src/
├── schema.ts                       # + bloco F6: ai_usage_logs (e idx_audit_target)
├── routes.ts                       # + registro das rotas; auditoria de login/logout/senha; remove /llm/usage (T058)
├── index.ts                        # + backfill após migrate; poda diária
├── config.ts                       # + retenção e flush
├── llm/
│   ├── provider.ts                 # Generation<T>, LlmUsage, purpose
│   ├── index.ts                    # funil: mede, classifica, recordUsage
│   ├── ollama.ts | openrouter.ts | hostCli.ts   # devolvem uso por chamada
│   └── usage.ts                    # REMOVIDO na Fase 9 (substituído por usage/)
├── usage/                          # NOVO
│   ├── period.ts                   # month|from/to, fuso
│   ├── errorCode.ts                # classificação fechada de erros
│   ├── recorder.ts                 # recordUsage (nunca lança)
│   ├── liveAsr.ts                  # acumulador do ASR ao vivo
│   ├── queries.ts                  # painel do usuário (user_id = eu)
│   ├── adminQueries.ts             # agregados sem reunião
│   ├── routes.ts                   # /usage/me, /usage/me/calls, /admin/usage
│   └── backfill.ts                 # incorpora external_* do audit_log
├── audit/                          # NOVO
│   ├── projection.ts               # lista permitida por kind (default deny)
│   ├── queries.ts
│   └── routes.ts                   # /audit/me, /admin/audit, /audit/kinds
├── retention/prune.ts              # NOVO: poda em lotes + auditoria
├── asr/openrouter.ts               # usage.seconds/cost por canal
├── pipeline.ts                     # linha do passe local
├── recording/liveSession.ts        # alimenta o acumulador
├── agent/postAnalysis.ts | liveAgent.ts   # purpose (e meetingId no ao vivo)
├── authz/matrix.ts                 # ai_usage.read -> ADMIN
└── security/audit.ts               # novos kinds

apps/frontend/src/
├── pages/settings/ConsumoTab.tsx   # reescrita
├── pages/settings/SecurityTab.tsx  # NOVO (aba "Segurança")
├── pages/Configuracoes.tsx         # + aba
├── pages/admin/UsoIA.tsx           # NOVO
├── pages/admin/Auditoria.tsx       # NOVO
├── components/ui/UsageBars.tsx     # NOVO
├── components/shell/nav.ts         # + itens com permissão
├── App.tsx                         # + rotas /admin/uso e /admin/auditoria
├── format.ts                       # formatadores
└── styles.css

packages/contracts/src/
├── usage.ts                        # NOVO
└── platform.ts                     # + ai_usage.read

apps/backend/test/        # unitários novos: usage-*.test.ts, audit-projection.test.ts
apps/backend/test/db/     # uso-*.test.ts, auditoria.test.ts
apps/backend/e2e/uso.spec.ts
```

**Structure Decision**: módulos novos `usage/`, `audit/` e `retention/` no backend, ao lado de
`llm/`, `authz/` e `security/`, sem tocar na estrutura do monorepo. O registro é um funil único
(`recordUsage`) chamado por poucos pontos; as consultas ficam separadas por público
(`queries.ts` do usuário × `adminQueries.ts` do admin) para que a ausência de dados de reunião no
admin seja garantida pelo tipo de retorno, não por filtro em tempo de execução.

## Fases de entrega

| Fase | Entrega | Stories | Prioridade |
|---|---|---|---|
| A | Tabela, permissão, registrador, contrato dos provedores | Fundação | bloqueante |
| B | Registro de LLM (todos os provedores) | US1 | P1 |
| C | Registro de ASR (local final, ao vivo, Deepgram) | US2 | P1 |
| D | Painel do usuário | US3 | P1 |
| E | Painel de admin | US4 | P2 |
| F | Auditoria visível + eventos de autenticação | US5 | P2 |
| G | Retenção e incorporação do histórico | US6 | P3 |
| H | Limpeza, docs, verificação | Polish | — |

B, C e F podem andar em paralelo depois de A.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Conteúdo vazar em coluna de texto | tipo `UsageSample` sem campo de texto livre; `label` ≤ 80; teste que varre as colunas (T019) |
| Admin ver dado de reunião alheia | consultas de admin sem `meeting_id`; teste de varredura por chave com mutação (T038) |
| Auditoria expor `detail` cru | projeção com lista permitida e default deny (T044/T045) |
| Mudança de interface do provedor quebrar chamadores | só `llm/index.ts#generate` consome `Generation`; assinatura pública igual; typecheck |
| Conflito de merge com as features 002, 003, 005 | edições curtas no fim de `schema.ts`, `platform.ts`, `matrix.ts`, `nav.ts`, `App.tsx`; rebase em `develop` a cada fase |
| Migração em banco real | aditiva e idempotente; `pg_dump`; só com confirmação e backend ocioso (T066) |
| Poda apagar demais | `0` desliga, prazos configuráveis, lotes, teste de limites (T056) |
| `user_id` nulo nas chamadas ao vivo (hoje sem `meetingId`) | T016 passa `meetingId` no `liveAgent` |
| Reversão da decisão "sem tabela nova" | Q1 pede confirmação explícita antes da Fase 2 |

## Complexity Tracking

Sem violações da constituição. Itens de complexidade conscientemente aceitos:

| Item | Por que é necessário | Alternativa mais simples rejeitada |
|---|---|---|
| Tabela nova `ai_usage_logs` (Q1) | falhas, local, ASR, índices e retenção própria | ficar no `audit_log` perde tudo isso e obriga cast de JSONB sem índice |
| Mudar `LLMProvider.generate` para devolver `Generation<T>` | uso por chamada só existe dentro do provedor | ler `console.log`/reanalisar a resposta duplicaria parsing |
| Projeção de auditoria por lista permitida | garantir "sem conteúdo" por construção | expor `detail` filtrado por blacklist falha ao surgir campo novo |
| Acumulador de ASR ao vivo | evitar milhares de linhas por reunião | uma linha por trecho |
