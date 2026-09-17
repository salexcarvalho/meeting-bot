# Quickstart — validação do MVP

Guia para provar, de ponta a ponta, que o MVP funciona. Os detalhes de API estão em
[contracts/](contracts/) e os de dados em [data-model.md](data-model.md).

## Pré-requisitos

- Docker Engine nativo (`docker context use default`) + NVIDIA Container Toolkit
  (`scripts/setup-host.sh`).
- `nvidia-smi` funcionando no host.
- Utilitários do host: `parec` e `pactl` (pulseaudio-utils), `notify-send`, `zenity`,
  `canberra-gtk-play`, `xdg-open`, `ffmpeg` e `uv`.
- `.env` baseado no `.env.example`, com:
  - `POSTGRES_PASSWORD` e `AGENT_TOKEN` (`openssl rand -hex 32`);
  - `USER_DISPLAY_NAME=Sérgio` e `APP_TIMEZONE=America/Sao_Paulo`;
  - `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml`;
  - opcional: `HF_TOKEN`, com os termos do modelo de diarização aceitos no Hugging Face.

## Subir

```bash
docker compose build
docker compose up -d
docker compose exec ollama ollama pull qwen3.5:4b      # primeira vez
docker compose ps                                       # todos healthy
curl -s localhost:3000/healthz                          # {"ok":true}
apps/host-agent/install.sh                              # uv sync + unit systemd --user
systemctl --user status agente-host                     # active (running)
```

Login: `http://127.0.0.1:3000`, com usuário criado por
`docker compose exec backend npm run user:create -- <usuario>`.

## Testes automatizados

```bash
npm test --workspaces --if-present            # vitest: backend (+ contracts)
(cd apps/host-agent && uv run pytest)
(cd apps/worker-gpu && uv run pytest)         # sem GPU: modelo simulado
npm run typecheck --workspaces --if-present
```

Resultado esperado: tudo verde.

## Cenários de validação

### V1 — Agenda e alertas (US1)

1. Na tela **Hoje**, importar `specs/001-agente-reunioes-mvp/fixtures/convite-teams.ics`
   (fixture criada nas tarefas; início em T+16 min, gerado pelo script
   `scripts/fixture-ics.sh 16`).
2. A reunião aparece como **Próxima**, com link do Teams, participantes e projeto sugerido
   ("Portal SES" no título).
3. Importar o mesmo arquivo de novo: o resultado é `updated`/`unchanged` e não aparece item
   duplicado.
4. Fechar o navegador. Em T-15, T-5 e T-1 aparecem as notificações com som. A de T-1 é um
   diálogo modal, com som repetido até a resposta.
5. Clicar em **Entrar** abre o link no navegador padrão.
6. Em outra reunião, clicar em **Não gravar**: o status muda para **Não gravada**.

### V2 — Gravação e transcrição ao vivo (US2)

1. Cadastrar uma reunião manual com início em T+2 min e duração de 5 min.
2. No horário, sem clicar em nada, o status vira **Em andamento** e o host-agent registra a
   captura nos dois canais.
3. Falar ao microfone e tocar um áudio no computador, por exemplo
   `pw-play scratchpad/audio/reuniao.wav`.
4. Em ≤ 20 s, o texto aparece na tela da reunião: a fala do microfone como "Sérgio" e o áudio
   tocado como "Remoto".
5. A tela mostra o tempo decorrido, os canais, o atraso e a GPU.
6. Ficar em silêncio após o fim previsto: em ~3 min, o status vira **Transcrevendo** e depois
   **Processando**.
7. Parada manual: repetir o cenário e clicar em **Parar** → gravação para em ≤ 10 s.
8. Resiliência: durante a gravação, rodar `docker compose restart backend`. Depois da volta, o
   áudio continua sem lacuna: a duração final é igual ao tempo de gravação ± 2 s.

### V3 — Agente ao vivo (US3)

1. Tocar no canal remoto o roteiro `fixtures/roteiro-arquitetura.wav`: decisão por Kafka, risco
   de prazo, RNF de p95 < 2 s, pendência do Marcos até sexta.
2. Em ≤ 3 min, os painéis Decisões arquiteturais, Riscos, Requisitos e Pendências mostram os
   itens.
3. Clicar em um item mostra o trecho de origem com horário. Não aparece item sem trecho.
4. Depois de 15 min de gravação, o "Resumo corrente" está preenchido.

### V4 — Pós-reunião (US4)

1. Ao terminar, a transcrição final substitui a ao vivo. Os itens continuam abrindo trechos
   válidos.
2. Com `HF_TOKEN`, vozes remotas distintas aparecem como Speaker 1 e Speaker 2. Renomear
   Speaker 1 para "Marcos" altera a transcrição e a ata.
3. A aba **Ata** tem as 19 seções do template. As seções vazias dizem "Nada registrado".
4. Há um ADR sugerido com status "proposto" e sem número.
5. **Copiar** e **Baixar .md** funcionam.
6. Tempo: para 1 h de áudio, o pós-reunião termina em ≤ 15 min (medir com
   `fixtures/reuniao-1h.ogg`).

### V5 — Revisão (US5)

1. Editar o responsável de uma pendência, aprovar uma decisão e rejeitar um risco.
2. O histórico do item mostra antes e depois, o autor e a data.
3. Na ata, o risco rejeitado some e os itens propostos aparecem marcados "(proposto)".
4. Aprovar o ADR: ele vira `ADR-001`.

### V6 — Projetos, upload e Modo Agente (US6)

1. Criar o projeto "Teste X" e associá-lo a uma reunião.
2. Enviar `scratchpad/audio/reuniao.wav` pelo upload: sai transcrição, itens e ata.
3. Modo Agente: enviar o bot para uma reunião real do Teams, admitir, falar e encerrar. O fluxo
   é igual ao de antes, agora com itens e ata locais.

### V7 — Privacidade (FR-038, SC-007)

1. `docker compose exec backend node -e "fetch('https://api.anthropic.com').catch(e=>console.log(e.message))"`
   deve mostrar "bloqueado (LOCAL_ONLY)", e o bloqueio aparece em `audit_log`.
2. Durante uma gravação, rodar
   `sudo ss -tnp | grep -E 'backend|worker|ollama|host_agent'`: não há conexões para fora de
   127.0.0.1 ou da rede do compose. O Chromium do Modo Agente é a exceção, porque a própria
   reunião é externa.
3. `grep -rE "anthropic" apps/ packages/` não encontra nada. `deepgram` só aparece como nome de
   modelo do ASR externo de teste (R21).
4. Com `ALLOW_EXTERNAL_ASR=false`, `docker compose exec backend node -e
   "fetch('https://openrouter.ai/api/v1/audio/transcriptions').catch(e=>console.log(e.message))"`
   também é bloqueado.

### V9 — ASR externo de teste (FR-040/FR-041)

1. No `.env`: `ALLOW_EXTERNAL_ASR=true`, `OPENROUTER_API_KEY=<chave>`; `docker compose up -d backend`.
2. Reuniões → Transcrever arquivo → escolher "deepgram/nova-3 via OpenRouter": aparece o aviso de
   envio externo. Enviar um áudio curto em pt-BR.
3. A reunião termina em Concluída, com o aviso "o áudio foi enviado para fora da máquina" e
   falantes "Speaker N" no áudio misto.
4. `audit_log` tem uma linha `external_asr` por trecho enviado, sem texto da reunião.
5. "Reprocessar" com "Whisper local" refaz a transcrição localmente e remove o aviso.

### V8 — Reunião real (gate de pronto)

Uma reunião real de ≥ 15 min no Teams web deste computador, em Modo Assistente, validando V1–V5
com fala real. Registrar o resultado em `docs/analise/agente-local.md` §15.
