---
description: "Tarefas da funcionalidade Nome dos falantes pela chamada"
---

# Tasks: Nome dos falantes pela chamada

**Input**: `specs/006-nome-dos-falantes/` (spec.md, plan.md)

**Prerequisites**: plan.md, spec.md. Decisões 1–6 do plan.md (tomadas em 2026-11-18): as tarefas já
seguem essas decisões; reabrir uma delas afeta T005, T018, T049 e T063.

**Tests**: a Constituição (Princípio VII) exige teste automatizado quando viável e validação com reunião
real. Há tarefas de teste antes de cada módulo puro e três validações reais (T060–T062).

**Organization**: agrupadas por user story (US1–US4 da spec). US1 e US2 são P1 e formam o MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1…US4

## Path Conventions

Monorepo: `apps/backend/src/`, `apps/backend/test/`, `apps/frontend/src/`, `packages/contracts/src/`.

---

## Phase 1: Setup (captura e configuração)

- [ ] T001 Criar `apps/backend/scripts/capture-speaker-dom.mjs`: roda o assistente numa reunião do próprio usuário (Teams convidado, Teams com conta do agente, Meet), salva a cada 2 s o HTML dos tiles/painel de pessoas e uma linha do tempo de "quem o usuário viu falando", com nomes trocados por "Pessoa A/B/C" e sem URLs/ids reais. **Requer reunião real do usuário** (3 capturas) e registra no plano quais hipóteses de seletor (R1) se confirmaram.
- [ ] T002 Criar fixtures anonimizadas em `apps/backend/test/fixtures/speakers/` a partir de T001: `teams-guest-stage.html`, `teams-account-stage.html`, `meet-grid.html`, `meet-people-panel.html`, `teams-large.html`, `meet-large.html`, `broken.html`, `stuck.html`; cada uma com `window.__setSpeaking(name, on)`
- [ ] T003 [P] Adicionar `BOT_SPEAKER_NAMES` (bool, padrão true) e `BOT_SPEAKER_SKEW_MS` (padrão 0) em `apps/backend/src/config.ts`, `.env.example` e `.env.vps.example`

---

## Phase 2: Foundational (bloqueia as user stories)

**⚠️ CRITICAL**: nenhuma story começa antes de T004–T013.

- [ ] T004 Contracts em `packages/contracts/src/domain.ts`: `Speaker.nameSource/nameConfidence`, `MeetingDetail.speakerTimeline`, `LIVE_SPEAKER_PREFIX = "live:"`, tipos de `apply-call-names`; regenerar `packages/contracts/schemas`
- [ ] T005 Migração idempotente em `apps/backend/src/schema.ts`: tabela `speaker_activity` + índice, colunas `meeting_speakers.name_source/name_confidence` (com o backfill de legado → `manual`) e `meetings.speaker_timeline_meta` (SQL descrito no plan D2). **Não rodar sem confirmar** (regra global de migrations)
- [ ] T006 [P] Criar `apps/backend/src/repo/speakerActivity.ts`: insert em lote, leitura por reunião, delete, leitura/gravação do `speaker_timeline_meta`; incluir `speaker_activity` em "excluir transcrição"
- [ ] T007 [P] Criar `apps/backend/src/bot/speakers/names.ts`: `normalizeDisplayName`, chave do participante, regras de ignorar (assistente, "(Você)", apresentando, vazio), desambiguação "(2)"
- [ ] T008 [P] Teste `apps/backend/test/speakers-names.test.ts` (marcadores pt/en, sufixos, limite de 120, controle, duplicados, assistente)
- [ ] T009 [P] Criar `apps/backend/src/recording/speakerTimeline.ts`: estrutura em memória por reunião (`addEdge`, histerese 300/500 ms, fusão de lacunas, intervalos abertos, `dominant(t0, t1)`, `snapshot()`, registro `Map<meetingId, …>` com `drop`)
- [ ] T010 [P] Teste `apps/backend/test/speakers-timeline.test.ts` (histerese, fusão, intervalo aberto, `dominant` com maioria/empate/vazio)
- [ ] T011 [P] Criar `apps/backend/src/recording/clockAnchor.ts`: estimador `min(W − B/32)` a partir dos blocos PCM e conversão `performance.now()` → segundos do áudio (D2)
- [ ] T012 [P] Teste `apps/backend/test/speakers-clock.test.ts` (jitter, rajada, perda de bloco, âncora monotônica, sem blocos)
- [ ] T013 [P] Eventos de auditoria só com contadores (`speaker_timeline_recorded`, `speaker_names_applied`) em `apps/backend/src/security/audit.ts`, sem nomes

**Checkpoint**: contratos, banco, linha do tempo em memória e relógio prontos.

---

## Phase 3: User Story 1 - Falantes da transcrição final com nome (Priority: P1) 🎯 MVP

**Goal**: leitura da tela pelo assistente + casamento no passe final.

**Independent Test**: fixture de áudio/segmentos + linha do tempo sintética com 3 falantes → nomes certos, origem "call", manual intacto.

### Tests (escrever antes)

- [ ] T014 [P] [US1] Teste `apps/backend/test/speakers-match.test.ts`: tabela de cenários do plan D3 (empate, 2 clusters → mesmo nome, 1 cluster com 2 pessoas → sem nome, fala simultânea, deslocamento +1,2 s e −0,8 s, cobertura baixa, nomes iguais, `user`/`Remoto` intactos, rótulos "Speaker N (parte i)")
- [ ] T016 [P] [US1] Teste de banco `apps/backend/test/db/falantes.test.ts`: migração idempotente, legado → `manual`, `applyCallNames` não sobrescreve `manual`, retranscrição refaz `call`, cascade ao excluir a reunião
- [ ] T021 [P] [US1] Teste `apps/backend/test/speakers-probe.test.ts` (Playwright + `page.setContent`): bordas de subida/descida, cache de tiles, exceção na página contada e não propagada, intervalo de 250/500 ms

### Implementation

- [ ] T015 [US1] Criar `apps/backend/src/meetings/speakerNames.ts`: `matchSpeakers` puro (preparação, deslocamento δ, matriz com divisão por `k`, limiares, confiança, diagnóstico), constantes calibráveis
- [ ] T017 [US1] Criar `applyCallNames(meetingId, segments)` (em `apps/backend/src/meetings/applyCallNames.ts`): lê `speaker_activity`, chama `matchSpeakers`, grava `meeting_speakers` com `name_source='call'` e `name_confidence`, nunca sobrescreve `manual`; atualiza `speaker_timeline_meta` (skew, rótulos sem decisão)
- [ ] T018 [US1] Em `apps/backend/src/pipeline.ts` e `apps/backend/src/repo/transcripts.ts`: chamar `applyCallNames` após `replaceWithFinal`; em retranscrição, apagar antes do `seedSpeakers` as linhas `name_source IN ('call') OR NULL` (padrão) e manter `manual`; falha do casamento só registra log e segue (nunca falha o pipeline)
- [ ] T019 [US1] `renameSpeaker`/`getSpeakers` em `apps/backend/src/repo/transcripts.ts`: gravar `name_source='manual'` ao renomear (nome = rótulo → `NULL`), devolver `nameSource` e `nameConfidence`
- [ ] T020 [US1] Criar `apps/backend/src/bot/speakers/probe.ts`: função de página `snapshot()`/poll de 250 ms (500 ms com > 30 tiles), borda de estado, binding `__mbSpeakers` em lotes de 1 s, cache de tiles com `MutationObserver` só como dica de invalidação, contadores de exceção
- [ ] T022 [US1] Criar `apps/backend/src/bot/speakers/meet.ts`: camadas 1–3 do Meet (R1) com seletores confirmados em T001, normalização do tile
- [ ] T023 [P] [US1] Teste `apps/backend/test/speakers-meet.test.ts` com `meet-grid.html`, `meet-people-panel.html`, `meet-large.html`
- [ ] T024 [US1] Criar `apps/backend/src/bot/speakers/teams.ts`: perfis `guest` e `account` (mesma interface, ordem de tentativa), camadas 1–3, frames, normalização
- [ ] T025 [P] [US1] Teste `apps/backend/test/speakers-teams.test.ts` com `teams-guest-stage.html`, `teams-account-stage.html`, `teams-large.html`
- [ ] T026 [US1] Criar `apps/backend/src/bot/speakers/collector.ts`: instala o probe, traduz relógio da página → segundos do áudio (T011), alimenta `speakerTimeline` (T009), flush a cada 10 s em lote (T006), `stop()` com timeout e flush final
- [ ] T027 [P] [US1] Teste `apps/backend/test/speakers-collector.test.ts` (relógio virtual, flush, parada com intervalo aberto, falha de flush não derruba)
- [ ] T028 [US1] `apps/backend/src/bot/platforms.ts`: `speakerProbe(profile)` opcional em `PlatformDriver` (Meet e Teams)
- [ ] T029 [US1] `apps/backend/src/bot/runner.ts`: após `isInCall`, iniciar o coletor (perfil `account` se `signedIn`, senão `guest`), alimentar o estimador de âncora no callback de PCM, `collector.check()` com `.catch` no ciclo, `stop()` no `finally` antes de `leaveCall`/`browser.close()`; tudo em `try/catch` e atrás de `BOT_SPEAKER_NAMES`
- [ ] T030 [US1] Gravar `speaker_timeline_meta` no fim da chamada (estado, fonte/camada, pessoas, intervalos) e o evento de auditoria (T013)
- [ ] T031 [US1] Validação cruzada com o áudio no `applyCallNames`: `speechCoverage` < 0,5 → estado `partial` (`low_correlation`) e nenhum nome aplicado (plan D3.12)
- [ ] T032 [P] [US1] Teste do passe final com ASR externo (`apps/backend/test/openrouter-asr.test.ts` ampliado): rótulos "Speaker N" e "Speaker N (parte i)" nomeados; nada novo no egress
- [ ] T033 [US1] `apps/backend/src/meetings/participants.ts`: deduplicar por nome normalizado (sem acento/caixa) entre falantes da chamada e convidados; ampliar `apps/backend/test/participants.test.ts`
- [ ] T034 [US1] Modo por segmento no passe final sem diarização (`speaker = null`): rotular segmentos com `dominant()` e criar os falantes pelo nome (plan D3 "modo por segmento")
- [ ] T035 [P] [US1] Teste do T034 (com e sem linha do tempo; sem dados mantém `null`)
- [ ] T036 [US1] (opcional, P3) Nomear `Remoto` apenas quando uma única pessoa concentra ≥ 95% da fala detectada; teste junto

**Checkpoint**: com fixtures, a reunião sai do passe final com nomes e o manual prevalece.

---

## Phase 4: User Story 2 - Falha da leitura nunca atrapalha a gravação (Priority: P1)

**Goal**: degradação segura, saúde e estado visível.

**Independent Test**: `broken.html`, `stuck.html`, exceção no probe e navegação da página: o bot segue na chamada, o áudio fecha, o passe final roda como hoje.

- [ ] T037 [P] [US2] Teste `apps/backend/test/speakers-health.test.ts`: as cinco regras do plan D5 (sem tiles, sem indicador, preso, exceções, correlação) e transições de estado
- [ ] T038 [P] [US2] Medir custo da leitura (CPU na página e no Node) com `teams-large.html`/`meet-large.html` com 8 e 30 tiles; registrar o resultado no plan (meta: < 3% de um núcleo); ajustar o intervalo (250/500 ms) se preciso
- [ ] T039 [US2] Criar `apps/backend/src/bot/speakers/health.ts` (regras de saúde, limiares nomeados) e ligar no coletor; interromper o registro de intervalos suspeitos
- [ ] T040 [US2] Isolamento de falha em `collector.ts`/`runner.ts`: `Promise.race` de 2 s nas chamadas `page.evaluate`, reinjeção após navegação/frame destruído, log uma vez por mudança de estado, nenhum `await` do coletor no ciclo de 5 s
- [ ] T041 [US2] Estado `off`/`unavailable`/`partial` gravado em `speaker_timeline_meta` com `reason`; reunião sem assistente (host-agent, "Gravar agora") mantém o comportamento atual
- [ ] T042 [P] [US2] Teste `apps/backend/test/speakers-isolation.test.ts`: seletor que não acha nada, probe que lança, página que navega, flush que falha — o ciclo do bot continua e o áudio fecha (reaproveitar o padrão de `bot-leave.test.ts`)

**Checkpoint**: US1 + US2 = MVP verificável sem reunião real.

---

## Phase 5: User Story 3 - Nome ao vivo (Priority: P2)

**Goal**: segmentos do canal `mixed` rotulados em tempo real.

**Independent Test**: sessão ao vivo com `speakerTimeline` falso: segmento com maioria de uma pessoa sai com o nome.

- [ ] T043 [P] [US3] Teste `apps/backend/test/live-speaker.test.ts`: maioria ≥ 50%, empate, sem linha do tempo, canal `mic`/`remote` intacto
- [ ] T044 [P] [US3] Teste do resolvedor: `speakerNameResolver` remove o prefixo `live:`; rótulos `live:` nunca viram `meeting_speakers`
- [ ] T045 [US3] `apps/backend/src/recording/liveSession.ts`: no canal `mixed`, `speaker = "live:" + dominant(...)` quando há linha do tempo; `apps/backend/src/repo/transcripts.ts`: `speakerNameResolver` trata o prefixo
- [ ] T046 [US3] Ciclo de vida do registro `speakerTimeline` (criado pelo coletor, descartado em `closeLiveSessions`/fim do bot) sem vazar memória entre reuniões
- [ ] T047 [P] [US3] Verificar `apps/backend/src/agent/module.ts` e `apps/backend/test/live-agent.test.ts`: o agente ao vivo passa a ver os nomes nos itens e no resumo; ajustar prompt/teste se algo assumir `null`
- [ ] T048 [P] [US3] Teste: `replaceWithFinal` apaga os segmentos `live` com rótulos `live:` e o casamento do passe final decide os nomes (spec US3, cenário 3)

---

## Phase 6: User Story 4 - Revisão humana na interface (Priority: P2)

**Goal**: origem e confiança visíveis, renomear/voltar/reaplicar.

**Independent Test**: reunião com nomes automáticos mostra selo e confiança; renomear grava manual; "Reaplicar" respeita manual; leitor não vê controles.

- [ ] T049 [US4] `apps/backend/src/ata/routes.ts`: `POST /meetings/:id/speakers/apply-call-names` (permissão `meetings.manage`, responde `{applied, skipped}`), `PATCH` com "voltar ao rótulo"; `emitMeetingChanged` + `transcript_replaced`
- [ ] T050 [P] [US4] Teste da API (apply, voltar ao rótulo, 404/403, leitor sem acesso, reunião de outro dono)
- [ ] T051 [US4] `apps/backend/src/routes.ts`: incluir `speakerTimeline` no `MeetingDetail` (status, reason, people)
- [ ] T052 [US4] `apps/frontend/src/components/Speakers.tsx`: selo "da chamada"/"manual", faixa de confiança (alta / conferir), "Voltar ao Speaker N", "Reaplicar nomes da chamada" (some para `readOnly`)
- [ ] T053 [US4] `apps/frontend/src/pages/Reuniao.tsx`: aviso quando a leitura ficou `partial`/`unavailable` e texto de ajuda; `Transcript.tsx` só confirmar que o nome ao vivo e o final aparecem
- [ ] T054 [P] [US4] Testes de interface do `Speakers` (componente) seguindo o padrão de testes do frontend existente
- [ ] T055 [P] [US4] E2E (`npm run test:e2e -w @meeting-bot/backend`): reunião semeada com falantes automáticos e manuais, renomear e reaplicar

---

## Phase 7: Polish, documentação e validação real

- [ ] T056 [P] README.md (pt-BR): seções "Separação de falantes", "Durante a reunião", "Depois da reunião", variáveis do `.env`, "Limitações conhecidas"
- [ ] T057 [P] README.en.md: os mesmos pontos de T056
- [ ] T058 [P] README.es.md: os mesmos pontos de T056
- [ ] T059 [P] `CLAUDE.md` (regra do projeto), `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/agente-arquiteto.md` (nomes ao vivo)
- [ ] T060 **Validação real: Teams como convidado**: reunião do usuário com 3 a 6 pessoas, conferir SC-001/SC-002, calibrar limiares do `matchSpeakers` e o intervalo da leitura; registrar a verdade conferida pelo usuário
- [ ] T061 **Validação real: Teams com a conta do agente** (perfil `account`): mesmos critérios de T060
- [ ] T062 **Validação real: Meet**: mesmos critérios de T060
- [ ] T063 Aplicar a emenda MINOR 3.1.0 à constituição (Sync Impact Report, Princípio II: leitura passiva do que o convidado vê), aprovada na Decisão 2, antes do merge da implementação; atualizar o Constitution Check do plan
- [ ] T064 Quality gates: `npm run typecheck`, `npm test`, `npm run test:db -w @meeting-bot/backend`, `npm run test:e2e`; checklist Sonar nos arquivos alterados (complexidade cognitiva ≤ 15, sem catch vazio/console.log/literal repetido ≥ 3x, `Object.hasOwn`, sem segredo/IP); revisão do diff antes do commit
- [ ] T065 Verificar SC-007: egress bloqueado/auditado e `ss` sem conexões externas novas durante a gravação com a leitura ligada; atualizar a memória do projeto com o resultado

---

## Dependencies & Execution Order

- Setup (T001–T003) → Foundational (T004–T013) → US1 → US2 → (US3, US4 em paralelo) → Polish.
- T001/T002 precedem T020–T025 (seletores reais); sem a captura, T022/T024 usam só as hipóteses do plan e
  T060–T062 viram o critério de aceite.
- US1: T014 → T015 → T017 → T018; T020/T021 → T022/T024 (+ testes) → T026 → T028 → T029; T031 depende de T017.
- US2 depende de T026 e T029 (health liga no coletor).
- US3 depende de T009 e T026; US4 depende de T017–T019.
- T063 (emenda aprovada) precede o merge da implementação; T060–T062 precisam de reunião real e fecham a feature.

## Parallel Example

Em Foundational: T006, T007+T008, T009+T010, T011+T012 e T013 em paralelo. Em US1: T014, T016 e T021
juntos; T023 e T025 em paralelo depois de T022/T024.

## Implementation Strategy

1. MVP = US1 + US2 (casamento no passe final, leitura isolada e segura).
2. Entregar US3 (ao vivo) e US4 (revisão na interface) em seguida.
3. Nada é declarado pronto antes de T060–T062 e T064–T065.

**Total**: 65 tarefas (3 setup, 10 foundational, 23 US1, 6 US2, 6 US3, 7 US4, 10 polish/validação).
