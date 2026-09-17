---
description: "Tarefas do MVP do Agente Local de Reuniões"
---

# Tasks: Agente Local de Reuniões — MVP

**Input**: documentos de design em `specs/001-agente-reunioes-mvp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: a Constituição (princípio VII) exige teste automatizado quando viável. Por isso há
tarefas de teste para os módulos puros (Vitest/pytest), escritas antes da implementação de cada
módulo.

**Organization**: tarefas agrupadas por user story (US1–US6 da spec).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1…US6

## Path Conventions

Monorepo, conforme o plan.md:
- `apps/backend/src/`, `apps/frontend/src/`
- `apps/worker-gpu/src/worker_gpu/`, `apps/host-agent/src/host_agent/`
- `packages/contracts/src/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: reestruturar em monorepo, remover dependências externas e preparar ferramentas.

- [X] T001 Mover `bot/` para `apps/backend/` (com `mv`, preservando `package-lock.json`) e atualizar as referências de caminho em `docker-compose.yml`, `README.md`, `CLAUDE.md` e `.gitignore`
- [X] T002 Criar `package.json` na raiz com npm workspaces (`apps/backend`, `apps/frontend`, `packages/contracts`) e os scripts `build`, `test`, `typecheck`. Regenerar o lock único na raiz com `npm install` e remover `apps/backend/package-lock.json`
- [X] T003 [P] Criar `packages/contracts/` (`package.json` com zod 4.6, `tsconfig.json`, `src/index.ts`) com saída CommonJS em `dist/`
- [X] T004 [P] Criar `apps/frontend/` com Vite 8 + React 19 + react-router 8 + TS (`package.json`, `vite.config.ts` com proxy `/api` e `ws` para `:3000`, `tsconfig.json`, `index.html`, `src/main.tsx`)
- [X] T005 [P] Criar `apps/worker-gpu/` com `pyproject.toml` (uv, Python 3.12):
  - dependências: fastapi 0.141, uvicorn 0.53, faster-whisper 1.2.1, pyannote.audio 4.0.7, nvidia-ml-py, numpy;
  - torch pelo índice cu12x (`[[tool.uv.index]]` explícito);
  - pytest e httpx em dev;
  - `src/worker_gpu/__init__.py`.
- [X] T006 [P] Criar `apps/host-agent/` com `pyproject.toml` (uv, Python 3.12; websockets 17, httpx 0.28; pytest e pytest-asyncio em dev) e `src/host_agent/__init__.py`
- [X] T007 Atualizar as dependências em `apps/backend/package.json`:
  - remover `@anthropic-ai/sdk` e `@deepgram/sdk`;
  - adicionar `ws`, `node-ical`, `zod` e `@meeting-bot/contracts` (workspace);
  - adicionar em dev `vitest`, `@types/ws`;
  - adicionar os scripts `test` e `test:db`.
- [X] T008 [P] Criar `apps/backend/vitest.config.ts` (testes em `apps/backend/test/**/*.test.ts`, ambiente node)
- [X] T009 Reescrever `apps/backend/Dockerfile` com contexto na raiz:
  - estágio de build com os workspaces (contracts → frontend → backend);
  - runtime Playwright com `dist/` do backend, `public/` = build do frontend e `node_modules` de produção;
  - ajustar `.dockerignore` na raiz.
- [X] T010 [P] Criar `apps/worker-gpu/Dockerfile`:
  - base `nvidia/cuda:12.8.1-base-ubuntu22.04`; cuBLAS 12 e cuDNN 9 vêm das wheels `nvidia-*` do torch cu128, expostas ao ctranslate2 via `LD_LIBRARY_PATH` (um único cuDNN);
  - uv, Python 3.12, `uv sync --frozen`;
  - ffmpeg (para o PyAV) e usuário não-root;
  - `HF_HOME=/models/hf` e `HEALTHCHECK` em `/health`;
  - `CMD uvicorn worker_gpu.main:app --host 0.0.0.0 --port 8000`.
- [X] T011 Atualizar `docker-compose.yml`:
  - serviço `bot` → `backend`, mantendo o volume `botdata`, com build na raiz e `TZ`;
  - adicionar env `WORKER_URL`, `OLLAMA_URL`, `AGENT_TOKEN`, `APP_TIMEZONE` e `USER_DISPLAY_NAME`;
  - trocar `whisper` por `worker-gpu`: `botdata:/data:ro`, volume `models:/models`, `HF_TOKEN`, `ASR_MODEL`, `ASR_COMPUTE_TYPE`;
  - `ollama` com `OLLAMA_KEEP_ALIVE=30m`;
  - `docker-compose.gpu.yml` com reserva de GPU para `worker-gpu` e `ollama`.
- [X] T012 Atualizar `.env.example` e `.env`:
  - remover `TRANSCRIPTION_PROVIDER`, `ASR_ENGINE`, `ASR_QUANTIZATION`, `WHISPER_*`, `DEEPGRAM_API_KEY`, `ANTHROPIC_*`;
  - adicionar `LOCAL_ONLY=true`, `AGENT_TOKEN` (gerado com `openssl rand -hex 32` no `.env`), `APP_TIMEZONE=America/Sao_Paulo`, `USER_DISPLAY_NAME=Sérgio`, `OLLAMA_MODEL=qwen3.5:4b`, `OLLAMA_KEEP_ALIVE=30m`, `ASR_MODEL=large-v3-turbo`, `ASR_COMPUTE_TYPE=int8_float16`, `LIVE_EXTRACT_*` e `EGRESS_ALLOWLIST`;
  - manter a permissão 600.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: banco, contratos, configuração, LLM local, worker de ASR, WebSocket da UI e casca
do frontend.

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase.

- [X] T013 Fazer backup do banco antes da migração: `docker compose exec postgres pg_dump -U meetingbot meetingbot > <scratchpad>/backup/pre-mvp.sql`, conferindo o tamanho não-zero
- [X] T014 Adicionar as migrações aditivas do data-model em `apps/backend/src/schema.ts`:
  - colunas novas de `meetings` e `transcript_segments`;
  - tabelas `projects`, `meeting_audio`, `meeting_speakers`, `meeting_notes`, `meeting_items`, `item_evidence`, `item_history`, `adrs` e `audit_log`;
  - índices;
  - seed idempotente dos 5 projetos;
  - backfill de `source` e de `meeting_audio` a partir de `audio_path`.
- [X] T015 [P] Definir em `packages/contracts/src/`:
  - `domain.ts`: status, rótulos, canais, tipos de item, categorias de risco, `MeetingSummary`, `Segment`, `Item`, `Adr`, `AgentMeeting`;
  - `events.ts`: eventos WS (ws-live e ws-audio);
  - `llm.ts`: `Extracao`, `Consolidacao`, `Narrativa`, `AdrSugerido`;
  - `index.ts` exportando tudo;
  - script `scripts/export-schemas.ts` gerando `packages/contracts/schemas/*.json`.
- [X] T016 Atualizar `apps/backend/src/types.ts`, reexportando os tipos de `@meeting-bot/contracts` e mantendo os tipos locais (`User`, `TERMINAL_STATUSES` ampliado)
- [X] T017 Atualizar `apps/backend/src/config.ts`:
  - remover `anthropic*`, `deepgram*`, `transcriptionProvider` e `whisper*`;
  - adicionar `workerUrl`, `ollamaUrl`, `ollamaModel`, `ollamaKeepAlive`, `localOnly`, `egressAllowlist`, `agentToken` (obrigatório, ≥ 32 caracteres), `appTimezone`, `userDisplayName`, `liveExtractMinSpeechSeconds`, `liveExtractMaxIntervalSeconds` e `liveConsolidateIntervalSeconds`.
- [X] T018 [P] Escrever `apps/backend/test/egress.test.ts`: host permitido passa, host externo lança "bloqueado (LOCAL_ONLY)" e chama o callback de auditoria
- [X] T019 [P] Implementar `apps/backend/src/security/egress.ts`: `installEgressGuard({allowlist, onBlocked})` embrulhando `globalThis.fetch`, mais `audit(kind, detail)` gravando em `audit_log`
- [X] T020 [P] Escrever `apps/backend/test/llm-provider.test.ts`: `createProvider("claude")` com `LOCAL_ONLY` lança erro e audita; `ollama` é aceito; o schema zod vira `format` JSON Schema
- [X] T021 Implementar a camada de LLM:
  - `apps/backend/src/llm/provider.ts`: interface `LLMProvider.generate<T>({system, user, schema, numCtx, priority})`, `createProvider`, fila serial com prioridade `live` > `post`;
  - `apps/backend/src/llm/ollama.ts`: `/api/chat` com `format`, `think:false`, `temperature:0`, `keep_alive`, 1 nova tentativa se a validação zod falhar, `unload()` com `keep_alive:0`, `ps()`.
- [X] T022 [P] Implementar `apps/worker-gpu/src/worker_gpu/audio.py`: `pcm_to_float32(bytes)`, `load_file(path)` via `faster_whisper.decode_audio`, `validate_path` (restrito a `/data/audio/`)
- [X] T023 [P] Implementar `apps/worker-gpu/src/worker_gpu/gpu.py`: `gpu_stats()` via pynvml (nome, utilização, memória), com `None` se o NVML não estiver disponível
- [X] T024 Implementar `apps/worker-gpu/src/worker_gpu/asr.py`:
  - `AsrEngine` carrega `WhisperModel(ASR_MODEL, device="cuda", compute_type)` no startup e `BatchedInferencePipeline`;
  - `transcribe_chunk(pcm, language, prompt)` com os parâmetros ao vivo do contrato e o `speech_seconds` do VAD;
  - `transcribe_file(audio, language, prompt, progress_cb)` com os parâmetros finais;
  - filtro de alucinações portado de `apps/backend/src/transcription.ts`;
  - lock de inferência.
- [X] T025 Implementar `apps/worker-gpu/src/worker_gpu/jobs.py`: fila serial de jobs em memória (máx. 20), status/step/progress, execução em thread, resultado por canal (sem diarização nesta tarefa)
- [X] T026 Implementar `apps/worker-gpu/src/worker_gpu/main.py` (FastAPI): `GET /health`, `GET /gpu`, `POST /transcribe/chunk` (validação de tamanho e paridade, ≤ 35 s), `POST /jobs/transcribe`, `GET /jobs/{id}`, conforme `contracts/worker-gpu.md`
- [X] T027 [P] Escrever `apps/worker-gpu/tests/test_api.py` com engine simulado: validação de corpo, formato de resposta do chunk, ciclo de job (`queued` → `done`), recusa de path fora de `/data/audio`
- [X] T028 Implementar `apps/backend/src/asr/workerClient.ts`: `health()`, `gpu()`, `transcribeChunk(pcm, opts)`, `startJob(files)`, `waitJob(id, onProgress)` com polling e nova submissão em 404/ECONNREFUSED (espera de até 15 min)
- [X] T029 Refatorar `apps/backend/src/transcription.ts` e `apps/backend/src/pipeline.ts`:
  - uploads e Modo Agente usam `workerClient` (canal `mixed`);
  - gravam `transcript_segments` com `channel`/`pass='final'` e `meeting_speakers`;
  - remover o código de Deepgram e do whisper-asr-webservice;
  - a etapa de ata chama um hook `runPostAnalysis`, no-op até a US4;
  - adicionar à fila o passo `processing` publicado no hub.
- [X] T030 Remover `apps/backend/src/ata.ts` e as referências a ele em `apps/backend/src/pipeline.ts` e `apps/backend/src/routes.ts` (`reprocess` aceita `all` e `analysis`)
- [X] T031 Implementar `apps/backend/src/live/hub.ts`:
  - `WebSocketServer({noServer:true})`, autenticação por cookie de sessão e `Origin` no `upgrade`;
  - assinaturas `agenda`/`meeting`;
  - `publishMeeting`, `publishToMeeting`, `publishAgenda`;
  - ping e fechamento `4401` quando a sessão expira.
- [X] T032 Atualizar `apps/backend/src/index.ts`:
  - `installEgressGuard` antes de tudo;
  - `http.createServer(app)` com roteador de `upgrade` por path (`/api/live` → hub; `/api/agent/audio` → reservado);
  - servir o `public/` do build React com fallback SPA (`index.html`) para rotas fora de `/api`.
- [X] T033 Criar a casca do frontend:
  - `apps/frontend/src/api.ts`: fetch com JSON, erros e redirecionamento em 401;
  - `apps/frontend/src/live.ts`: cliente WS único, com reconexão e assinaturas;
  - `apps/frontend/src/styles.css`: tokens claro e escuro portados de `apps/backend/public/styles.css`;
  - `apps/frontend/src/App.tsx`: rotas `/login`, `/`, `/reunioes`, `/reunioes/:id`, `/projetos`, layout com navegação e sessão.
- [X] T034 [P] Criar componentes base:
  - `apps/frontend/src/pages/Login.tsx`;
  - `apps/frontend/src/components/PasswordDialog.tsx`;
  - `apps/frontend/src/components/StatusBadge.tsx`;
  - `apps/frontend/src/components/Markdown.tsx` (portado de `renderMarkdown` em `apps/backend/public/app.js`, sem `dangerouslySetInnerHTML`);
  - `apps/frontend/src/components/Toast.tsx`.
- [ ] T035 Buildar e subir a stack (`docker compose build && docker compose up -d`). Conferir:
  - migração aplicada e dados antigos presentes (4 reuniões);
  - `/healthz`;
  - login na UI React;
  - worker `/health` com `device=cuda`;
  - upload de `scratchpad/audio/reuniao.wav` transcrito pelo worker-gpu.

  Rodar `npm test` e `npm run typecheck`.

**Checkpoint**: fundação pronta — upload funciona sem serviços externos.

---

## Phase 3: User Story 1 — Agenda do dia e alertas (Priority: P1) 🎯 MVP

**Goal**: importar `.ics` ou cadastrar reuniões, ver a tela Hoje e receber alertas nativos em
T-15/5/1 com Entrar e Não gravar.

**Independent Test**: quickstart V1. Importar um convite com início em T+16 min, fechar o
navegador e receber os 3 alertas; Entrar abre o link.

### Tests for User Story 1

- [X] T036 [P] [US1] Criar as fixtures em `apps/backend/test/fixtures/`:
  - `outlook-teams.ics`: TZID do Windows, ATTENDEE com CN, `X-MICROSOFT-SKYPETEAMSMEETINGURL`;
  - `recorrente.ics`: RRULE semanal com EXDATE e override por RECURRENCE-ID;
  - `cancelado.ics`: `METHOD:CANCEL`;
  - `dia-inteiro.ics`;
  - `meet.ics`: link do Meet na DESCRIPTION.
- [X] T037 [P] [US1] Escrever `apps/backend/test/ics.test.ts`: fuso correto, extração de link, participantes, expansão de ontem a +30 dias com EXDATE e override, cancelamento, dia inteiro ignorado, `recurrenceKey` estável
- [X] T038 [P] [US1] Escrever `apps/backend/test/calendar-service.test.ts` (funções puras): sugestão de projeto por título normalizado; regra de atualização por SEQUENCE e status; cálculo do intervalo do dia em `APP_TIMEZONE`
- [X] T039 [P] [US1] Escrever `apps/host-agent/tests/test_alerts.py`: horários de disparo 15/5/1, alerta atrasado > 60 s não dispara, deduplicação pela chave persistida, mudança de horário gera chave nova, reunião `skipped` só oferece Entrar

### Implementation for User Story 1

- [X] T040 [US1] Implementar `apps/backend/src/calendar/ics.ts`: `parseIcs(text, {from, to}) → Occurrence[]` com node-ical (`sync.parseICS`, `expandRecurringEvent`), extração de link, participantes, organizador, cancelamento e `sequence`
- [X] T041 [US1] Implementar `apps/backend/src/calendar/service.ts`:
  - `importIcs(files, userId)`: upsert em transação, com contadores `created`, `updated`, `cancelled`, `unchanged`, `ignored` e `errors`;
  - `suggestProject`;
  - `dayRange(date, tz)`, `getAgenda(date)`;
  - `createScheduled`, `updateScheduled`, `setSkip`;
  - `toMeetingSummary` com `statusLabel`.
- [X] T042 [US1] Implementar `apps/backend/src/agent/agentAuth.ts`:
  - middleware Bearer com `timingSafeEqual`;
  - limite de taxa para falhas, com `audit('agent_auth_failed')`;
  - verificação reutilizável no `upgrade`.
- [X] T043 [US1] Implementar `apps/backend/src/recording/hostAgentState.ts`:
  - estado em memória (`lastSeenAt`, versão, captura);
  - `isOnline()`;
  - publicação de `host_agent` no hub quando o estado muda.
- [X] T044 [US1] Criar as rotas em `apps/backend/src/routes.ts` e `apps/backend/src/agentRoutes.ts`:
  - `GET /agenda`, `POST /calendar/import` (multer em memória, `.ics` ≤ 2 MB, até 10 arquivos);
  - `POST /meetings/scheduled`, `PATCH /meetings/:id`, `POST /meetings/:id/skip`;
  - `GET /projects` (somente leitura por enquanto);
  - `POST /agent/heartbeat`, `POST /agent/meetings/:id/skip`;
  - montar `/api/agent` antes do `requireAuth` de cookie.
- [X] T045 [P] [US1] Implementar `apps/host-agent/src/host_agent/config.py`: leitura de `~/.config/agente-reunioes/config.toml` (`env_file`, `backend_url`, `spool_dir`, `state_dir`) e do `AGENT_TOKEN` no `.env` indicado
- [X] T046 [P] [US1] Implementar `apps/host-agent/src/host_agent/api.py`: cliente httpx assíncrono com `heartbeat(payload)` e `skip(meeting_id)`, timeout de 5 s e tolerância a backend offline
- [X] T047 [US1] Implementar `apps/host-agent/src/host_agent/alerts.py`: `AlertScheduler` puro (`due_alerts(now, meetings)`, persistência em `state_dir/alerts.json`), conforme R11
- [X] T048 [P] [US1] Implementar `apps/host-agent/src/host_agent/notifier.py`:
  - `notify(meeting, minutes)`: `notify-send -u critical -a … -A entrar=Entrar -A nao_gravar="Não gravar"` em thread, devolvendo a ação;
  - `modal(meeting)`: `zenity --question` com botão extra;
  - `SoundLoop`: `canberra-gtk-play` em loop até parar;
  - `conflict(meeting)`.
- [X] T049 [P] [US1] Implementar `apps/host-agent/src/host_agent/opener.py`: `open_url(url)` via `xdg-open`, aceitando só https
- [X] T050 [US1] Implementar `apps/host-agent/src/host_agent/main.py`:
  - loop asyncio com heartbeat a cada 5 s;
  - avaliação dos alertas a cada 1 s;
  - tratamento das ações (Entrar → `open_url`; Não gravar → `api.skip`);
  - log em stdout (journal);
  - entrypoint `agente-host` no `pyproject.toml`.
- [X] T051 [US1] Criar `apps/host-agent/systemd/agente-host.service` (`WantedBy`/`PartOf=graphical-session.target`, `Restart=on-failure`) e `apps/host-agent/install.sh`:
  - `uv sync`;
  - gerar o `config.toml` se não existir;
  - copiar a unit para `~/.config/systemd/user/`;
  - `daemon-reload` e `enable --now`.
- [X] T052 [US1] Criar `apps/frontend/src/pages/Hoje.tsx`: agenda do dia, navegação entre dias, faixa de status do host-agent e da gravação, eventos `agenda` do WS, cartões de `apps/frontend/src/components/AgendaItem.tsx` (horário, título, status, projeto, link Entrar, toggle Não gravar, Gravar agora)
- [X] T053 [P] [US1] Criar `apps/frontend/src/components/ImportIcs.tsx` (arrastar e soltar ou seletor múltiplo, com resumo do resultado) e `apps/frontend/src/components/MeetingForm.tsx` (título, data e hora, duração, link, projeto; criar e editar)
- [X] T054 [US1] Criar `scripts/fixture-ics.sh <minutos>`, que gera um `.ics` estilo Teams com início em T+N minutos e "Portal SES" no título, em `specs/001-agente-reunioes-mvp/fixtures/convite-teams.ics`
- [ ] T055 [US1] Validar o quickstart V1 no desktop real: instalar o host-agent, importar a fixture, receber os 3 alertas com o navegador fechado, testar Entrar e Não gravar, reimportar sem duplicar. Registrar o resultado.

**Checkpoint**: US1 funcional e testada de forma independente.

---

## Phase 4: User Story 2 — Gravação automática e transcrição ao vivo (Priority: P1)

**Goal**: gravar mic e remoto automaticamente no horário, mostrar a transcrição progressiva e
parar pela regra (3 min de silêncio após o fim previsto), por Parar ou pelo limite de 4 h.

**Independent Test**: quickstart V2 (inclui reiniciar o backend durante a gravação).

### Tests for User Story 2

- [X] T056 [P] [US2] Escrever `apps/backend/test/chunker.test.ts` com PCM sintético (tom e silêncio): corta na pausa ≥ 500 ms depois de 8 s, força o corte aos 30 s no ponto de menor energia, marca trecho silencioso, offsets contínuos, reset por offset
- [X] T057 [P] [US2] Escrever `apps/backend/test/scheduler.test.ts` (função pura `decide(now, state)`):
  - escolha da reunião a iniciar;
  - conflito;
  - `missed`;
  - parada por silêncio após o fim (com mínimo de 3 min gravando);
  - parada manual e parada por 4 h;
  - host-agent offline após o fim;
  - `skipped` não inicia.
- [X] T058 [P] [US2] Escrever `apps/host-agent/tests/test_capture.py`: preenchimento com zeros pelo relógio (lacuna > 200 ms), escrita no spool, reinício após troca de dispositivo (`pactl` simulado), estado `unavailable` após 5 falhas
- [X] T059 [P] [US2] Escrever `apps/host-agent/tests/test_uploader.py` com servidor WS falso: retoma do `offset` do `ready`, envia frames pares ≤ 64 KB, `end`/`ended`, reconexão com backoff, para ao receber 4409

### Implementation for User Story 2

- [X] T060 [US2] Implementar `apps/backend/src/recording/chunker.ts` conforme R3 (classe `Chunker` com `push(buf)` → `Chunk[] {offsetBytes, pcm, silent}` e `flush()`)
- [X] T061 [US2] Implementar `apps/backend/src/recording/scheduler.ts`:
  - `decide()` puro;
  - `startScheduler()` com tick de 5 s sob `pg_advisory_xact_lock`;
  - transições (`scheduled` → `recording` → `stopping`, `missed`);
  - aguardar os canais em `stopping` (até 120 s);
  - chamar `finalizeRecording`;
  - publicar `meeting` e `recording` (a cada 2 s, com `elapsed`, `lastSpeechAt`, `lag`, canais).
- [X] T062 [US2] Implementar `apps/backend/src/recording/audioIngest.ts`:
  - `upgrade` em `/api/agent/audio` com `agentAuth`;
  - validação da reunião (`recording`/`stopping`) e do canal;
  - arquivo PCM em append;
  - `ready` com offset par, `ack` por segundo após `fsync`, `end`/`ended`;
  - substituição de conexão (4001) e códigos 4400/4404/4409;
  - atualizar `meeting_audio.bytes`;
  - repassar os frames à `LiveSession`.
- [X] T063 [US2] Implementar `apps/backend/src/recording/liveSession.ts`:
  - uma sessão por (reunião, canal);
  - `Chunker` com fila;
  - chama `workerClient.transcribeChunk`;
  - grava os segmentos `live` com o tempo absoluto (`offset/32000 + start`) e o rótulo `user`/`Remoto`;
  - atualiza `last_speech_at` quando `speech_seconds > 0`;
  - calcula `lagSeconds`;
  - publica `segments`;
  - glossário = nomes de projetos e participantes.
- [X] T064 [US2] Implementar `apps/backend/src/recording/finalize.ts`:
  - ffmpeg PCM → Opus 32 kbps por canal;
  - conferência com ffprobe (±1 s);
  - apagar o PCM;
  - atualizar `meeting_audio` (formato, bytes, duração) e `ended_at`;
  - sem nenhum áudio → `error` "Nenhum áudio recebido";
  - senão enfileirar o pipeline.
- [X] T065 [US2] Estender `apps/backend/src/pipeline.ts` para gravações locais:
  - job com `mic.ogg` e `remote.ogg` (`diarize` ainda desligado);
  - substituir os segmentos `live` pelos `final` em transação;
  - `meeting_speakers` (`user` → `USER_DISPLAY_NAME`, `Remoto`);
  - publicar `transcript_replaced` e `processing`.
- [X] T066 [US2] Criar as rotas em `apps/backend/src/routes.ts`:
  - `POST /meetings/:id/record` (409 com `conflictMeetingId`; 503 se o host-agent estiver offline);
  - `POST /meetings/:id/end` para gravação local (`stop_requested`);
  - `GET /meetings/:id` com `segments`, `speakers`, `audio`, `liveSummary`;
  - `GET /meetings/:id/audio?channel=` com Range;
  - `GET /system/status`;
  - `DELETE` bloqueado durante a gravação.
- [X] T067 [US2] Implementar `apps/backend/src/recording/gpuSampler.ts`: amostra `workerClient.gpu()` a cada 5 s enquanto houver gravação ou processamento e publica `gpu`
- [X] T068 [US2] Implementar `apps/host-agent/src/host_agent/capture.py`:
  - `ChannelCapture` com `parec` e spool;
  - relógio de parede com preenchimento de zeros;
  - observação de `pactl get-default-*` a cada 3 s;
  - reinício com backoff;
  - estados `recording`/`restarting`/`unavailable`;
  - `Recorder` coordenando os 2 canais e `stop()`.
- [X] T069 [US2] Implementar `apps/host-agent/src/host_agent/uploader.py`:
  - `ChannelUploader` com `websockets.asyncio.client.connect` e `Authorization`;
  - envio do spool a partir do offset (acompanhando o arquivo crescer);
  - `end` quando a captura parou;
  - reconexão;
  - tratamento de 4409;
  - apagar o spool depois de `ended`;
  - retomar spools pendentes no boot.
- [X] T070 [US2] Integrar em `apps/host-agent/src/host_agent/main.py`:
  - convergir para `recording` do heartbeat (iniciar, parar, trocar);
  - enviar o estado de captura no heartbeat;
  - notificar o início da gravação e conflitos.
- [X] T071 [US2] Criar `apps/frontend/src/pages/Reuniao.tsx` (modo ao vivo):
  - cabeçalho com título, status, participantes e projeto;
  - `apps/frontend/src/components/LivePanel.tsx`: tempo decorrido, estado dos canais, atraso, GPU e botões Parar/Gravar;
  - `apps/frontend/src/components/Transcript.tsx`: segmentos com rolagem automática, nome do falante e clique para tocar o áudio no tempo;
  - players de áudio por canal.
- [ ] T072 [US2] Validar o quickstart V2 no desktop real:
  - início automático;
  - texto em ≤ 20 s nos dois canais;
  - parada por silêncio;
  - Parar;
  - `docker compose restart backend` durante a gravação sem lacuna.

  Medir o atraso p90 e registrar.

**Checkpoint**: US1 + US2 entregam gravação e transcrição locais completas (MVP mínimo utilizável).

---

## Phase 5: User Story 3 — Agente arquiteto ao vivo (Priority: P2)

**Goal**: extração periódica com evidência e consolidação a cada 15 min, com painéis paralelos.

**Independent Test**: quickstart V3 (roteiro com decisão, risco, RNF e pendência).

### Tests for User Story 3

- [X] T073 [P] [US3] Escrever `apps/backend/test/evidence.test.ts`: remove ids inexistentes e de contexto, descarta item sem id válido, citação com < 60% de tokens é descartada, normalização de acentos e pontuação, `categoria` só vale para `risco`
- [X] T074 [P] [US3] Escrever `apps/backend/test/dedup.test.ts`: Jaccard ≥ 0,55 no mesmo tipo mescla; tipos diferentes não mesclam; item rejeitado absorve em silêncio; stopwords pt-BR
- [X] T075 [P] [US3] Escrever `apps/backend/test/live-agent.test.ts` (gatilho puro `shouldExtract`/`shouldConsolidate`): 90 s de fala nova, 180 s com pelo menos 1 segmento, sem segmento novo não dispara, consolidação a cada 900 s

### Implementation for User Story 3

- [X] T076 [US3] Implementar `apps/backend/src/agent/prompts.ts`:
  - prompts de sistema pt-BR (extração, consolidação, narrativa, ADR), com a transcrição tratada como dado;
  - `formatWindow(segments, contextSegments, speakerNames)` → texto com `S<n>` e mapa id;
  - estimativa de tokens (chars/3,5).
- [X] T077 [US3] Implementar `apps/backend/src/agent/evidence.ts`: `validateExtraction(extracao, windowMap) → ValidItem[]`, conforme llm-schemas §1
- [X] T078 [US3] Implementar `apps/backend/src/agent/dedup.ts`: `normalizeTokens`, `jaccard` e `findDuplicate(item, existing)`
- [X] T079 [US3] Implementar `apps/backend/src/items/service.ts` (parte da IA):
  - `createAiItems(meetingId, validItems, origin)` em transação, com evidência e histórico `created`;
  - `mergeInto(keepId, removeIds)` com histórico `merged`;
  - `listItems(meetingId)` com evidência;
  - publicar `items`/`items_removed`.
- [X] T080 [US3] Implementar `apps/backend/src/agent/liveAgent.ts`:
  - `LiveAgent` por reunião em gravação: cursor e gatilhos;
  - chamada de extração (prioridade `live`, `num_ctx` 4096);
  - validação, deduplicação e persistência;
  - `meeting_notes` (`window`);
  - consolidação (resumo corrente → `meetings.live_summary`, publicar `summary`; mesclas);
  - consolidação final no `stopping`;
  - reconstrução do estado no boot;
  - integrar ao `scheduler.ts`.
- [X] T081 [US3] Criar a rota `GET /meetings/:id/items` em `apps/backend/src/routes.ts`
- [X] T082 [US3] Criar `apps/frontend/src/components/ItemsBoard.tsx`:
  - painéis paralelos Decisões, Decisões arquiteturais, Pendências, Riscos (com categoria), Requisitos (RF/RNF) e Outros (regra de negócio, restrição, premissa, pergunta, débito);
  - `apps/frontend/src/components/ItemCard.tsx`: descrição, responsável, prazo, selo proposto/aprovado, evidência clicável que rola até o segmento e toca o áudio;
  - caixa "Resumo corrente" em `Reuniao.tsx`;
  - atualização pelos eventos `items`, `items_removed` e `summary`.
- [ ] T083 [US3] Criar `scripts/roteiro-arquitetura.md` (o texto do roteiro do spike, para ler em voz alta ou tocar) e validar o quickstart V3: itens em ≤ 3 min, evidência correta, resumo aos 15 min. Registrar a precisão (SC-005).

**Checkpoint**: agente ao vivo funcionando sobre a US2.

---

## Phase 6: User Story 4 — Pós-reunião: transcrição final, ata e ADRs (Priority: P2)

**Goal**: passe final com diarização, remapeamento de evidência, análise map-reduce, ata no
template de 19 seções e ADRs sugeridos.

**Independent Test**: quickstart V4.

### Tests for User Story 4

- [X] T084 [P] [US4] Escrever `apps/backend/test/remap.test.ts`: maior sobreposição no mesmo canal, fallback para o mais próximo em ≤ 10 s, sem candidato → `segment_id` null com tempos mantidos
- [X] T085 [P] [US4] Escrever `apps/backend/test/ata-render.test.ts`: 19 seções na ordem, "Nada registrado" em seções vazias, rejeitados omitidos, marca "(proposto)", nomes de falantes aplicados, ADR com código só se aprovado, seção Responsáveis agrupada, Próximas ações = pendências abertas
- [X] T086 [P] [US4] Escrever `apps/backend/test/post-analysis.test.ts` com provider falso: divisão em chunks com sobreposição, itens finais duplicados de itens ao vivo são absorvidos (o ao vivo prevalece), ADR gerado só para `decisao_arquitetural` não rejeitada
- [X] T087 [P] [US4] Escrever `apps/worker-gpu/tests/test_diarize.py` com turnos simulados: rótulo pela maior sobreposição, numeração `Speaker N` por ordem de primeira fala, `unavailable` sem `HF_TOKEN`

### Implementation for User Story 4

- [X] T088 [US4] Implementar `apps/worker-gpu/src/worker_gpu/diarize.py`:
  - `Diarizer.available()` (checa `HF_TOKEN` ou cache);
  - `run(audio_float32)` carrega `Pipeline.from_pretrained(..., token=)` na GPU, recebe waveform em memória, devolve turnos e libera a memória;
  - `assign_speakers(segments, turns)`;
  - integrar em `jobs.py` (step `diarizando`) e `/health`.
- [X] T089 [US4] Implementar `apps/backend/src/agent/remap.ts`: `remapEvidence(evidence, finalSegments)`, conforme o data-model
- [X] T090 [US4] Atualizar o passe final em `apps/backend/src/pipeline.ts`:
  - `llm.unload()` antes do job com `diarize:true` para o canal `remote`/`mixed`;
  - transação: insere `final`, remapeia `item_evidence` (histórico `evidence_remapped`), apaga `live`;
  - semear `meeting_speakers` (`Speaker N`);
  - `transcribed_at`.
- [X] T091 [US4] Implementar `apps/backend/src/agent/postAnalysis.ts`:
  - chunks (~2 000 tokens, sobreposição de 2);
  - extração por chunk (prioridade `post`, `num_ctx` 8192) com `meeting_notes` (`chunk`);
  - validação e deduplicação contra os itens existentes (o ao vivo prevalece);
  - consolidação final;
  - narrativa → `meetings.analysis`/`analyzed_at`;
  - `AdrSugerido` por decisão arquitetural → `adrs` (upsert por `item_id`, preservando ADR já aprovado);
  - publicar `processing`, `items` e `adrs`;
  - ligar ao hook `runPostAnalysis`.
- [X] T092 [US4] Implementar `apps/backend/src/ata/render.ts`: `renderAta(meeting, items, adrs, speakers, analysis)` → Markdown com as 19 seções do template (FR-026/027) e aviso para atas antigas (`legacyAta`)
- [X] T093 [US4] Criar as rotas em `apps/backend/src/routes.ts`:
  - `GET /meetings/:id/ata`, `GET /meetings/:id/ata.md` (download);
  - `GET /meetings/:id/adrs`;
  - `PATCH /meetings/:id/speakers/:label`, que publica `meeting` e recarrega;
  - `POST /meetings/:id/reprocess` com `step=analysis`.
- [X] T094 [US4] Criar no frontend:
  - `apps/frontend/src/components/AtaView.tsx`: Markdown com Copiar e Baixar .md;
  - `apps/frontend/src/components/Speakers.tsx`: renomear rótulos;
  - `apps/frontend/src/components/AdrList.tsx`: visualização;
  - abas Ata / Transcrição / Itens / ADRs / Áudio em `Reuniao.tsx`;
  - indicador de etapa de processamento.
- [ ] T095 [US4] Pedir ao usuário o `HF_TOKEN` com os termos de `pyannote/speaker-diarization-community-1` aceitos. Validar o quickstart V4 com áudio real de 2+ vozes remotas e medir o tempo do pós-reunião de 1 h (SC-004), registrando o resultado. Sem token, validar o fallback "Remoto".

**Checkpoint**: fluxo completo gravação → ata.

---

## Phase 7: User Story 5 — Revisão humana (Priority: P2)

**Goal**: editar, aprovar, rejeitar e reabrir itens e ADRs, com histórico e numeração de ADR na
aprovação.

**Independent Test**: quickstart V5.

### Tests for User Story 5

- [X] T096 [P] [US5] Escrever `apps/backend/test/items-review.test.ts` (Postgres de teste via `TEST_DATABASE_URL`; o script `test:db` sobe e remove um container Postgres descartável, sem tocar o banco da aplicação):
  - histórico só com os campos alterados;
  - transições válidas e inválidas;
  - item manual nasce aprovado;
  - ADR recebe número sequencial só ao aprovar, sem duplicar em aprovações concorrentes;
  - rejeitar mantém o número.

### Implementation for User Story 5

- [X] T097 [US5] Completar `apps/backend/src/items/service.ts` (parte de revisão):
  - `editItem` (diff → `item_history`);
  - `approveItem`, `rejectItem`, `reopenItem`;
  - `createManualItem` (evidência opcional);
  - `getHistory`;
  - `editAdr`, `approveAdr` (advisory lock + `MAX(number)+1`), `rejectAdr`;
  - publicar eventos.
- [X] T098 [US5] Criar as rotas em `apps/backend/src/routes.ts`: `PATCH /items/:id`, `POST /items/:id/{approve,reject,reopen}`, `GET /items/:id/history`, `POST /meetings/:id/items`, `PATCH /adrs/:id`, `POST /adrs/:id/{approve,reject}`, com validação zod dos corpos
- [X] T099 [US5] Criar a revisão no frontend:
  - ações em `ItemCard.tsx` (editar inline, aprovar, rejeitar, reabrir);
  - `apps/frontend/src/components/ItemHistory.tsx`;
  - `apps/frontend/src/components/NewItemForm.tsx`;
  - filtros por status em `ItemsBoard.tsx`;
  - edição e aprovação em `AdrList.tsx`;
  - estilos distintos para proposto, aprovado e rejeitado.
- [ ] T100 [US5] Validar o quickstart V5: histórico correto, reflexo na ata, `ADR-001` na aprovação

**Checkpoint**: Constituição III atendida de ponta a ponta.

---

## Phase 8: User Story 6 — Projetos, upload e Modo Agente (Priority: P3)

**Goal**: CRUD de projetos, histórico de reuniões, upload e Modo Agente com a análise local
nova.

**Independent Test**: quickstart V6.

- [X] T101 [US6] Criar as rotas de projetos em `apps/backend/src/routes.ts` (`POST /projects`, `PATCH /projects/:id`, `DELETE /projects/:id`, `meetingCount` no `GET`) e o filtro `projectId` em `GET /meetings`
- [X] T102 [P] [US6] Criar `apps/frontend/src/pages/Projetos.tsx`: lista, criação, edição de nome e palavras-chave, exclusão com confirmação em modal da própria UI (sem `window.confirm`)
- [X] T103 [P] [US6] Criar `apps/frontend/src/pages/Reunioes.tsx`: histórico com filtro por projeto e status, formulário de upload e formulário do Modo Agente (portados de `apps/backend/public/app.js`), botões de reenvio e exclusão
- [X] T104 [US6] Adicionar em `apps/frontend/src/pages/Reuniao.tsx`: seletor de projeto (confirma a sugestão), abas de debug do Modo Agente (screenshot) e ações Reprocessar e Excluir
- [X] T105 [US6] Conferir em `apps/backend/src/pipeline.ts` que upload e Modo Agente rodam diarização (`mixed`) e `runPostAnalysis`, e que `apps/backend/src/bot/runner.ts` grava `meeting_audio` (`mixed`)
- [ ] T106 [US6] Validar o quickstart V6: projeto novo, upload de `reuniao.wav` com itens e ata, Modo Agente em reunião real do Teams (combinar com o usuário)

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T107 Remover o legado: `apps/backend/public/` (UI antiga — removida em 2026-09-16, cópia no backup pré-MVP) e a imagem `onerahmet/openai-whisper-asr-webservice` (com confirmação do usuário, 31,8 GB). Conferir que `grep -rEi "anthropic|deepgram" apps packages` não encontra nada.
- [X] T108 [P] Atualizar `README.md`: arquitetura, setup (host-agent, `HF_TOKEN`, pull do modelo), uso, limites e comandos de teste
- [X] T109 [P] Atualizar `docs/SPEC.md` e `docs/ARCHITECTURE.md` para a v0.3 (MVP do agente), apontando para `specs/001-agente-reunioes-mvp/`
- [ ] T110 [P] Atualizar `CLAUDE.md` (estrutura do monorepo, comandos) e `docs/analise/agente-local.md` (§15: resultados da validação do MVP e medições)
- [ ] T111 Validar o quickstart V7 (privacidade): egress bloqueado e auditado, `ss` sem conexões externas durante a gravação
- [X] T112 Rodar `npm run typecheck`, `npm test`, `uv run pytest` (host-agent e worker) e revisar o código (segurança: auth do agente, CSRF, path traversal no worker e no áudio, limites de upload)
- [ ] T113 Validação final V8 com reunião real do usuário (gate de pronto). Atualizar a memória do projeto.

---

## Phase 10: ASR externo de teste (FR-040/FR-041, pedido do usuário em 2026-09-16)

**Goal**: Deepgram nova-3 via OpenRouter como opção secundária no passe final e em uploads.

- [X] T114 Emendar a constituição (1.1.0) e registrar R21, FR-040/FR-041 e o cenário V9
- [X] T115 Configuração (`ALLOW_EXTERNAL_ASR`, `ASR_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_STT_MODEL`), coluna `meetings.asr_provider` e `.env.example`
- [X] T116 Egress guard com endpoints por caminho + testes em `apps/backend/test/egress.test.ts`
- [X] T117 `apps/backend/src/asr/openrouter.ts` (trechos Opus, repetições, diarização, auditoria) + `apps/backend/test/openrouter-asr.test.ts`
- [X] T118 Pipeline escolhe o provedor por reunião/padrão; rotas de upload e reprocessamento aceitam `asr`; `/auth/me` expõe as opções
- [X] T119 UI: escolha no upload e em "Reprocessar", avisos antes do envio e na reunião transcrita externamente
- [ ] T120 Validar o cenário V9 com a chave do usuário (upload curto em pt-BR, comparar com o Whisper local)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (1)**: sem dependências.
- **Foundational (2)**: depende de 1 e bloqueia todas as stories.
- **US1 (3)**: depende de 2.
- **US2 (4)**: depende de 2 e usa o heartbeat e o `hostAgentState` da US1 (T042–T044, T045–T046, T050).
- **US3 (5)**: depende da US2 (segmentos ao vivo e scheduler).
- **US4 (6)**: depende da US2 (gravação finalizada). O remapeamento de evidência só tem efeito com a US3, mas funciona sem ela.
- **US5 (7)**: depende da US3 ou da US4 (existência de itens).
- **US6 (8)**: depende de 2. A análise de upload depende da US4.
- **Polish (9)**: depois das stories desejadas.

### Within Each User Story

Testes primeiro (devem falhar), depois módulos puros, serviços, rotas, UI e validação real.

### Parallel Opportunities

- Setup: T003–T006, T008 e T010 em paralelo.
- Foundational: T018/T020/T022/T023/T027 em paralelo; T019 e T021 em paralelo entre si.
- US1: T036–T039 em paralelo; T045/T046/T048/T049 em paralelo; T053 em paralelo com T052.
- US2: T056–T059 em paralelo; backend (T060–T067) e host-agent (T068–T070) em paralelo.
- US3/US4: testes em paralelo. US4 (worker T088) em paralelo com o backend (T089–T092).

## Parallel Example: User Story 2

```bash
# Testes juntos:
Task: "T056 chunker.test.ts"   Task: "T057 scheduler.test.ts"
Task: "T058 test_capture.py"   Task: "T059 test_uploader.py"
# Implementação em duas frentes:
Frente backend:    T060 → T061 → T062 → T063 → T064 → T065 → T066 → T067
Frente host-agent: T068 → T069 → T070
```

## Implementation Strategy

### MVP First

1. Phases 1–2: fundação, com upload local funcionando.
2. Phase 3 (US1): agenda e alertas, validar V1.
3. Phase 4 (US2): gravação e transcrição ao vivo, validar V2. **Primeiro ponto de uso real.**

### Incremental Delivery

4. US3: insights ao vivo → V3.
5. US4: ata e ADRs → V4.
6. US5: revisão → V5.
7. US6: projetos, upload e agente → V6.
8. Polish → V7 e V8 (reunião real = pronto).

### Notes

- Commits só quando o usuário pedir: mensagens em português, sem assinatura de IA, diff revisado.
- As migrações são aditivas; o backup (T013) vem antes da primeira execução.
- Decisões de comportamento novas devem ser perguntadas ao usuário (Constituição VII).
