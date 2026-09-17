# Implementation Plan: Agente Local de Reuniões — MVP

**Branch**: `001-agente-reunioes-mvp` | **Date**: 2026-09-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-agente-reunioes-mvp/spec.md`

## Summary

O meeting-bot vira um monorepo com quatro partes. O backend Node/TS, que já existe, passa a
controlar a agenda, a gravação, o agente arquiteto e a ata. Entram três partes novas: um frontend
React, um `worker-gpu` em Python (faster-whisper + pyannote, que substitui o
whisper-asr-webservice) e um `host-agent` nativo em Python.

O host-agent faz o que só funciona na sessão gráfica:
- consulta a agenda no backend;
- emite os alertas (`notify-send`, `zenity`, som);
- abre o link (`xdg-open`);
- captura microfone e áudio remoto com `parec`, em dois canais PCM 16 kHz;
- grava cada canal num spool local e envia por WebSocket, retomando do offset confirmado pelo
  backend depois de uma queda.

O backend grava o PCM, corta trechos nas pausas (10–30 s) e envia cada trecho ao worker-gpu.
O texto chega à UI por WebSocket. A cada janela de ~90 s de fala nova, ou no máximo a cada 3 min,
o backend roda a extração no Ollama (`qwen3.5:4b`, JSON Schema), com validação de evidência e
deduplicação. A consolidação roda a cada 15 min.

Quando a reunião termina (regra de parada no backend):
1. o PCM é convertido para Opus;
2. o worker-gpu faz o passe final, com diarização do canal remoto;
3. os itens ao vivo são remapeados para os segmentos novos;
4. a análise map-reduce produz itens finais, narrativa da ata e ADRs sugeridos;
5. a ata é renderizada na hora da leitura, a partir do estado atual dos itens.

A revisão humana grava histórico. Tudo roda local: há uma proteção de saída (egress guard) no
backend, e as dependências Anthropic e Deepgram são removidas.

## Technical Context

**Language/Version**:
- Backend: Node 24 + TypeScript 5.9 (ES2022, CommonJS).
- Frontend: React 19 + Vite + TypeScript.
- worker-gpu e host-agent: Python 3.12 (`uv`).

**Primary Dependencies**:
- Backend: Express 5, `ws`, `pg`, `node-ical`, `zod` 4 (schemas + `toJSONSchema` para o
  Ollama), Playwright 1.63 (Modo Agente), helmet, express-rate-limit, multer, cookie-parser.
- Frontend: react, react-dom, react-router.
- worker-gpu: FastAPI, uvicorn, faster-whisper (`large-v3-turbo` int8), pyannote.audio
  (`speaker-diarization-community-1`, opcional via `HF_TOKEN`), nvidia-ml-py.
- host-agent: `websockets`, `httpx`; utilitários do sistema `parec`, `pactl`, `notify-send`,
  `zenity`, `canberra-gtk-play` e `xdg-open`.
- LLM: Ollama 0.32.14 em container, modelo `qwen3.5:4b`.

**Storage**:
- Postgres 16 (volume `pgdata`), com migrações idempotentes e aditivas.
- Áudio no volume `botdata` (`/data/audio/<meeting>/{mic,remote,mixed}.ogg`); o PCM é
  temporário durante a gravação.
- Spool do host-agent em `~/.local/share/agente-reunioes/spool`.

**Testing**:
- Vitest nos módulos puros do backend (ics, chunker, regra de parada, evidência, dedup,
  renderização da ata, egress guard, remapeamento) e em rotas com banco de teste.
- pytest no host-agent (agenda de alertas, spool/offset, preenchimento de lacunas) e no worker
  (API com modelo simulado).
- Smoke manual e validação com áudio e reunião reais (quickstart).

**Target Platform**:
- Ubuntu 26.04 (GNOME Wayland, PipeWire 1.6).
- Docker Engine nativo + NVIDIA Container Toolkit, RTX 4050 com 6 GB.

**Project Type**: aplicação web local (backend + frontend), mais um worker de ML e um agente
desktop nativo.

**Performance Goals**:
- Texto ao vivo em ≤ 20 s da fala (p90).
- Extração em ≤ 3 min da fala.
- Pós-reunião de 1 h em ≤ 15 min.
- Alertas com tolerância de ±30 s.

**Constraints**:
- `LOCAL_ONLY`; UI só em `127.0.0.1`.
- VRAM ≤ 6 GB: turbo int8 (~1,4 GB) + qwen3.5:4b com ctx 4k (~3,6 GB) durante a reunião.
- Uma gravação local por vez; limite de 4 h; áudio guardado sempre.

**Scale/Scope**:
- 1–2 usuários e ~5 reuniões/dia.
- Reuniões de até 4 h (~230 MB de PCM por canal durante a gravação, ~50 MB em Opus).
- ~8 telas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| I. Local-first | Ollama e worker-gpu locais. Remove `@anthropic-ai/sdk` e `@deepgram/sdk`. Egress guard no backend: `fetch` só alcança hosts permitidos (ollama, worker-gpu); bloqueios vão para `audit_log`. `HF_HUB_OFFLINE=1` depois do download. UI em `127.0.0.1`. Exceção 1.1.0: ASR externo de teste opt-in (R21), só no passe final/upload, endpoint único liberado e auditado. | ✅ |
| II. Políticas da org. | Sem Graph e sem leitura de e-mail; calendário por `.ics`/manual. Modo Agente mantém admissão manual e nome "Ata Bot - gravando". Nenhuma senha corporativa. | ✅ |
| III. Humano no controle | Itens e ADRs nascem `proposto`. Aprovar, editar e rejeitar gravam histórico. ADR só recebe número ao ser aprovado; sem exportação. UI diferencia proposto de aprovado. | ✅ |
| IV. Rastreabilidade | `item_evidence` → segmento. Descarte de itens sem evidência ou com citação que não confere. Remapeamento por tempo no passe final. `item_history`. Entidades separadas. | ✅ |
| V. GPU | Só modelos medidos (§14). Durante a reunião: turbo int8 + 4B ctx 4k. Diarização só no pós-reunião, com o Ollama descarregado (`keep_alive: 0`). Fila serial de LLM. Atraso sinalizado sem perder áudio (o spool garante). | ✅ |
| VI. Desktop nativo | host-agent em `systemd --user` (`graphical-session.target`), com alertas, captura e xdg-open. Serviços no Engine nativo. Token local compartilhado (`AGENT_TOKEN`) no loopback. A gravação independe do navegador. | ✅ |
| VII. Incremental | MVP apenas; busca, memória e Graph ficam fora. Testes automatizados nos módulos puros. Validação com áudio real e reunião real antes de declarar pronto. | ✅ |
| VIII. Stack | Node/TS, Python 3.12 (uv), React/Vite, Postgres. Contratos em zod → JSON Schema (`packages/contracts`). **Desvios justificados:** Redis e pgvector adiados (ver Complexity Tracking). | ⚠️ justificado |
| Regras operacionais | Regra de parada, retenção, canais separados, dois passes e login: todos contemplados. | ✅ |

Reavaliação pós-design (Phase 1): sem novas violações. O data model e os contratos mantêm
evidência obrigatória, o estado `proposto` e o bloqueio de egress.

## Project Structure

### Documentation (this feature)

```text
specs/001-agente-reunioes-mvp/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md          # API HTTP do backend (UI e host-agent)
│   ├── ws-live.md           # WebSocket UI ← backend (eventos ao vivo)
│   ├── ws-audio.md          # WebSocket host-agent → backend (PCM por canal)
│   ├── worker-gpu.md        # API HTTP do worker-gpu
│   └── llm-schemas.md       # Schemas de saída do LLM (extração, consolidação, ata, ADR)
├── checklists/requirements.md
└── tasks.md                 # /speckit-tasks
```

### Source Code (repository root)

```text
package.json                 # npm workspaces: apps/backend, apps/frontend, packages/contracts
docker-compose.yml           # backend, frontend build embutido, postgres, worker-gpu, ollama, caddy (profile)
docker-compose.gpu.yml       # reservas de GPU (worker-gpu, ollama)
.env.example
apps/
├── backend/                 # (ex-bot/) Node 24 + TS
│   ├── Dockerfile           # contexto = raiz; builda contracts + frontend + backend
│   ├── entrypoint.sh
│   ├── src/
│   │   ├── index.ts  config.ts  db.ts  schema.ts  types.ts  auth.ts  routes.ts
│   │   ├── security/egress.ts         # egress guard + audit
│   │   ├── calendar/ics.ts            # parse .ics → ocorrências
│   │   ├── calendar/service.ts        # upsert, agenda do dia, sugestão de projeto
│   │   ├── recording/scheduler.ts     # estado desejado, regra de parada, conflitos
│   │   ├── recording/audioIngest.ts   # WS /api/agent/audio, PCM em disco, offsets
│   │   ├── recording/chunker.ts       # corte por pausa (energia adaptativa), 10–30 s
│   │   ├── recording/liveSession.ts   # chunk → worker → segmentos → eventos
│   │   ├── recording/finalize.ts      # PCM → Opus
│   │   ├── asr/workerClient.ts        # cliente do worker-gpu
│   │   ├── llm/provider.ts            # interface LLMProvider + LOCAL_ONLY
│   │   ├── llm/ollama.ts
│   │   ├── agent/prompts.ts
│   │   ├── agent/evidence.ts          # validação de evidência (ids + citação)
│   │   ├── agent/dedup.ts
│   │   ├── agent/liveAgent.ts         # janelas de extração + consolidação
│   │   ├── agent/postAnalysis.ts      # map-reduce, reconciliação, ata, ADR
│   │   ├── agent/remap.ts             # evidência live → final por tempo
│   │   ├── ata/render.ts              # template §11 a partir do estado atual
│   │   ├── items/service.ts           # revisão + histórico + numeração de ADR
│   │   ├── pipeline.ts                # fila pós-reunião (upload, bot, gravação local)
│   │   ├── live/hub.ts                # WS /api/live para a UI
│   │   ├── bot/                       # Modo Agente (sem mudança de comportamento)
│   │   └── cli/user.ts
│   └── test/                          # vitest
├── frontend/                # React + Vite + TS
│   └── src/
│       ├── main.tsx  App.tsx  api.ts  live.ts  styles.css
│       ├── pages/{Login,Hoje,Reunioes,Reuniao,Projetos}.tsx
│       └── components/{AgendaItem,ImportIcs,MeetingForm,LivePanel,Transcript,ItemsBoard,ItemCard,AtaView,AdrList,Speakers,StatusBadge,Markdown,PasswordDialog}.tsx
├── worker-gpu/              # Python 3.12 + CUDA
│   ├── Dockerfile  pyproject.toml  uv.lock
│   ├── src/worker_gpu/{main.py,asr.py,diarize.py,jobs.py,gpu.py,audio.py}
│   └── tests/
└── host-agent/              # Python 3.12 nativo
    ├── pyproject.toml  uv.lock
    ├── src/host_agent/{main.py,config.py,api.py,alerts.py,notifier.py,capture.py,uploader.py,opener.py}
    ├── systemd/agente-host.service
    ├── install.sh
    └── tests/
packages/
└── contracts/               # zod: itens, eventos, agenda; script gera schemas/*.json
docs/                        # SPEC.md, ARCHITECTURE.md, analise/
scripts/setup-host.sh
```

**Structure Decision**: monorepo com npm workspaces para as partes em TS (backend, frontend e
contracts) e projetos `uv` independentes para as partes em Python. O Modo Agente continua dentro
do backend, que já roda na imagem do Playwright. Separar em outro container não traria ganho no
MVP. O frontend é buildado no Dockerfile do backend e servido como estático na mesma origem, o
que mantém o cookie de sessão e o CSRF simples. O worker-gpu substitui o serviço `whisper`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Redis/BullMQ adiado (VIII cita Redis para filas/eventos) | MVP tem um único processo backend e um único consumidor de GPU. Fila serial em memória + recuperação por status no boot (já validada) + `ws` direto para a UI bastam. | Redis adicionaria um serviço, um protocolo e pontos de falha sem ganho com um só processo. Entra na V1, com múltiplos workers e busca. |
| pgvector adiado (VIII cita Postgres + pgvector) | Embeddings e busca estão fora do MVP (spec). O `pgdata` atual é `postgres:16-alpine`. Trocar para a imagem Debian do pgvector no mesmo diretório arrisca corromper índices de texto (musl → glibc). | Trocar a imagem agora exigiria dump/restore sem nenhuma funcionalidade usando vetor. Na V1: dump → `pgvector/pgvector:pg16` → restore. |
