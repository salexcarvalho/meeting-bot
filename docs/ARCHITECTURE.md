# Arquitetura (v0.3 — MVP do agente local)

Detalhes, decisões e contratos: `specs/001-agente-reunioes-mvp/` (plan.md, research.md,
data-model.md, contracts/).

```text
 host (Ubuntu, systemd --user)                 Docker Engine nativo (contexto default)
┌──────────────────────────────┐              ┌──────────────────────────────────────────────┐
│ host-agent (Python 3.12)     │ POST         │ backend (Node 24, Express 5, ws)             │
│  heartbeat 5 s ◄─ recording ─┼─ /api/agent ►│  scheduler 5 s (advisory lock)               │
│  alertas T-15/5/1 e sem link │  heartbeat   │  audioIngest → PCM → LiveSession → chunker   │
│   zenity, som, xdg-open)     │              │  LiveAgent (extração/consolidação)           │
│  parec mic + monitor → spool │ WS PCM ─────►│  finalize (ffmpeg → Opus) → pipeline         │
│  uploader com retomada       │ /api/agent/  │  postAnalysis → ata (render na leitura)      │
└──────────────────────────────┘   audio      │  UI React estática + WS /api/live            │
                                              │  Modo Agente (Playwright + PulseAudio)       │
 navegador ── cookie ── 127.0.0.1:3000 ──────►│  egress guard (LOCAL_ONLY + exceções ASR/LLM)│
                                              └───────┬──────────────┬──────────────┬────────┘
                                                      │              │              │
                                               postgres 16    worker-gpu
                                                              FastAPI
                                                              faster-whisper
                                                              pyannote
```

## Serviços

| Serviço | Imagem | Papel |
|---|---|---|
| `backend` | build de `apps/backend/Dockerfile` sobre `mcr.microsoft.com/playwright:v1.63.0-noble` | API, UI, WebSockets, agendador, agente, ata, Modo Agente |
| `postgres` | build de `docker/postgres` (`meeting-bot-postgres:16-pgvector`: `postgres:16-alpine` + pgvector 0.8.7) | persistência (`pgdata`), busca de texto e vetorial |
| `worker-gpu` | build de `apps/worker-gpu` sobre `nvidia/cuda:12.8.1-base` | `/transcribe/chunk` (ao vivo) e `/jobs/transcribe` (passe final + diarização) |
| `ollama` | `ollama/ollama:0.32.14` | só embeddings da busca (`bge-m3`, CPU, sem reserva de GPU; `OLLAMA_MAX_LOADED_MODELS=1`); nenhum modelo generativo |
| `caddy` | `caddy:2-alpine` (profile `https`) | TLS quando exposto em rede |

Volumes: `botdata` (áudio, `/data`), `models` (Whisper e Hugging Face), `pgdata`.

## Fluxos

> Não há LLM local: o LLM (ata, itens, ADR, análise ao vivo e chat) é sempre externo (constituição 3.0.0). O `ollama` existe só para os embeddings da busca, em CPU.
>
> Servidor de teste (Dokploy): `docker-compose.vps.yml` troca o worker-gpu pelo ASR externo
> e pelo container `agent-cli` (host-agent em `AGENTE_MODE=llm`, só geração). Ver `docs/vps-dokploy.md`.

1. **Agenda**
   - `.ics`: o node-ical expande recorrências.
   - O upsert usa `(UID, RECURRENCE-ID)` e `SEQUENCE`.
   - Cadastro manual também entra na agenda.
   - Dia fora de `WORKING_DAYS` (padrão sáb/dom, fuso `APP_TIMEZONE`): série não gera ocorrência (recorrência manual
     e sua extensão, RRULE do `.ics`, `recurring: true` da Aurora). Reunião avulsa fica na agenda, mas sem lembrete
     (`AgentMeeting.noAlerts`) e sem entrada/gravação automática, salvo `meetings.auto_on_off_day` (`calendar/offDay.ts`).
   - O projeto é sugerido por palavra-chave.
   - Importar `.ics` sobre reunião que uma importação automática (Aurora, sem link) criou casa por dono, título e
     início (±5 min) e só completa o que está vazio (link, plataforma, organizador, local, descrição, participantes),
     sem duplicar nem trocar o `ical_uid` da Aurora (`calendar/match.ts`, `adoptImported`).
   - Reunião sem link: o heartbeat entrega ao host-agent `alerts.noLinkMinutes` (`NO_LINK_ALERT_MINUTES`, 0 desliga)
     e a agenda do dono com `url` nula; o host-agent avisa uma vez por reunião e horário (`alerts.py`, estado em
     `alerts.json`) e a UI mostra o selo "Sem link" (`NoLinkBadge`).
2. **Gravação**
   - No horário, o scheduler põe o **assistente** (`bot/autoJoin.ts`) em toda reunião da agenda com link
     do Teams/Meet e sem "Não gravar": a reunião passa a `joining` e segue o Modo Agente (canal misto).
     A admissão espera até o fim previsto; limite de `MAX_CONCURRENT_BOTS` e um assistente por link.
   - Imagem do assistente (opcional, `BOT_CAMERA=true`, padrão desligado): `bot/card.ts` gera com o
     ffmpeg um quadro `.y4m` com o avatar do agente e o Chromium o usa como webcam
     (`--use-file-for-fake-video-capture`). O nome diz que é a ata (`recorderName` em `bot/identity.ts`).
   - O ffmpeg do assistente grava o Opus e, na mesma captura, entrega PCM 16 kHz ao backend: serve
     para a transcrição ao vivo (canal `mixed`, `LiveSession`; o LiveAgent roda em `in_call`) e para
     medir silêncio.
   - `bot/leave.ts` decide a saída: tela de fim da chamada, contagem de pessoas na barra
     (o texto "você é o único aqui" é só reserva), silêncio e limite de 4 h.
   - O PC não grava sozinho (`AUTO_LOCAL_RECORDING=false`); a gravação local vem de **Gravar agora**.
   - Na gravação local, o scheduler decide a gravação desejada e o host-agent converge a partir do heartbeat.
   - O áudio é PCM s16le 16 kHz por canal, alinhado ao relógio de parede (lacunas viram zeros).
   - O envio é retomável pelo `offset`.
   - A parada acontece com o fim previsto + 180 s sem fala, com **Parar** ou em 4 h.
3. **Ao vivo**
   - O chunker corta por energia: pausa ≥ 500 ms depois de 8 s, ou força o corte em 30 s.
   - O worker aplica o VAD e o Whisper; os segmentos `live` são publicados no WS.
   - O LiveAgent (só com a chave "Itens" ligada e `ALLOW_EXTERNAL_LLM=true`) roda a cada 90 s de fala ou 180 s,
     pelo provedor de `LLM_GENERATION_PROVIDER`, e valida a evidência (ids `S<n>` + citação).
   - A deduplicação usa Jaccard; a consolidação roda a cada 15 min.
4. **Pós-reunião**
   - O finalize converte para Opus e confere a duração com o ffprobe.
   - O pipeline, em fila serial:
     - fecha o agente ao vivo;
     - roda o passe final (Whisper + pyannote no canal remoto, ou ASR externo de teste);
     - substitui `live` → `final` numa transação, remapeando as evidências;
     - faz o map-reduce de extração, a consolidação, a narrativa (`meetings.analysis`) e os ADRs sugeridos;
     - grava quem gerou (`meetings.analysis_provider`, `meeting_items.generated_by`, `adrs.generated_by`).
   - Sob demanda: `POST /meetings/:id/reprocess` (`step: "analysis"`) refaz só a análise;
     `POST /meetings/:id/adrs/generate` gera os ADRs (todos ou um `itemId`) sem mudar o status da reunião.
5. **Ata**
   - É renderizada na leitura (`ata/render.ts`) a partir da narrativa e do estado atual dos itens.
   - O resumo para enviar (`GET /meetings/:id/resumo`, `renderResumo`) sai dos mesmos dados, só com itens aprovados.
   - Rejeitados são omitidos e propostos aparecem marcados.

6. **Busca e chat** (`apps/backend/src/search/`, specs/003)
   - Índice: `search_chunks` (trechos de transcrição `final` em janelas de ~180 palavras, narrativa da ata, itens, ADRs e metadados) e `search_index_state` (fila durável, um estado por reunião), no mesmo Postgres. Texto: `tsvector` com a configuração `pt_unaccent`; vetor: `vector(1024)` com HNSW parcial.
   - Indexação em duas fases (`indexer.ts`, `worker.ts`): **texto** (só banco, a qualquer momento) e **vetores** (`bge-m3` no Ollama com `num_gpu: 0`, 0 MiB de VRAM, RAM extra < 2,5 GB). O worker pega uma reunião por vez (alteração mais recente primeiro, depois a reunião mais recente), espera o debounce (`SEARCH_INDEX_DEBOUNCE_SECONDS`), **não calcula embeddings com reunião em `recording`/`stopping`/`joining`/`waiting_admission`/`in_call`**, usa hash do conteúdo mais o modelo para só recalcular o que mudou, espera 30 s, 2 min, 10 min, 1 h e 6 h entre falhas e marca `failed` na 5ª. No boot, `indexing` volta a `pending`; o backfill das reuniões antigas é o seed da migração (mais recente primeiro, retomável). Gatilhos: fim do pipeline e dos ADRs, passe final (a invalidação dos trechos de transcrição entra na mesma transação de `replaceWithFinal`), itens, ADRs, falantes, título, projeto.
   - Consulta (`query.ts`): léxica (`websearch_to_tsquery`, AND com reserva em OR) e vetorial (`hnsw.iterative_scan = relaxed_order`), fundidas por RRF (k = 60). **A permissão é aplicada na consulta**: `visibleMeetingsSql` + tipos permitidos pelo papel + item/ADR rejeitado fora, antes do `LIMIT`; o índice não guarda dono, e a hidratação do resultado reaplica a permissão. Sem Ollama (embeddings), pgvector ou modelo, a busca cai para texto e informa o motivo.
   - Chat (`chat/`): recupera pela mesma consulta, descarta o que não passa de `CHAT_MIN_SIMILARITY` (ou de acerto léxico estrito), monta o prompt com trechos delimitados como dados, chama o **LLM externo** do `LLM_GENERATION_PROVIDER` (`generate("post", …, provider)`; exige `ALLOW_EXTERNAL_LLM=true`; assinatura `claude`/`codex` só vale se o dono de cada reunião citada é o dono do host-agent, e entra na fila de um CLI por vez; sem LLM utilizável a busca segue e o chat responde 503 com o motivo), e **valida** cada citação (`ref` existente, `quote` literal conferida); sem citação válida, "não encontrei". Histórico só no cliente.
   - Consumo: embeddings (`busca`) e chat (`chat`) entram em `ai_usage_logs` (embeddings: provedor `ollama`; chat: o provedor do LLM externo), sem conteúdo.

O detalhamento do agente arquiteto (prompts, janelas, validação, deduplicação, schemas e onde alterar)
está em [`agente-arquiteto.md`](agente-arquiteto.md).

## Segurança e privacidade

- UI em `127.0.0.1`; sessões em cookie `httpOnly` (scrypt); `requireSameOrigin` nas mutações.
- **RBAC:**
  - `roles` / `permissions` / `role_permissions` / `user_roles`, com a matriz em `authz/matrix.ts` e seed idempotente na migração;
  - `requirePermission` em cada rota;
  - usuário desativado perde as sessões e não entra mais.
- **Isolamento por dono:**
  - o dono é `meetings.created_by`, e `meeting_shares` concede leitura ou edição;
  - `router.param` (`meetingParamGuard`/`childParamGuard`) confere o acesso antes de qualquer rota com `:id`/`:itemId`;
  - sem acesso, a resposta é 404; só leitura tentando escrever recebe 403;
  - listas, agenda e projetos usam `visibleMeetingsSql`;
  - o WebSocket só entrega eventos a quem tem acesso;
  - gestão de compartilhamento (`shares/`): `GET|POST /meetings/:id/shares`, `PUT|DELETE /meetings/:id/shares/:userId`, `GET /users/lookup`, `POST|DELETE /shared-with-me/:meetingId[/seen]`. As rotas de gestão estão em `OWNER_ONLY_ANY_METHOD` (`authz/ownerOnly.ts`): dono em qualquer método, inclusive `GET`, e cada função de `shares/service.ts` confere `created_by` de novo (404 sem acesso, 403 para destinatário, também para admin sem relação);
  - revogação imediata: `LiveHub.revokeAccess` invalida a audiência, remove a assinatura do usuário e só então envia o evento direcionado `meeting_access` (sem esperar o `sweep` de 30 s); excluir a reunião avisa os destinatários (`deleted`);
  - os campos por espectador (`access`, `ownerName`, `shareCount`, `shareUnseen`) existem só em `MeetingListItem` (`GET /meetings`, `/agenda`); o resumo difundido `meeting` continua igual para todos;
  - a busca de usuário devolve só `id`, `username`, `name`, `canEdit` (prefixo, mínimo 3 letras, até 8, 30 por minuto por usuário); a lista de acessos é só do dono; auditoria `meeting_share_*` só com ids.
- **Tarefas pessoais (`tasks/`, specs/002):**
  - `tasks` e `task_history` (aditivo em `schema.ts`); permissões `tasks.read`/`tasks.manage` em `OWN_CONTENT` (Leitor sem elas);
  - o dono é `tasks.owner_id` e **toda** consulta do módulo filtra por ele (`TASK_SELECT` só é usado depois de `t.owner_id = $1`; `test/tasks-scope.test.ts` falha se uma consulta perder o escopo);
  - `router.param("taskId")` (`taskParamGuard`) devolve 404 a id inválido, inexistente ou de outro dono, também para ADMIN, SUPER_ADMIN e quem tem `meetings.read_all`; não existe rota que liste tarefa alheia;
  - a tarefa copia o texto e um instantâneo da origem (reunião, item, citação) enquanto o dono tinha acesso; título atual, item e links só saem se `visibleMeetingsSql` ainda o permite, e revogar o compartilhamento ou excluir a reunião (`ON DELETE SET NULL`) mantém a tarefa sem o vínculo;
  - fluxo aprovar → tarefa: `POST /items/:itemId/approve` chama `createFromApproval` depois do commit da revisão (pendência do próprio aprovador ou sem responsável, `isSelfOwner`); falha da tarefa nunca desfaz a aprovação. `POST /tasks/from-item` (leitura da reunião + `meetings.read` + `tasks.manage`) serve ao botão "Virar tarefa". Uma tarefa por `(item, dono)` (índice único parcial + `ON CONFLICT DO NOTHING`) e dedup por Jaccard (`agent/dedup.ts`) na mesma reunião;
  - só item `aprovado` vira tarefa; sem IA, sem rede e sem WebSocket nesta feature; `audit_log` registra `task_created_from_item` só com ids.
- **Host-agent:**
  - grava só as reuniões do dono (`AGENT_OWNER`; vazio = primeiro usuário cadastrado, se ainda for SUPER_ADMIN ativo — o dono nunca passa sozinho para outra pessoa);
  - o heartbeat e o "não gravar" do agente são limitados a esse dono.
- **Arquivos de perfil:**
  - ficam em `DATA_DIR/profiles/<userId>/`;
  - o tipo é conferido pelos bytes iniciais (sem SVG);
  - nomes seguem um padrão fixo (sem path traversal) e a gravação usa modo 0600.
- **Uso e custo de IA (F6):** o funil `llm/index.ts#generate` e os três pontos de ASR (Whisper final no
  `pipeline.ts`, ao vivo agregado em `usage/liveAsr.ts`, Deepgram em `asr/openrouter.ts`) gravam uma linha por
  chamada em `ai_usage_logs` (só metadados e números, append-only; falha de gravação nunca derruba a geração).
  O custo é o informado pelo provedor, nunca calculado. `GET /usage/me` e `/usage/me/calls` leem só `user_id = eu`
  (reunião compartilhada não entra); `GET /admin/usage` (`ai_usage.read`) agrega sem nenhum campo de reunião.
  Só leitura, não limita geração.
- **Auditoria visível:** `GET /audit/me` (ator ou alvo, lista fechada de tipos) e `GET /admin/audit` (`audit.read`)
  passam pela projeção `audit/projection.ts` (lista permitida de campos por tipo, default deny; `meetingId` e título
  nunca). Login, falha de login (IP só na falha), logout e troca de senha são auditados; `external_llm` e
  `external_asr` gravam o dono da reunião.
- **Retenção (constituição 2.3.0):** `retention/prune.ts` poda `ai_usage_logs` (730 dias) e `audit_log` (365 dias) todo
  dia, em lotes e com trava no banco; `0` desliga. O histórico `external_*` antigo do `audit_log` é incorporado uma
  vez (`usage/backfill.ts`, idempotente).
- **Ações administrativas:** criar, editar, trocar papel, ativar, redefinir senha e redefinir configurações; todas vão para `audit_log`.
- host-agent autenticado por `AGENT_TOKEN` (Bearer, comparação em tempo constante, limite de
  falhas auditado).
- Egress guard em `globalThis.fetch`:
  - só alcança os hosts do `EGRESS_ALLOWLIST`;
  - com `ALLOW_EXTERNAL_ASR=true`, também o endpoint `/api/v1/audio/transcriptions` do
    OpenRouter (só https);
  - com `ALLOW_EXTERNAL_LLM=true`, também `/api/v1/chat/completions`;
  - bloqueios e envios externos vão para `audit_log`, sem conteúdo.
- Não há LLM local: todo LLM é externo e exige `ALLOW_EXTERNAL_LLM=true` (constituição 3.0.0). Sem a
  flag, ata, itens e ADRs não são gerados (a transcrição e a gravação seguem) e a interface avisa.
  - Provedores: `claude` (padrão de `LLM_GENERATION_PROVIDER`) e `codex`, pela assinatura pessoal do dono
    (`llm/hostCli.ts`), ou `openrouter` (`llm/openrouter.ts`); escolhido a cada pedido ou por
    `LLM_GENERATION_PROVIDER`.
  - Assinatura: o backend põe o pedido numa fila em memória (`llm/hostJobs.ts`); o host-agent
    busca por long-poll (`GET /api/agent/llm/next`), roda `claude -p` ou `codex exec` isolado
    (`host_agent/llm_runner.py`) e devolve o JSON (`POST /api/agent/llm/:id/result`). O backend
    nunca vê credenciais, e só as reuniões do `AGENT_OWNER` usam a assinatura.
  - A análise ao vivo usa o mesmo provedor da geração; nenhum LLM entra na fila da GPU.
- Caminhos de áudio montados a partir de UUID e canal validados; o worker recusa caminhos fora
  de `/data/audio`.

## GPU (RTX 4050, 6 GB)

| Carga | VRAM medida |
|---|---|
| faster-whisper large-v3-turbo int8_float16 | ~1,4 GB |
| pyannote community-1 (só no passe final) | carregado sob demanda |
