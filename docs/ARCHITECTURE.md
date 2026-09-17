# Arquitetura (v0.3 — MVP do agente local)

Detalhes, decisões e contratos: `specs/001-agente-reunioes-mvp/` (plan.md, research.md,
data-model.md, contracts/).

```text
 host (Ubuntu, systemd --user)                 Docker Engine nativo (contexto default)
┌──────────────────────────────┐              ┌──────────────────────────────────────────────┐
│ host-agent (Python 3.12)     │ POST         │ backend (Node 24, Express 5, ws)             │
│  heartbeat 5 s ◄─ recording ─┼─ /api/agent ►│  scheduler 5 s (advisory lock)               │
│  alertas T-15/5/1 (notify,   │  heartbeat   │  audioIngest → PCM → LiveSession → chunker   │
│   zenity, som, xdg-open)     │              │  LiveAgent (extração/consolidação)           │
│  parec mic + monitor → spool │ WS PCM ─────►│  finalize (ffmpeg → Opus) → pipeline         │
│  uploader com retomada       │ /api/agent/  │  postAnalysis → ata (render na leitura)      │
└──────────────────────────────┘   audio      │  UI React estática + WS /api/live            │
                                              │  Modo Agente (Playwright + PulseAudio)       │
 navegador ── cookie ── 127.0.0.1:3000 ──────►│  egress guard (LOCAL_ONLY + exceção de ASR)  │
                                              └───────┬──────────────┬──────────────┬────────┘
                                                      │              │              │
                                               postgres 16    worker-gpu        ollama
                                                              FastAPI           qwen3.5:4b
                                                              faster-whisper    JSON Schema
                                                              pyannote          (format)
```

## Serviços

| Serviço | Imagem | Papel |
|---|---|---|
| `backend` | build de `apps/backend/Dockerfile` sobre `mcr.microsoft.com/playwright:v1.63.0-noble` | API, UI, WebSockets, agendador, agente, ata, Modo Agente |
| `postgres` | `postgres:16-alpine` | persistência (`pgdata`) |
| `worker-gpu` | build de `apps/worker-gpu` sobre `nvidia/cuda:12.8.1-base` | `/transcribe/chunk` (ao vivo) e `/jobs/transcribe` (passe final + diarização) |
| `ollama` | `ollama/ollama:0.32.14` | LLM local (`qwen3.5:4b`) |
| `caddy` | `caddy:2-alpine` (profile `https`) | TLS quando exposto em rede |

Volumes: `botdata` (áudio, `/data`), `models` (Whisper e Hugging Face), `ollama`, `pgdata`.

## Fluxos

1. **Agenda**
   - `.ics`: o node-ical expande recorrências.
   - O upsert usa `(UID, RECURRENCE-ID)` e `SEQUENCE`.
   - Cadastro manual também entra na agenda.
   - O projeto é sugerido por palavra-chave.
2. **Gravação**
   - No horário, o scheduler põe o **assistente** (`bot/autoJoin.ts`) em toda reunião da agenda com link
     do Teams/Meet e sem "Não gravar": a reunião passa a `joining` e segue o Modo Agente (canal misto).
     A admissão espera até o fim previsto; limite de `MAX_CONCURRENT_BOTS` e um assistente por link.
   - O PC não grava sozinho (`AUTO_LOCAL_RECORDING=false`); a gravação local vem de **Gravar agora**.
   - Na gravação local, o scheduler decide a gravação desejada e o host-agent converge a partir do heartbeat.
   - O áudio é PCM s16le 16 kHz por canal, alinhado ao relógio de parede (lacunas viram zeros).
   - O envio é retomável pelo `offset`.
   - A parada acontece com o fim previsto + 180 s sem fala, com **Parar** ou em 4 h.
3. **Ao vivo**
   - O chunker corta por energia: pausa ≥ 500 ms depois de 8 s, ou força o corte em 30 s.
   - O worker aplica o VAD e o Whisper; os segmentos `live` são publicados no WS.
   - O LiveAgent roda a cada 90 s de fala ou 180 s e valida a evidência (ids `S<n>` + citação).
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
  - o WebSocket só entrega eventos a quem tem acesso.
- **Host-agent:**
  - grava só as reuniões do dono (`AGENT_OWNER`; vazio = primeiro usuário cadastrado, se ainda for SUPER_ADMIN ativo — o dono nunca passa sozinho para outra pessoa);
  - o heartbeat e o "não gravar" do agente são limitados a esse dono.
- **Arquivos de perfil:**
  - ficam em `DATA_DIR/profiles/<userId>/`;
  - o tipo é conferido pelos bytes iniciais (sem SVG);
  - nomes seguem um padrão fixo (sem path traversal) e a gravação usa modo 0600.
- **Ações administrativas:** criar, editar, trocar papel, ativar, redefinir senha e redefinir configurações; todas vão para `audit_log`.
- host-agent autenticado por `AGENT_TOKEN` (Bearer, comparação em tempo constante, limite de
  falhas auditado).
- Egress guard em `globalThis.fetch`:
  - só alcança os hosts do `EGRESS_ALLOWLIST`;
  - com `ALLOW_EXTERNAL_ASR=true`, também o endpoint `/api/v1/audio/transcriptions` do
    OpenRouter (só https);
  - com `ALLOW_EXTERNAL_LLM=true`, também `/api/v1/chat/completions`;
  - bloqueios e envios externos vão para `audit_log`, sem conteúdo.
- LLM local por padrão (`LLM_PROVIDER=ollama`; outros nomes são recusados e auditados).
  - Exceção opt-in (constituição 1.4.0): ata e ADRs podem ir ao OpenRouter
    (`llm/openrouter.ts`) ou à assinatura pessoal do dono (`llm/hostCli.ts`), escolhido a cada
    pedido ou por `LLM_GENERATION_PROVIDER`.
  - Assinatura: o backend põe o pedido numa fila em memória (`llm/hostJobs.ts`); o host-agent
    busca por long-poll (`GET /api/agent/llm/next`), roda `claude -p` ou `codex exec` isolado
    (`host_agent/llm_runner.py`) e devolve o JSON (`POST /api/agent/llm/:id/result`). O backend
    nunca vê credenciais, e só as reuniões do `AGENT_OWNER` usam a assinatura.
  - A análise ao vivo é sempre local; a geração externa não entra na fila da GPU.
- Caminhos de áudio montados a partir de UUID e canal validados; o worker recusa caminhos fora
  de `/data/audio`.

## GPU (RTX 4050, 6 GB)

| Carga | VRAM medida |
|---|---|
| faster-whisper large-v3-turbo int8_float16 | ~1,4 GB |
| qwen3.5:4b ctx 8k | ~3,0 GB na GPU (3,9 GB total) |
| pyannote community-1 (só no passe final) | carregado sob demanda; o LLM é descarregado antes |
