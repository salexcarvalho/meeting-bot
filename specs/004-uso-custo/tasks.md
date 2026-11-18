---
description: "Tarefas da F6: painel de uso e custo de IA e auditoria visível"
---

# Tasks: Painel de Uso e Custo de IA e Auditoria Visível (F6)

**Input**: documentos de design em `specs/004-uso-custo/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md.
**Bloqueio**: as Open Questions Q1–Q5 da `spec.md` precisam de decisão antes da Fase 2
(Q1 muda o schema; Q2 os prazos da Fase 8; Q3 o painel de admin; Q4 a moeda; Q5 a auditoria de
login). Os padrões abaixo seguem as recomendações (A em todas).

**Tests**: a Constituição (princípio VII) exige teste automatizado quando viável; cada story traz
testes unitários, de banco (`npm run test:db -w @meeting-bot/backend`, Postgres descartável) e E2E
(`npm run test:e2e`). Escrever o teste antes da implementação do módulo correspondente.

**Organization**: tarefas por user story (US1–US6 da spec); cada story é entregável e testável sozinha
depois da Fase 2.

## Format: `- [ ] [ID] [P?] [Story] Descrição com caminho`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1…US6

## Path Conventions

Monorepo (ver `plan.md`): `apps/backend/src/`, `apps/frontend/src/`, `packages/contracts/src/`,
testes em `apps/backend/test/` (unitários), `apps/backend/test/db/` (banco) e `apps/backend/e2e/`.

---

## Phase 1: Setup (infraestrutura compartilhada)

**Purpose**: tipos, configuração e fixtures usados por todas as stories.

- [x] T001 [P] Criar `packages/contracts/src/usage.ts` (zod): `UsagePurpose`, `UsageProvider`, `UsageErrorCode`, `UsageTotals`, `UsageGroup`, `UsageReport`, `AdminUsageReport`, `UsageCall`, `UsagePeriodQuery`, `AuditEventView`, `AuditPage`, `RetentionInfo`; exportar em `src/index.ts` e cobrir com `apps/backend/test/contracts-schemas.test.ts`
- [x] T002 [P] Adicionar em `apps/backend/src/config.ts` `usageRetentionDays` (730), `auditRetentionDays` (365) e `usageAsrFlushMinutes` (10), lidos de `USAGE_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`, `USAGE_ASR_FLUSH_MINUTES`; documentar os nomes no `.env.example` (nunca no `.env`)
- [x] T003 [P] Criar fixtures com o formato real das respostas em `apps/backend/test/fixtures/usage/`: `openrouter-chat.json` (com `usage.cost`), `openrouter-chat-sem-custo.json`, `openrouter-stt.json` (`usage.seconds`/`cost`), `ollama-chat.json` (`prompt_eval_count`, `eval_count`, `*_duration`), `host-cli-result.json` (`AgentLlmResult`)
- [x] T004 [P] Mover `monthRange`/`currentMonth` de `apps/backend/src/llm/usage.ts` para `apps/backend/src/usage/period.ts` (reexportar no antigo até a Fase 9) e acrescentar o parser de `month` ou `from`/`to` (janela ≤ 24 meses) com teste em `apps/backend/test/usage-period.test.ts`

---

## Phase 2: Foundational (bloqueia todas as stories)

**Purpose**: tabela, permissão, registrador e contrato dos provedores.

- [x] T005 Adicionar em `apps/backend/src/schema.ts`, em bloco `-- F6 uso e custo` no fim, `ai_usage_logs` (colunas, `CHECK`s e índices de `data-model.md`), idempotente
- [x] T006 [P] Teste de banco `apps/backend/test/db/uso-schema.test.ts`: migração roda duas vezes sem erro; `CHECK`s rejeitam (sucesso sem `error_code`, negativos, `purpose` fora do enum); excluir reunião/usuário mantém a linha com FK nula
- [x] T007 [P] Criar a permissão `ai_usage.read` em `packages/contracts/src/platform.ts` (`PERMISSIONS`) e conceder ao ADMIN em `apps/backend/src/authz/matrix.ts`; ajustar `apps/backend/test/platform-units.test.ts` (SUPER_ADMIN e ADMIN têm; USER e VIEWER não)
- [x] T008 [P] Criar `apps/backend/src/usage/errorCode.ts` (`classifyError(err): UsageErrorCode`, função pura) com teste `apps/backend/test/usage-error-code.test.ts` usando os erros reais dos três provedores e do ASR
- [x] T009 Criar `apps/backend/src/usage/recorder.ts`: `recordUsage(sample)` síncrona e sem lançar, validação/normalização, dono por `meetings.created_by` com cache de 60 s, INSERT com `.catch(console.error)`
- [x] T010 [P] Teste unitário `apps/backend/test/usage-recorder.test.ts`: falha do INSERT não propaga; amostra inválida descartada; `label` truncado em 80; dono resolvido e cache; reunião inexistente → `user_id` nulo
- [x] T011 Alterar `apps/backend/src/llm/provider.ts`: `LlmUsage`, `Generation<T>`, `UsageCarryingError`, `GenerateRequest.purpose` obrigatório e `LLMProvider.generate` devolvendo `Generation<T>`; atualizar os mocks de `apps/backend/test/*.test.ts` que implementam `LLMProvider`

**Checkpoint**: tabela e registrador prontos; nenhuma tela ainda.

---

## Phase 3: User Story 1 - Cada chamada de IA fica registrada (Priority: P1) 🎯 MVP

**Goal**: uma linha por chamada de LLM (sucesso ou erro), sem conteúdo, em todos os provedores.

**Independent Test**: gerar ata com local, OpenRouter e assinatura simulados e uma falha forçada;
conferir uma linha por geração, com números da resposta simulada e sem texto de reunião.

- [x] T012 [US1] `apps/backend/src/llm/ollama.ts`: somar `prompt_eval_count`/`eval_count` e `prompt_eval_duration + eval_duration` (ns→ms) das tentativas; devolver `Generation`; falhas lançam `UsageCarryingError` com o uso parcial
- [x] T013 [US1] `apps/backend/src/llm/openrouter.ts`: somar `usage.prompt_tokens`, `usage.completion_tokens` e `usage.cost` das tentativas; `costUsd` nulo se o provedor não informar; erro HTTP carrega `http_<status>`; `audit("external_llm")` passa `userId` do dono, `purpose` e `success`
- [x] T014 [US1] `apps/backend/src/llm/hostCli.ts`: usar `result.usage.inputTokens/outputTokens`, `durationMs` e `costUsd = null`; `UsageCarryingError` nas falhas; `audit("external_llm")` com `userId`
- [x] T015 [US1] `apps/backend/src/llm/index.ts#generate`: medir `durationMs` (sem fila), receber `usage` do provedor ou do erro, classificar com `classifyError`, chamar `recordUsage` (sucesso e falha) e devolver só `data`; assinatura pública inalterada
- [x] T016 [US1] Passar `purpose` em todos os `generate` de `apps/backend/src/agent/postAnalysis.ts` (`itens`, `ata`, `resumo`, `adr` conforme `research.md` §4) e em `apps/backend/src/agent/liveAgent.ts` (`ao_vivo`, agora com `meetingId`)
- [x] T017 [P] [US1] Estender `apps/backend/test/llm-provider.test.ts`, `openrouter-llm.test.ts` e `subscription-llm.test.ts`: soma de tentativas, custo ausente → nulo, uso parcial na falha, `audit` com `userId`
- [x] T018 [P] [US1] Teste do funil em `apps/backend/test/usage-generate.test.ts`: uma chamada = uma linha; `recordUsage` quebrado não altera o retorno; ao vivo com provedor externo é rejeitado e não grava
- [x] T019 [US1] Teste de banco `apps/backend/test/db/uso-llm.test.ts`: geração simulada grava usuário/reunião/finalidade/provedor/tokens; falha grava `success=false` + `error_code`; **contrato "sem conteúdo"** varre todas as colunas `TEXT` contra a transcrição de teste (SC-007)

**Checkpoint**: o registro funciona e já dá para consultar por SQL (MVP de dados).

---

## Phase 4: User Story 2 - Minutos e tempo de transcrição (ASR) registrados (Priority: P1)

**Goal**: ASR local (ao vivo e final) e Deepgram registrados com minutos, custo informado e tempo.

**Independent Test**: processar uma reunião com Whisper local e outra com ASR externo; conferir
minutos, provedor, custo (só externo) e tempo.

- [x] T020 [US2] Criar `apps/backend/src/usage/liveAsr.ts`: acumulador por `(meetingId, channel)` de `duration`, `speech_seconds` e `elapsed`, com flush a cada `usageAsrFlushMinutes` e no fechamento (relógio/timer injetáveis); cada flush insere uma linha-delta (append-only)
- [x] T021 [P] [US2] Teste unitário `apps/backend/test/usage-live-asr.test.ts`: flush por tempo, flush no `close`, delta sem dupla contagem, acumulador zerado após flush, sem linha quando não houve áudio
- [x] T022 [US2] `apps/backend/src/recording/liveSession.ts`: alimentar o acumulador a cada `transcribeChunk` e chamar o flush final em `close()`
- [x] T023 [US2] `apps/backend/src/asr/openrouter.ts#transcribeFileExternal`: ler `usage.seconds`, `usage.cost` e tokens por fatia, gravar uma linha por canal (soma), registrar erro de fatia com os minutos já feitos e passar `userId` ao `audit("external_asr")`, que passa a ter também o registro de fim com resultado
- [x] T024 [US2] `apps/backend/src/pipeline.ts`: gravar a linha do passe final local (`audio_seconds` = soma de `JobChannelResult.duration`, `duration_ms` = tempo de parede de `runTranscriptionJob`, `provider=whisper`) e a falha do passe local
- [x] T025 [P] [US2] Estender `apps/backend/test/openrouter-asr.test.ts`: soma de fatias, `cost` ausente → nulo, falha parcial gera linha de erro com minutos feitos
- [x] T026 [US2] Teste de banco `apps/backend/test/db/uso-asr.test.ts`: passe local e externo gravam a linha correta; 200 trechos ao vivo geram no máximo uma linha por flush; `audio_seconds` só em ASR

**Checkpoint**: LLM e ASR registrados; custo total da instância já fecha.

---

## Phase 5: User Story 3 - Painel do usuário (Priority: P1)

**Goal**: aba "Consumo de IA" mostrando só os dados do próprio usuário.

**Independent Test**: dois usuários com consumos diferentes; cada um vê só o seu; total do painel
bate com a soma das linhas.

- [x] T027 [US3] Criar `apps/backend/src/usage/queries.ts`: função única de totais (`UsageTotals`) e agrupamentos por finalidade, provedor, modelo e dia (`date_trunc` em `APP_TIMEZONE`), `topMeetings` (join com `meetings.created_by = $user`) e `calls` paginado por cursor `(at,id)`; sempre `WHERE user_id = $1`
- [x] T028 [US3] Criar `apps/backend/src/usage/routes.ts` com `GET /usage/me` e `GET /usage/me/calls` (query validada por zod; `retention` no corpo) e registrar em `apps/backend/src/routes.ts`
- [x] T029 [US3] Teste de banco `apps/backend/test/db/uso-painel.test.ts`: totais = soma das linhas (SC-002), filtros `status/purpose/provider`, cursor sem repetir nem pular, agrupamento por dia no fuso, período inválido → 400
- [x] T030 [US3] Teste de isolamento `apps/backend/test/db/uso-isolamento.test.ts`: usuário B não vê linhas, totais, reuniões nem títulos de A; reunião compartilhada não entra no painel de B; VIEWER recebe zeros; **mutação** que remove o filtro `user_id` precisa fazer o teste falhar (SC-003)
- [x] T031 [P] [US3] `apps/frontend/src/format.ts`: formatadores de tokens, USD (6 casas se < 0,01), minutos de áudio, duração e nulo "—"/"sem custo por chamada"
- [x] T032 [P] [US3] Criar `apps/frontend/src/components/ui/UsageBars.tsx`: barras diárias em SVG/CSS com tabela equivalente acessível (sem biblioteca nova)
- [x] T033 [US3] Reescrever `apps/frontend/src/pages/settings/ConsumoTab.tsx` consumindo `/usage/me`: seletor de período, KPIs (chamadas, tokens, custo, minutos ASR local×externo, inferência local), por finalidade/provedor/modelo, série diária, reuniões que mais consumiram, chamadas com filtro de falhas e "carregar mais", estados vazio/carregando/erro
- [x] T034 [US3] Estilos em `apps/frontend/src/styles.css` reaproveitando card/KPI/tabs/tabela, com layout responsivo no celular
- [x] T035 [US3] E2E `apps/backend/e2e/uso.spec.ts` (desktop e celular): dois usuários, totais batendo, filtro de erro, estado vazio

**Checkpoint**: valor visível ao usuário (MVP de interface).

---

## Phase 6: User Story 4 - Painel de admin agregado (Priority: P2)

**Goal**: admin vê uso e custo por usuário/provedor/modelo/finalidade/dia, sem nenhum dado de reunião.

**Independent Test**: admin vê totais por usuário; resposta e tela sem título nem id de reunião;
USER recebe 403.

- [x] T036 [US4] Criar `apps/backend/src/usage/adminQueries.ts`: reutiliza a função de totais, agrupa por `user_id` (grupos `instance` e `removed`), provedor, modelo, finalidade e dia; **nunca seleciona `meeting_id`** (tipo de retorno sem campo de reunião)
- [x] T037 [US4] Rota `GET /admin/usage` com `requirePermission("ai_usage.read")` em `apps/backend/src/usage/routes.ts`
- [x] T038 [US4] Teste de banco `apps/backend/test/db/uso-admin.test.ts`: soma de `byUser` = `totals`; varredura recursiva da resposta por chaves proibidas (`meetingId`, `title`, `meeting*`) com mutação que as reintroduz; USER/VIEWER → 403; usuário excluído → "removed"
- [x] T039 [US4] Criar `apps/frontend/src/pages/admin/UsoIA.tsx` (reutiliza `UsageBars`), rota `/admin/uso` em `apps/frontend/src/App.tsx` protegida por `can("ai_usage.read")` e item "Uso de IA" em `apps/frontend/src/components/shell/nav.ts` (grupo Sistema, `permission: "ai_usage.read"`)
- [x] T040 [US4] Aviso fixo na tela "agregados da instância; conteúdo e títulos de reuniões não aparecem aqui" e estados vazio/erro
- [x] T041 [US4] E2E em `apps/backend/e2e/uso.spec.ts`: item de menu some para USER, URL direta redireciona, API devolve 403

---

## Phase 7: User Story 5 - Auditoria visível na interface (Priority: P2)

**Goal**: usuário vê os próprios eventos de segurança; admin vê os do sistema; nada de conteúdo.

**Independent Test**: eventos com dois usuários e um admin; cada um vê só o permitido; campos
livres nunca vazam.

- [x] T042 [US5] `apps/backend/src/security/audit.ts`: acrescentar `auth_login`, `auth_login_failed`, `auth_logout`, `auth_password_changed` e `retention_pruned` em `AuditKind`
- [x] T043 [US5] `apps/backend/src/routes.ts`: auditar `/auth/login` (sucesso e falha, inclusive limite de taxa; IP só na falha, Q5-A), `/auth/logout` e `/auth/password`; nunca gravar o nome digitado nem a senha
- [x] T044 [US5] Criar `apps/backend/src/audit/projection.ts`: lista permitida de campos e rótulo pt-BR por `kind` (`data-model.md`); `kind` ou campo desconhecido → só tipo e data; `meetingId` e `title` nunca
- [x] T045 [P] [US5] Teste unitário `apps/backend/test/audit-projection.test.ts`: campos fora da lista descartados, tipo desconhecido seguro, `meetingId` ausente em todos os tipos
- [x] T046 [US5] Criar `apps/backend/src/audit/queries.ts` e `apps/backend/src/audit/routes.ts`: `GET /audit/me` (ator ou alvo), `GET /admin/audit` (`audit.read`, filtros `kind/from/to/userId`, cursor), `GET /audit/kinds`; resolver ator/alvo para nome de usuário; registrar em `routes.ts`
- [x] T047 [US5] Índice `idx_audit_target` em `apps/backend/src/schema.ts` (bloco F6) se a consulta por alvo exigir; medir com `EXPLAIN` no teste de banco
- [x] T048 [US5] Teste de banco `apps/backend/test/db/auditoria.test.ts`: usuário vê ator e alvo próprios e nada de outros; "admin redefiniu sua senha" aparece para o alvo; admin vê tudo projetado, sem `meetingId`; `external_llm`/`external_asr` com `user_id` aparecem ao dono; USER → 403 em `/admin/audit`
- [x] T049 [P] [US5] Criar `apps/frontend/src/pages/settings/SecurityTab.tsx` e a aba "Segurança" em `apps/frontend/src/pages/Configuracoes.tsx` (lista cronológica, filtro por tipo, "carregar mais")
- [x] T050 [P] [US5] Criar `apps/frontend/src/pages/admin/Auditoria.tsx`, rota `/admin/auditoria` em `App.tsx` e item "Auditoria" em `nav.ts` (`permission: "audit.read"`)
- [x] T051 [US5] E2E em `apps/backend/e2e/uso.spec.ts`: login com senha errada aparece em "Segurança"; admin vê em "Auditoria"; USER sem acesso à rota admin

---

## Phase 8: User Story 6 - Retenção e continuidade (Priority: P3)

**Goal**: poda automática por prazo e incorporação única do histórico do `audit_log`.

**Independent Test**: com prazos curtos, só o antigo some; incorporação duas vezes = mesmo resultado.

- [x] T052 [US6] Criar `apps/backend/src/usage/backfill.ts`: incorporar `external_llm`/`external_asr` do `audit_log` em `ai_usage_logs` (`source='audit_backfill'`, `audit_log_id` único, `purpose` deduzido do `label` por regra tolerante, desconhecido → `outro`, dono pela reunião quando `user_id` do audit é nulo) e chamar após `migrate` em `apps/backend/src/index.ts`
- [x] T053 [US6] Teste de banco `apps/backend/test/db/uso-backfill.test.ts`: duas execuções = mesmas linhas; tokens/custo preservados; desconhecido → `outro`; migração sobre cópia do banco real mantém o painel contínuo
- [x] T054 [US6] Criar `apps/backend/src/retention/prune.ts`: poda em lotes de 5 000 com `pg_try_advisory_lock`, prazo 0 desliga, grava `audit("retention_pruned", {table, deleted, olderThanDays})`
- [x] T055 [US6] `apps/backend/src/index.ts`: executar a poda no boot e a cada 24 h (`setInterval(...).unref()`), sem segurar o shutdown
- [x] T056 [US6] Teste de banco `apps/backend/test/db/uso-retencao.test.ts`: só remove além do prazo, prazo 0 não remove, auditoria recente intacta, lote grande termina, execução concorrente não duplica
- [x] T057 [US6] Mostrar a política de retenção (valores vindos de `retention` na API) em `ConsumoTab.tsx`, `UsoIA.tsx` e nas telas de auditoria

---

## Phase 9: Polish & Cross-Cutting

**Purpose**: limpeza, documentação, verificação final.

- [x] T058 Remover `apps/backend/src/llm/usage.ts`, a rota `GET /llm/usage` (após uma versão de compatibilidade), os tipos `LlmUsage*` de `packages/contracts/src/domain.ts` e migrar `apps/backend/test/llm-usage.test.ts` para os testes novos
- [x] T059 [P] Atualizar `docs/ARCHITECTURE.md` (bullet "Consumo de LLM", auditoria visível, retenção) e `docs/analise/plataforma-multiusuario.md` (§13 e F6 entregue)
- [x] T060 [P] Atualizar `README.md`, `README.en.md` e `README.es.md` (mudança de comportamento: três idiomas) e `CHANGELOG.md`
- [x] T061 Propor ao usuário a emenda da constituição (retenção de logs em "Regras Operacionais", versão 2.3.0 com Sync Impact Report); só editar `.specify/memory/constitution.md` com aprovação
- [x] T062 [P] Checklist Sonar nos arquivos alterados: complexidade cognitiva ≤ 15 nos montadores de SQL, sem regex com backtracking sobre entrada, sem `console.log` novo fora do padrão do projeto, sem literal repetido ≥ 3x, `Object.hasOwn`, sem segredo/IP fixo, sem `NOSONAR`
- [x] T063 Revisão adversarial de segurança: tentar ler uso e auditoria de outro usuário por `/API/USAGE/ME` (caixa), parâmetros extras (`userId` em `/usage/me`), cursor adulterado, `month` malformado; regressão com mutação
- [ ] T064 Rodar `quickstart.md` ponta a ponta no navegador real (desktop e celular, tema claro e escuro) e registrar as capturas
- [x] T065 Verificação final: `npm run typecheck`, `npm test`, `npm run test:db -w @meeting-bot/backend`, `npm run test:e2e`, build do frontend
- [ ] T066 Checklist de aplicação no banco real: `pg_dump`, confirmação do usuário, deploy só com backend ocioso (sem reunião em processamento), conferir a migração sobre cópia do banco real

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: sem dependências.
- **Phase 2 (Foundational)**: depende da Fase 1; **bloqueia** todas as stories. Depende também da resposta de Q1.
- **US1 (Fase 3)** e **US2 (Fase 4)**: dependem só da Fase 2; podem andar em paralelo (arquivos diferentes: `llm/*` × `asr/*`, `pipeline.ts`, `recording/*`).
- **US3 (Fase 5)**: depende da Fase 2; só precisa de linhas para ver dados (US1/US2 ou fixtures de teste); testes de painel usam linhas inseridas direto.
- **US4 (Fase 6)**: depende de T027 (função de totais) e T033/T032 para reaproveitar `UsageBars`.
- **US5 (Fase 7)**: independente do uso (depende só da Fase 1); T043 e T048 tocam `routes.ts`/`audit.ts` já alterados por US1 (`userId` em `external_*`): rebase antes.
- **US6 (Fase 8)**: depende da Fase 2; T057 depende de T033, T039 e T049/T050.
- **Polish (Fase 9)**: depois das stories desejadas; T058 só depois de US3 em produção.

### Dentro de cada story

Teste → módulo puro → integração → interface. Cada story termina com o seu teste de banco ou E2E
passando antes da próxima.

### Parallel Opportunities

- Fase 1: T001–T004 em paralelo.
- Fase 2: T006, T007, T008 e T010 em paralelo (após T005/T009).
- US1 ∥ US2 ∥ US5 (após a Fase 2) por agentes/pessoas diferentes.
- Dentro de US3: T031 e T032 em paralelo com T027–T028.
- Dentro de US5: T049 e T050 em paralelo.

## Implementation Strategy

1. **MVP de dados**: Fases 1–3 (US1) já registram todas as chamadas de LLM; validar por SQL.
2. **MVP de produto**: + US2 e US3 (registro de ASR e painel do usuário) = entrega P1 completa.
3. **Governança**: US4 (admin) e US5 (auditoria) = P2.
4. **Higiene**: US6 e Polish = P3.

Entregar por PR em `feat/004-uso-custo` → `develop`, uma story por PR quando o tamanho exigir.

## Contagem

| Fase | Tarefas |
|---|---|
| 1 Setup | 4 (T001–T004) |
| 2 Foundational | 7 (T005–T011) |
| 3 US1 | 8 (T012–T019) |
| 4 US2 | 7 (T020–T026) |
| 5 US3 | 9 (T027–T035) |
| 6 US4 | 6 (T036–T041) |
| 7 US5 | 10 (T042–T051) |
| 8 US6 | 6 (T052–T057) |
| 9 Polish | 9 (T058–T066) |
| **Total** | **66** |
