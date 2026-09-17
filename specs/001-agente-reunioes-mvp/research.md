# Research — Agente Local de Reuniões (MVP)

Base: análise em `docs/analise/agente-local.md` (§4–§8, §14), decisões D1–D8 e medições feitas
na RTX 4050. Cada item traz a decisão, o motivo e as alternativas avaliadas.

## R1. Captura de áudio no host

- **Decisão:** o host-agent inicia dois processos `parec --raw --format=s16le --rate=16000
  --channels=1`:
  - `--device=@DEFAULT_SOURCE@` para o microfone;
  - `--device=@DEFAULT_MONITOR@` para o áudio remoto.

  Uma thread lê o stdout de cada processo e grava num spool. Um relógio de parede mantém o
  alinhamento: se o byte esperado (`(agora − início) × 32000`) ficar mais de 200 ms à frente do
  gravado, o spool recebe zeros. A cada 3 s, `pactl get-default-sink` e
  `pactl get-default-source` são consultados; se mudarem (troca de fone Bluetooth), o `parec` do
  canal é reiniciado. Se o `parec` morrer, ele é reiniciado com backoff e o canal fica
  `restarting`; após 5 falhas seguidas, fica `unavailable`, e o preenchimento com zeros mantém a
  linha do tempo.
- **Motivo:**
  - `parec` já está instalado (pulseaudio-utils) e funciona com pipewire-pulse.
  - Aceita os aliases `@DEFAULT_*@` e entrega PCM cru no stdout.
  - Dois canais separados atendem FR-010/FR-016 sem diarização.
- **Alternativas:**
  - `pw-record` com target: a semântica de target e a saída raw variam entre versões.
  - Sink virtual "Reunião" com roteamento do Chrome: isola melhor, mas exige mover streams e fica
    para a V1. O monitor padrão também captura sons do sistema, o que é aceitável no MVP.
  - Captura no container: não, porque o princípio VI coloca a captura no host.

## R2. Transporte do áudio até o backend

- **Decisão:** o spool local fica em disco e um WebSocket por canal envia o áudio, retomando do
  offset informado pelo servidor ([ws-audio.md](contracts/ws-audio.md)). O backend grava o PCM
  em `DATA_DIR/audio/<id>/<canal>.pcm`.
- **Motivo:**
  - Reinícios do backend ou do host-agent não perdem áudio (edge case "reinício durante
    gravação").
  - O servidor é a fonte da verdade do que já foi persistido.
  - Protocolo simples, com um só tipo de frame.
- **Alternativas:**
  - POST HTTP por chunk: mais overhead, e a ordenação ficaria por conta da aplicação.
  - O worker ler o PCM direto do host (bind mount): acopla o worker ao host e complica o controle
    de estado.
  - gRPC: dependência a mais sem ganho.

## R3. Segmentação ao vivo

- **Decisão:** o corte é feito no backend (`recording/chunker.ts`) por energia RMS em quadros de
  30 ms, com piso de ruído adaptativo (percentil 20 dos últimos 10 s, com mínimo absoluto).
  - Corta numa pausa ≥ 500 ms depois de ≥ 8 s de áudio.
  - Aos 30 s, força o corte no quadro de menor energia dos últimos 3 s.
  - Trechos inteiros abaixo do limiar de fala são descartados sem chamar o worker (economiza GPU),
    mas o áudio continua no arquivo.

  O worker aplica o Silero VAD do faster-whisper (`vad_filter=True`) em cada trecho, e o
  `speech_seconds` que ele devolve define a "fala" usada na regra de parada.
- **Motivo:**
  - Cortar na pausa evita palavras quebradas (tabela da §6).
  - A energia em Node é barata e não exige ONNX no backend.
  - O VAD de verdade roda onde já existe (faster-whisper).
- **Alternativas:**
  - Blocos fixos de 30 s: cortam palavras.
  - Silero no Node (onnxruntime-node): mais uma dependência nativa na imagem do Playwright.
  - Streaming (LocalAgreement/SimulStreaming): fica para a V2.

## R4. Serviço de ASR: worker próprio no lugar do whisper-asr-webservice

- **Decisão:** novo `apps/worker-gpu` (FastAPI + faster-whisper + pyannote.audio), sobre a imagem
  `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04` e com Python 3.12 via uv. O serviço `whisper`
  (onerahmet, 31,8 GB) sai do compose.
- **Motivo:**
  - O MVP precisa de endpoint de chunk em PCM, jobs assíncronos com progresso, telemetria de GPU
    e diarização de um canal específico com pyannote 4 / community-1.
  - O webservice não oferece chunk em PCM nem jobs, e usa o whisperx com pyannote 3.1.
  - Um processo com o modelo carregado atende o ao vivo e o passe final, sem duplicar VRAM.
- **Alternativas:**
  - Manter o webservice e acrescentar outro serviço para a diarização: dois processos com o
    Whisper carregado (2 × 1,4 GB).
  - WhisperLive: servidor de streaming com protocolo próprio e sem diarização final.

## R5. Modelo e parâmetros de ASR

- **Decisão:** `large-v3-turbo` com `compute_type=int8_float16` na GPU, igual ao spike (§14: ~1 s
  para 58 s de áudio, 1,4 GB), nos dois passes.
  - **Ao vivo:** `beam_size=5`, `condition_on_previous_text=False`, `vad_filter=True`, glossário
    opcional em `initial_prompt`.
  - **Final:** `BatchedInferencePipeline` com `condition_on_previous_text=True`.
- **Motivo:** foi o único modelo medido e aprovado; o princípio V exige medição antes de trocar.
  O `large-v3` fica como opção (`ASR_FINAL_MODEL`) depois de medido.
- **Alternativas:** `openai_whisper` (5,2 GB, inviável junto com o LLM); `large-v3` no passe
  final (não medido).

## R6. Diarização

- **Decisão:** pyannote.audio 4 com `pyannote/speaker-diarization-community-1`, só no passe final e
  só no canal `remote` (ou `mixed` em upload e Modo Agente).
  - O modelo é carregado sob demanda e liberado no fim do job.
  - Requer `HF_TOKEN` e aceite dos termos no Hugging Face. Sem isso, `diarization=unavailable` e o
    rótulo é "Remoto".
  - Após o primeiro download, `HF_HUB_OFFLINE=1`.
  - O backend descarrega o Ollama antes do job.
- **Motivo:**
  - Licença aberta e melhor qualidade que a 3.1.
  - O canal do microfone já identifica o usuário (FR-016).
  - A VRAM do pós-reunião comporta ~1–2 GB extras com o Ollama descarregado.
- **Alternativas:**
  - Diarização ao vivo (diart/Sortformer): fica para a V2.
  - NeMo: stack pesada.
  - Sem diarização: não atende FR-017, mas é o fallback.

## R7. LLM local e janelas do agente

- **Decisão:** Ollama 0.32.14 em container com `qwen3.5:4b`, `think:false`, `temperature:0` e
  saída por JSON Schema.
  - **Ao vivo:** `num_ctx=4096`. Extração quando há ≥ 90 s de fala nova, ou ≥ 1 segmento novo e
    ≥ 180 s desde a última extração. Consolidação a cada 15 min.
  - **Pós-reunião:** `num_ctx=8192`, map-reduce.
  - Fila única serial, com prioridade para o ao vivo.
- **Medições:**
  - ctx 4k: 38,7 tok/s, ~27 s por janela, 5,0 GB de VRAM junto com o Whisper.
  - ctx 8k (medido em 2026-09-16): 33,2 tok/s, 38,9 s para 1 026 tokens de saída; o modelo
    ocupa 3,9 GB, dos quais 3,0 GB ficam na GPU e o resto na CPU. Total da GPU: 5,0 GB.
- **Motivo:**
  - Atende "não executar LLM pesado a cada frase", com uma janela a cada 1,5–3 min.
  - O `qwen3:8b` foi mais lento e pior (§14).
- **Alternativas:** `qwen3:8b` (rejeitado); chamar o LLM a cada segmento (proibido pela spec); LLM
  externo (proibido por D4).

## R8. Anti-alucinação e rastreabilidade

- **Decisão:** a transcrição vai ao LLM com ids curtos (`S12`). O schema exige `segmentos` e uma
  `citacao` literal. O código valida:
  - os ids;
  - que ≥ 60% dos tokens da citação aparecem no texto citado;
  - o tamanho mínimo.

  Itens reprovados são descartados antes de persistir. A deduplicação usa Jaccard ≥ 0,55 por tipo;
  a consolidação por LLM trata os duplicados semânticos.
- **Motivo:**
  - O spike mostrou uma decisão inventada (TLS) e um duplicado.
  - A exigência de citação conferível elimina itens sem base textual (princípio IV).
  - O timestamp como string, usado no spike, era frágil.
- **Alternativas:** confiar só no id (aceita paráfrase inventada); embeddings para deduplicar
  (ficam para a V1, junto com o pgvector); self-check com uma segunda chamada ao LLM (dobra o
  custo).

## R9. Ata renderizada na leitura

- **Decisão:** a narrativa do LLM (objetivo, resumo, assuntos, observações) fica em
  `meetings.analysis`. As seções de itens são montadas em código a partir do estado atual
  (`ata/render.ts`):
  - rejeitados são omitidos;
  - propostos recebem a marca "(proposto)";
  - nomes de falantes são aplicados.

  O mesmo renderer serve à UI, ao copiar e ao download.
- **Motivo:** FR-027. A revisão reflete na ata sem nova chamada ao LLM, e as 19 seções ficam
  determinísticas.
- **Alternativas:** a ata inteira em Markdown gerada pelo LLM (como antes), que fica
  desatualizada a cada revisão e é pouco confiável com um modelo de 4B.

## R10. Importação `.ics`

- **Decisão:** `node-ical` (ver versão e API em R17).
  - Ocorrências de ontem até +30 dias.
  - Chave `(UID, RECURRENCE-ID | início)`; respeita `SEQUENCE`.
  - `METHOD:CANCEL`/`STATUS:CANCELLED` → `cancelled`.
  - Ignora eventos de dia inteiro.
  - Link: `X-MICROSOFT-SKYPETEAMSMEETINGURL`, senão a primeira URL
    `https://teams.microsoft.com/(l/meetup-join|meet)/…` ou `https://meet.google.com/…` em
    DESCRIPTION/LOCATION/URL.
  - Participantes: `ATTENDEE` (CN + mailto). Organizador: `ORGANIZER` (CN).
  - Projeto sugerido por palavra-chave no título.
- **Motivo:** D5. O node-ical trata TZIDs do Windows (Outlook) e RRULE/EXDATE/overrides.
- **Alternativas:** `ical.js` (mais baixo nível, TZIDs do Windows exigem mapeamento manual);
  parser próprio (arriscado).

## R11. Alertas no desktop

- **Decisão:** o host-agent agenda os alertas a partir do heartbeat (lista das próximas 24 h).
  - **T-15 e T-5:** `notify-send --urgency=critical --app-name="Agente de Reuniões"
    --action=entrar=Entrar --action=nao_gravar="Não gravar" --wait`, numa thread, e um som
    (`canberra-gtk-play -i message-new-instant`). A ação escolhida sai no stdout.
  - **T-1:** `zenity --question --modal` com "Entrar", "Fechar" e o botão extra "Não gravar",
    mais som em loop (`alarm-clock-elapsed`, a cada 3 s) até a resposta ou até T+2 min.
  - Alertas já emitidos são registrados em `~/.local/state/agente-reunioes/alerts.json` (chave
    `meeting:minutos:início`) para não repetir depois de um reinício.
  - Alertas atrasados mais de 60 s não são emitidos (edge case de suspensão).
  - Mudança de horário gera uma chave nova.
- **Motivo:** notificação `critical` fica na tela no GNOME e o modal em T-1 é "difícil de
  ignorar". Tudo roda sem o navegador (FR-005/006/007).
- **Alternativas:** Web Notifications (exigem o navegador aberto); extensão do GNOME (manutenção
  alta); `gdbus` direto (mais código).

## R12. Controle da gravação (estado desejado)

- **Decisão:** o backend decide qual reunião deve estar gravando. Um scheduler roda a cada 5 s
  sob advisory lock.
  - **Início:** se nada grava, escolhe a reunião `scheduled` (ics/manual) com
    `scheduled_start ≤ agora < scheduled_end` e sem `skip_recording`, de início mais antigo, e a
    marca `recording` com `started_at=agora`.
  - **Conflito:** as demais ficam aguardando, a UI mostra "conflito" e o host-agent notifica.
  - **Parada** (`stopping`):
    - `stop_requested`;
    - `agora − started_at ≥ 4 h`;
    - `agora ≥ scheduled_end` e `agora − max(last_speech_at, started_at) ≥ 180 s`;
    - host-agent offline há > 5 min com `agora ≥ scheduled_end`.
  - **Missed:** `scheduled` com `scheduled_end < agora` passa a `missed`.
  - **Após `stopping`:** aguarda o `end` dos canais conectados (ou 120 s), converte para Opus e
    enfileira o passe final.

  O host-agent só converge para o estado recebido no heartbeat.
- **Motivo:** uma fonte da verdade, com lógica testável em funções puras. Resolve suspensão
  (começa atrasado se ainda estiver na janela) e conflitos (FR-013).
- **Alternativas:** host-agent decidir sozinho (duas fontes de verdade, UI sem controle); cron
  por reunião (frágil a mudanças de agenda).

## R13. Armazenamento do áudio

- **Decisão:** o PCM fica em disco durante a gravação. No `stopping`, `ffmpeg -f s16le -ar 16000
  -ac 1 -i <canal>.pcm -c:a libopus -b:a 32k -application voip <canal>.ogg`. O backend confere
  a duração (ffprobe, ±1 s) e apaga o PCM. `meeting_audio` guarda o formato. Nada é apagado
  automaticamente depois.
- **Motivo:** D7 (guardar sempre). O Opus a 32 kbps usa ~14 MB/h contra 115 MB/h do PCM.
- **Alternativas:** FLAC (~50 MB/h, sem ganho perceptível para voz); gravar direto em Opus (o
  ffmpeg ao vivo complica a retomada por offset).

## R14. LOCAL_ONLY e egress guard

- **Decisão:** `security/egress.ts` embrulha `globalThis.fetch` no boot. Só permite hosts de
  `EGRESS_ALLOWLIST` (padrão: `ollama`, `worker-gpu`, `localhost`, `127.0.0.1`). Qualquer outro
  destino lança erro e grava `audit_log(kind='egress_blocked')`. `LLMProvider` recusa adaptadores
  que não sejam locais. `@anthropic-ai/sdk` e `@deepgram/sdk` são removidos do `package.json`.
  O Chromium do Modo Agente é um processo separado e acessa só a reunião, por definição.
- **Motivo:** princípio I e FR-038, com teste automatizável (V7).
- **Alternativas:** bloqueio só por rede Docker (`internal: true`) impede o pull de modelos no
  Ollama e o acesso do bot às reuniões; fica como reforço opcional na V1.

## R15. Frontend

- **Decisão:** React + Vite + TS (versões em R17) com `react-router` em modo declarativo e CSS
  próprio (tokens claro e escuro, como hoje). Sem biblioteca de estado: hooks e `fetch`. O
  WebSocket é um cliente único com assinaturas. O Markdown da ata é renderizado em elementos
  React, sem `dangerouslySetInnerHTML`. O build é servido pelo backend como estático, na mesma
  origem.
- **Motivo:** princípio VIII, com menos dependências e a mesma origem do cookie e do CSRF.
- **Alternativas:** manter o JS puro (não atende o princípio VIII, e a tela ao vivo com painéis
  ficaria difícil); Next.js (SSR desnecessário).

## R16. Autenticação do host-agent

- **Decisão:** `AGENT_TOKEN` (32 bytes hex) no `.env` do repositório (permissão 600). O
  host-agent lê o mesmo arquivo pelo caminho configurado em
  `~/.config/agente-reunioes/config.toml`. A comparação usa `timingSafeEqual`. O token só vale em
  `/api/agent/*`, e a porta só escuta em 127.0.0.1.
- **Motivo:** loopback com autenticação (princípio VI), sem senha corporativa e sem OAuth.
- **Alternativas:** keyring do GNOME (não é necessário para um segredo local gerado pelo próprio
  projeto); socket Unix (o container publicaria um arquivo no host, o que complica as
  permissões).

## R17. Versões e APIs confirmadas (Context7, npm e PyPI, 2026-09-16)

| Pacote | Versão | Pontos confirmados |
|---|---|---|
| node-ical | 0.27.2 | `ical.sync.parseICS(str)`; `expandRecurringEvent(ev, {from, to, includeOverrides, excludeExdates})` aplica EXDATE e overrides; TZID do Windows mapeado (`E. South America Standard Time` → `America/Sao_Paulo`); `attendee` é string ou `{val, params:{CN}}`, podendo ser array; `X-MICROSOFT-SKYPETEAMSMEETINGURL` vira `event['MICROSOFT-SKYPETEAMSMEETINGURL']`; `method`/`status` disponíveis |
| ws | 8.21.3 | `new WebSocketServer({noServer:true})` + `server.on('upgrade')`, autenticação antes do `handleUpgrade`; `on('message', (data, isBinary))` |
| zod | 4.6.5 | `z.toJSONSchema(schema, {target: "draft-07"})` |
| vite / @vitejs/plugin-react | 8.3.0 / 6.1.1 | — |
| react / react-dom | 19.3.0 | — |
| react-router | 8.4.0 | modo declarativo `BrowserRouter`/`Routes`/`Route` importado de `react-router` |
| vitest | 5.0.1 | — |
| Ollama API | 0.32.14 | `format` aceita JSON Schema; `think:false`; `keep_alive:0` descarrega; `options.num_ctx` só na API nativa; `/api/ps` → `size_vram` |
| faster-whisper | 1.2.1 | `WhisperModel(..., device="cuda", compute_type="int8_float16")`; `BatchedInferencePipeline(model=...)`; `decode_audio(path, sampling_rate=16000)`; VAD Silero v6 em ONNX (`faster_whisper.vad.get_speech_timestamps`, `VadOptions`) |
| ctranslate2 | 4.8.2 | exige **cuBLAS 12 + cuDNN 9 para CUDA 12**, fornecidos pela imagem base `nvidia/cuda:12.8.1-cudnn-runtime` |
| pyannote.audio | 4.0.7 | `Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=...)`; **gated** (aceitar os termos no HF); entrada `{"waveform": (C,T) tensor, "sample_rate": 16000}`; saída `output.speaker_diarization` iterável em `(turn, speaker)`; torch ≥ 2.8 |
| torch | 2.14.0 | **a wheel padrão do PyPI usa CUDA 13 (cuDNN cu13)**. Para não misturar dois `libcudnn.so.9` no mesmo processo com o ctranslate2 (CUDA 12), o torch é instalado do índice PyTorch **cu12x** (`download.pytorch.org/whl/cu128` ou `cu126`, o mais novo disponível) via `[[tool.uv.index]]` explícito, e a versão é fixada no lock |
| fastapi / uvicorn | 0.141.1 / 0.53.0 | — |
| nvidia-ml-py | 13.610.43 | `pynvml` (NVML) |
| websockets (Python) | 17.1 | `from websockets.asyncio.client import connect` |
| httpx | 0.28.1 | — |
| notify-send (libnotify) | 0.8.8 | `-A/--action=[NAME=]Text` (implica `--wait` e imprime NAME no stdout); `-u critical`; `-a`; `-h`; `-t` é ignorado pelo GNOME |

Risco registrado: se não houver wheel cu12x do torch compatível com o pyannote 4.0.7, a
alternativa é usar a imagem base CUDA 13 (`nvidia/cuda:13.x-cudnn-runtime`) com o cuDNN cu13 e
instalar as libs `nvidia-cublas-cu12` e `nvidia-cudnn-cu12` só para o ctranslate2, validando no
build.

## R18. Redis e pgvector adiados

Ver Complexity Tracking no [plan.md](plan.md).

## R19. Fuso horário

- **Decisão:** `APP_TIMEZONE=America/Sao_Paulo` (lido do host). Os containers recebem
  `TZ=${APP_TIMEZONE}`. O "dia" da agenda é calculado com `Intl` nesse fuso. O banco guarda
  `timestamptz`.
- **Motivo:** convites trazem fusos diversos e a UI e os alertas usam o fuso local.

## R20. Testes

- **Decisão:**
  - Backend: Vitest para funções puras (ics, chunker, scheduler, evidence, dedup, remap, render,
    egress) e para rotas com Postgres de teste (`TEST_DATABASE_URL`, banco `meetingbot_test` no
    mesmo container, criado pelo script de teste).
  - Python: pytest.
  - Fluxo real: validação manual (quickstart V1–V8).
- **Motivo:** princípio VII, com custo proporcional ao MVP.

## R21. ASR externo de teste (Deepgram nova-3 via OpenRouter)

- **Contexto:** em 2026-09-16 o usuário pediu o Deepgram `nova-3` via OpenRouter como opção
  secundária para comparar a transcrição. Decisões dele: liberar por flag explícita, usar só no
  passe final e em uploads, Whisper local como padrão, sem fallback automático. Constituição
  emendada para 1.1.0.
- **Decisão:**
  - `ALLOW_EXTERNAL_ASR=true` habilita; `ASR_PROVIDER=local|openrouter` define o padrão
    (`openrouter` sem a flag derruba o boot); `meetings.asr_provider` guarda a escolha por
    reunião (upload e "Reprocessar").
  - Endpoint `POST https://openrouter.ai/api/v1/audio/transcriptions`, JSON com
    `input_audio` em base64 (`format: "ogg"`), `language`, `response_format: "verbose_json"`,
    `timestamp_granularities: ["segment","word"]` e, nos canais `remote`/`mixed`,
    `provider.options.deepgram = {diarize, smart_format}`. Se as opções forem recusadas (400),
    repete sem elas. 429/5xx: 3 novas tentativas (5/15/30 s); 401/402/403/413 falham direto.
  - O arquivo é cortado em trechos de 20 min, recodificados para Opus 16 kHz mono 32 kbps
    (o provedor encerra requisições com mais de ~60 s de processamento). Os falantes são
    numerados por trecho ("Speaker N (parte k)") porque o provedor não mantém a identidade
    entre requisições.
  - Sem `segments` na resposta, as palavras são agrupadas por falante, pausa > 1,2 s ou 40
    palavras; sem palavras, o texto vira um segmento único.
  - O egress guard ganhou "endpoints" (host + prefixo de caminho, só https, sem credenciais na
    URL): com a flag, apenas `/api/v1/audio/transcriptions` do OpenRouter é liberado; o resto do
    host (inclusive LLM) continua bloqueado.
  - Cada trecho enviado gera `audit_log` `external_asr` com reunião, canal, segundos e modelo.
  - `transcription_provider = openrouter:<modelo>`; a UI mostra aviso na reunião e antes do envio.
- **Motivo:** permite comparar qualidade sem abrir mão do padrão local e mantém o envio
  rastreável e restrito ao mínimo.
- **Alternativas:** API direta da Deepgram (outro contrato e outra chave; o usuário pediu
  OpenRouter); multipart (limite de 25 MB); usar também ao vivo (descartado pelo usuário).
