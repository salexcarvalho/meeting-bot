# Análise — Agente Local de Reuniões e Arquitetura

> Etapa 1 da especificação (itens 25.1–25.13). Nenhum código foi escrito
> para este escopo. As decisões que dependem de você estão em
> [Perguntas em aberto](#12-perguntas-em-aberto).

Data: 2026-09-16

## 1. Resumo

A proposta é viável **localmente** para o fluxo principal:

```
calendário → alerta → você entra no Teams → captura local → Whisper GPU → ata + análise
```

Duas partes dependem de fatores fora do seu controle:

1. **Leitura do calendário corporativo (Graph).** Depende de o tenant
   Microsoft 365 permitir o consentimento do app (ver §4).
2. **Um bot entrando sozinho no Teams.** Oficialmente, isso exige
   infraestrutura Windows/Azure e permissões de administrador do tenant
   (ver §4). O caminho viável e sem contornar políticas é o **Modo
   Assistente**: o agente abre a reunião, você entra com a sua conta, e o
   agente grava o áudio da sua própria máquina.

Recomendação central: **app web em Docker (Engine nativo, com GPU)**, mais
um **agente nativo pequeno** no Ubuntu, que cuida de notificações, som,
abertura de links e captura de áudio via PipeWire.

## 2. Ambiente verificado

| Item | Encontrado | Implicação |
|---|---|---|
| SO | Ubuntu 26.04.1 LTS, kernel 7.0, GNOME em **Wayland** | Automação de janelas limitada (sem xdotool). Notificações via libnotify. |
| CPU / RAM / disco | i7-13620H (16 threads), 30 GB (9 GB livres no momento), 228 GB livres | Suficiente. RAM disputada com Chrome e LLM. |
| GPU | RTX 4050 Laptop 6 GB, driver 610.57, CUDA 13.3 | CUDA ok. VRAM é o gargalo (ver §6). |
| Docker | **Engine nativo 29.8 ativo** + **Docker Desktop** (contexto atual; VM com 4 CPUs / 8 GB) | O Desktop **não acessa a GPU nem o PipeWire/DBus do host** e limita a CPU. É isso que deixou o Whisper em ~1x tempo real no teste. Migrar para o Engine nativo. |
| NVIDIA Container Toolkit | **não instalado** | Necessário para GPU em containers (`sudo`). |
| Áudio | PipeWire 1.6.2. Microfone interno (Raptor Lake DMIC). Saída padrão Bluetooth. `pw-record`, `pw-link` e `pw-loopback` presentes. `pactl` ausente. | Dá para capturar microfone e áudio remoto separadamente. |
| Notificações | `notify-send` 0.8.8 (com ações), `zenity`, `canberra-gtk-play`, sons freedesktop | Alertas com botão "Entrar" e som sem navegador. |
| LLM local | **Ollama 0.32.14 instalado** (serviço parado) | Base do provider local. |
| Python | 3.14.4 no host + `uv` | Libs de ML ainda atrasam em 3.14: usar Python 3.12 via `uv` no agente e nos containers. |
| Navegadores | Chrome, Firefox. **Sem cliente Teams nativo** | Teams via web no Chrome. |
| systemd --user | ativo, `Linger=yes` | O agente nativo pode subir com a sessão e continuar rodando. |

## 3. Limitações técnicas principais

1. **Docker Desktop for Linux** roda numa VM: sem GPU, sem socket do
   PipeWire e sem barramento DBus da sessão. Solução: usar o contexto
   `default` (Engine nativo) e instalar o NVIDIA Container Toolkit.
2. **Integração com o desktop** (notificação, som, captura, abrir link)
   não cabe bem em container. Ela fica num **agente nativo** (serviço
   systemd do usuário).
3. **Wayland** impede automação global de teclado/janela. Entrar na
   reunião por automação só é possível no navegador controlado pelo
   próprio agente (Playwright), não no Chrome que você usa.
4. **VRAM de 6 GB** é compartilhada entre Whisper, diarização, embeddings
   e LLM local. É preciso escalonar o uso (ver §6).
5. **Bluetooth**: ao usar o microfone do headset, o perfil muda para
   HFP/HSP e a qualidade cai. Preferir o microfone interno e o headset só
   como saída, ou um headset USB.
6. **Eco**: com alto-falante, o microfone capta o áudio remoto. Mitigar com
   fone ou com o módulo de cancelamento de eco do PipeWire.

## 4. Microsoft Teams + Microsoft Graph

Fontes consultadas em 2026-09-16 (learn.microsoft.com). Links na [seção 13](#13-fontes).

| Capacidade | Como | Depende do admin do tenant? | Veredito |
|---|---|---|---|
| Ler o próprio calendário | App público. OAuth **auth code + PKCE** com redirect `http://localhost:<porta>`. Escopos delegados `Calendars.Read`, `User.Read`, `offline_access`. | Não, **se** o tenant permitir consentimento do usuário. Caso contrário, via *admin consent workflow*. | ✅ Viável. Primeiro teste do MVP. |
| Device code flow | — | A Microsoft está bloqueando por padrão via Conditional Access. | ❌ Evitar. |
| Onde registrar o app | Pode ser multi-tenant, registrado num tenant seu. No primeiro login é criado o service principal no tenant corporativo. | As políticas de consentimento e de CA do tenant continuam valendo. | ✅ |
| Dados do evento | `GET /me/calendarView?startDateTime&endDateTime` → `subject`, `start`, `end`, `attendees`, `organizer`, `body`, `location`, `isOnlineMeeting`, `onlineMeeting.joinUrl` | Não | ✅ Polling de 30–60 s fica bem abaixo do throttling (10 mil req / 10 min por mailbox). |
| Webhooks de mudança | Exigem endpoint HTTPS público | — | ❌ Não combina com app local. Usar polling. |
| Guardar token | `msal-extensions` (Python) com libsecret / GNOME Keyring | Não | ✅ **No host-agent.** No container não há DBus/keyring. |
| Bot oficial entrando na call com mídia em tempo real | Graph Cloud Communications, *application-hosted media*: **só C#/.NET em Windows Server no Azure**, IP público. Permissões `Calls.AccessMedia.All` e `Calls.JoinGroupCall.All` (de aplicativo) mais *application access policy*. | **Sim** (Global Admin) | ❌ Inviável a partir do laptop. |
| Detecção de bots no Teams (GA 2026) | Política padrão `RequireApprovalWhenDetected`: bots não certificados ficam no lobby aguardando o organizador. Vale também para bot via navegador. | — | ⚠️ O Modo Agente (meeting-bot) sempre dependerá de admissão manual. |
| Transcrição oficial do Teams | `GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'` e depois `…/transcripts` (delegado `OnlineMeetingTranscript.Read.All`) | **Sim**: desde 29/07/2026 o admin precisa ligar *Transcript API access → Microsoft Graph* (padrão OFF). Nomes dos falantes exigem também *speaker attribution* ON. | ⚠️ Útil só se a TI habilitar. Fica como V1 opcional. |
| Cliente Teams no Linux | O cliente nativo foi descontinuado em 2022. Restam Teams web e PWA (Chrome/Edge). Links `https://teams.microsoft.com/l/meetup-join/…` abrem direto no navegador. | Não | ✅ Opener = `xdg-open` no link https. |

**Conclusão:**

- **Modo Assistente** (abrir o link, você entra com sua conta, o agente
  grava localmente): é o caminho principal. Não depende de admin e não
  contorna nenhuma política.
- **Modo Agente** (bot convidado via navegador): fica opcional e sempre
  com admissão manual.
- **Bot oficial via Graph:** só com um pedido formal à TI do órgão.

Não verificado:

- se `list transcripts` delegado funciona em reuniões em que você é só
  convidado;
- o atraso exato até a transcrição ficar disponível no Graph;
- texto explícito dos termos de uso sobre clientes automatizados.

## 5. Captura de áudio e integração com o desktop

| Tema | Abordagem recomendada | Observações |
|---|---|---|
| Servidor de áudio | PipeWire 1.6 (já ativo), usado direto via `pw-record` / `pw-link` / `pw-loopback`. Instalar `pulseaudio-utils` para ter `pactl`. | — |
| Áudio remoto | Sink virtual **"Reunião"** (null-sink + loopback para a saída real). Só o Chrome/PWA do Teams é roteado para ele, e o `pw-record` grava o monitor desse sink. | Evita gravar sons do sistema ou de outras abas. Alternativa simples para o MVP: `@DEFAULT_MONITOR@`. |
| Seu microfone | `pw-record` em `@DEFAULT_SOURCE@` | Canal separado = "Sérgio" sem precisar de diarização. |
| Eco (alto-falante) | `libpipewire-module-echo-cancel` (AEC WebRTC) | Só necessário sem fone. |
| Bluetooth | Headset como saída (A2DP), microfone interno como entrada | Evita que o headset caia para o perfil HFP, de baixa qualidade. |
| Docker | Com o **Engine nativo**, montar `/run/user/1000/pulse` funciona. Com o **Docker Desktop**, não (VM). | Mesmo assim, a captura fica no host-agent: é mais robusta. |
| Notificação | `notify-send -u critical -A entrar=Entrar -A gravar=Gravar` (persistente no GNOME) + `zenity` modal em T-1 min + som em loop (`canberra-gtk-play` / `pw-play`) até você responder | Como o GNOME exibe os botões varia entre versões: validar no 26.04. |
| Abrir reunião | `xdg-open <joinUrl>` (Teams web/PWA no Chrome) | Não precisa do handler `msteams://`. |
| Serviço | Unit `systemd --user` com `WantedBy=graphical-session.target` e `PartOf=graphical-session.target` (herda DISPLAY/WAYLAND/DBUS da sessão) | `Linger=yes` já está ativo. |

## 6. CUDA / RTX 4050 e stack de fala

### Estratégia de segmentação (resposta ao item 7 da especificação)

| Estratégia | Latência | Precisão nas bordas | GPU | Veredito |
|---|---|---|---|---|
| Blocos fixos de 5 min | ~5 min | boa dentro do bloco, ruim no corte | picos grandes | ❌ Não atende "quase tempo real" |
| Blocos fixos de 1–2 min | 1–2 min | corta palavras | médio | ❌ |
| Blocos fixos de 30 s | ~30–40 s | corta palavras, gera repetições | baixo | ⚠️ |
| **VAD (Silero), cortes em pausas, 10–30 s** | **~10–20 s** | **boa (corta no silêncio)** | **baixo e constante** | ✅ **Passe ao vivo** |
| Streaming por política (SimulStreaming / LocalAgreement) | ~3–5 s | boa | contínuo | ⚠️ V2 (mais complexo; o `whisper_streaming` foi declarado obsoleto) |
| **Passe final no áudio completo** | pós-reunião | melhor | alto, mas sem disputa | ✅ **Qualidade final + diarização** |

**Decisão técnica: dois passes.**

- **Ao vivo:** Silero VAD v6 (CPU) → faster-whisper `large-v3-turbo`
  `int8_float16`, com `condition_on_previous_text=False`, `no_speech_threshold`
  alto e `initial_prompt` com glossário do projeto (nomes, siglas).
- **Final:** `large-v3` `int8_float16` com batching → substitui a
  transcrição ao vivo, e os itens extraídos são remapeados para os
  segmentos novos.
- Engine medido na §14: `faster_whisper` int8 (mesmo modelo da OpenAI),
  com 1/4 da VRAM do `openai_whisper`.

### Orçamento de VRAM (6 GB)

| Fase | Modelos na GPU | VRAM estimada |
|---|---|---|
| Durante a reunião | whisper turbo int8 (~1,5 GB) + LLM 4B Q4 (~3,4 GB) + desktop (~0,3 GB) | **~5,2 GB (apertado)** |
| Pós-reunião, passo 1 | whisper large-v3 int8 com batching | ~3–4,5 GB |
| Pós-reunião, passo 2 | diarização pyannote `community-1` (canal remoto) | ~1–2 GB |
| Pós-reunião, passo 3 | LLM 8B Q4 (análise do arquiteto e ata) | ~5,2 GB |
| Qualquer momento | embeddings bge-m3 | **CPU** (sem disputa) |

O worker coordena essas fases: descarrega um modelo antes de carregar o
próximo e usa `keep_alive` no Ollama. Se faltar VRAM, o Ollama joga parte
das camadas para a CPU (fica mais lento, mas não falha). Os números são
estimativas de benchmarks de terceiros; **medir na RTX 4050 é o primeiro
teste do MVP**.

### Requisitos CUDA

- faster-whisper / CTranslate2 ≥ 4.5 exigem CUDA ≥ 12.3 + cuDNN 9. O
  driver 610 atende.
- Imagem base: `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04`.
- **Docker Desktop for Linux não faz passthrough de GPU**: é obrigatório o
  Engine nativo + NVIDIA Container Toolkit (≥ 1.16).

### Diarização

- Microfone e remoto em canais separados: "Sérgio" sai sem nenhum modelo.
- No canal remoto: pyannote `speaker-diarization-community-1` (pyannote 4,
  licença aberta, modelo baixado do Hugging Face), no passe final.
- Os rótulos saem como "Speaker N" e podem ser renomeados na UI; o nome
  vale para a reunião inteira.
- Diarização ao vivo (diart / NeMo Sortformer) fica para a V2.

## 7. Stack recomendada

| Camada | Escolha | Por quê |
|---|---|---|
| host-agent | Python 3.12 (`uv`), `msal` + `msal-extensions` (keyring), `httpx`, subprocessos `pw-record` / `notify-send` / `zenity` / `canberra-gtk-play` / `xdg-open`; serviço `systemd --user` | Precisa da sessão gráfica, do keyring e do PipeWire |
| CalendarService | **no host-agent**: polling de `calendarView` a cada 60 s, envia os eventos ao backend | O token fica no keyring do usuário, nunca no container |
| backend | Node 24 + TypeScript (evolução do meeting-bot: Express, auth, pipeline), `ws`, BullMQ (Redis), Zod | Reaproveita o que já foi validado; é a sua stack |
| worker-gpu | Python 3.12 em `nvidia/cuda:12.8.1-cudnn-runtime`: faster-whisper, silero-vad 6, pyannote.audio 4 | O ecossistema de fala é Python |
| LLM local | **Ollama em container com GPU** (`ollama/ollama:0.32.14`, sem sudo, faz parte do compose), JSON Schema em `format`. Modelo: **qwen3.5:4b** (ver medições na §14) | O qwen3:8b foi mais lento e pior na extração, com metade das camadas na CPU |
| LLMProvider | Interface única `extract()`, `consolidate()`, `analyze()`, `chat()`. Adaptadores: `ollama` (padrão), `claude`, `openai` | `LOCAL_ONLY=true` bloqueia provedores externos por código e registra auditoria |
| Embeddings / busca | bge-m3 via Ollama (CPU) + pgvector 0.8 (HNSW) + `tsvector('portuguese')` com fusão RRF; reranker bge-reranker-v2-m3 na V1 | Sem banco vetorial separado: um único Postgres |
| Banco | `pgvector/pgvector:pg17` | Relacional + vetorial + busca textual juntos |
| Filas / eventos | Redis 7 (BullMQ + pub/sub para a UI ao vivo) | — |
| Frontend | React + Vite + TS, WebSocket para transcrição e insights ao vivo | É a sua stack |
| Modo Agente | `meeting-bot` atual (Playwright + PulseAudio interno) | Opcional, sempre com admissão manual |
| Containers | **Docker Engine nativo** (contexto `default`) + NVIDIA Container Toolkit | GPU e desempenho (16 threads, não 4) |

`LOCAL_ONLY=true` significa:

- nenhum áudio, transcrição ou documento sai da máquina;
- as únicas saídas de rede permitidas são a leitura do calendário (Graph)
  e o download inicial de modelos;
- depois do download, o Hugging Face roda com `HF_HUB_OFFLINE=1`.

## 8. Arquitetura proposta

```
┌──────────────────────── Host Ubuntu (sessão gráfica) ────────────────────────┐
│ host-agent (Python 3.12, systemd --user)                                     │
│   CalendarService ─ MSAL (token no keyring) + Graph calendarView a cada 60 s │
│   Notifier ─ notify-send critical + ações, som (pw-play), zenity             │
│   Opener ─── xdg-open joinUrl (Teams web no Chrome)                          │
│   AudioCaptureService ─ pw-record: mic (source) | remoto (monitor/sink)      │
│        │ PCM 16 kHz por canal (WebSocket localhost)                          │
│ Ollama (serviço nativo, GPU) ◄───────────────────────────────┐               │
└────────┼─────────────────────────────────────────────────────┼───────────────┘
         ▼                                                     │
┌──────────────────── Docker Engine nativo (compose) ──────────┼───────────────┐
│ backend (Node/TS)                                            │               │
│   MeetingManager (agenda, estado de cada reunião, alertas)   │               │
│   TranscriptProcessor (janelas de contexto)                  │               │
│   ArchitectAgent ── LLMProvider (ollama | claude | openai) ──┘               │
│   Search/Chat (RAG) · API REST + WebSocket                                   │
│ worker-gpu (Python 3.12 + CUDA)                                              │
│   VAD + faster-whisper (ao vivo) · passe final · diarização · embeddings     │
│ frontend (React + Vite)                                                      │
│ postgres + pgvector (relacional + vetorial + busca textual pt)               │
│ redis (filas + pub/sub de eventos ao vivo)                                   │
│ meeting-bot (Playwright; Modo Agente opcional, já existe)                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

Fluxo de uma reunião:

1. O **CalendarService** (no host-agent) lê o evento e envia ao backend,
   onde o **MeetingManager** agenda os alertas.
2. O **host-agent** notifica em T-15, T-5 e T-1 min. Na hora, o botão
   "Entrar" abre o link e inicia a captura.
3. Chegam dois streams de áudio: **mic** (você) e **remoto** (os outros).
4. O **worker-gpu** faz VAD, recorta trechos de 10–30 s e transcreve com
   faster-whisper. Os segmentos aparecem na UI via WebSocket.
5. O **TranscriptProcessor** acumula uma janela de ~90 s (ou antes, se
   detectar troca de assunto) e o **ArchitectAgent** extrai decisões,
   riscos, requisitos e pendências, cada item com referência ao trecho de
   origem.
6. A cada ~10–15 min acontece a **consolidação**: remove duplicados,
   atualiza status e refaz o resumo corrente (memória da reunião).
7. No fim acontece o **passe final**, com transcrição completa e
   diarização no canal remoto. Depois vêm a ata (template §11), a análise
   do arquiteto, as sugestões de ADR, a classificação do projeto e a
   indexação (embeddings).
8. **Revisão humana**: você aprova, edita ou rejeita cada item. ADR só é
   registrado depois da sua aprovação.

Janelas do agente (sem LLM pesado a cada frase):

| Nível | Gatilho | Modelo | Saída |
|---|---|---|---|
| Segmento | cada trecho de VAD | só ASR | texto + timestamps + canal |
| Extração | ~90 s de fala nova ou troca de assunto (similaridade de embeddings) | LLM pequeno local, saída JSON por schema | itens candidatos com `segment_ids` |
| Consolidação | 10–15 min e fim da reunião | LLM local (ou Claude, se permitido) | memória da reunião + resumo corrente |
| Pós-reunião | fim do passe final | LLM mais forte disponível | ata, análise do arquiteto, ADRs sugeridos, projeto |

## 9. Estrutura de diretórios proposta

```
agente-reunioes/                  (monorepo; meeting-bot vira apps/meeting-bot)
├── docker-compose.yml
├── docker-compose.override.yml   # dev
├── .env.example
├── .specify/                     # Spec Kit
├── docs/
│   ├── SPEC.md  ARCHITECTURE.md
│   ├── adr/                      # ADRs do próprio projeto
│   └── analise/
├── apps/
│   ├── backend/                  # Node 24 + TS
│   │   └── src/{calendar,meetings,notifications,transcripts,agent,llm,search,auth,db,ws}
│   ├── frontend/                 # React + Vite
│   │   └── src/{pages/{hoje,reuniao,busca,projetos,adrs},components,api}
│   ├── worker-gpu/               # Python 3.12 + CUDA
│   │   └── src/{asr,vad,diarization,embeddings,jobs}
│   ├── host-agent/               # Python 3.12 (uv), nativo
│   │   ├── src/{notifier,capture,opener,client}
│   │   └── systemd/agente-host.service
│   └── meeting-bot/              # bot convidado (código atual)
├── packages/
│   └── contracts/                # JSON Schemas / tipos compartilhados (eventos, itens)
└── db/
    └── migrations/
```

## 10. Backlog

### MVP — "reunião do calendário até ata com análise"

| ID | Item | Critério de aceite |
|---|---|---|
| M0 | Base: Docker Engine nativo + NVIDIA Container Toolkit, `git init`, `rtk init`, Spec Kit, monorepo. **Spike:** medir VRAM e tempo do whisper turbo/large-v3 e do LLM 4B/8B na RTX 4050 | `nvidia-smi` funciona dentro do compose; tabela de medições no repo |
| M1 | CalendarService no host-agent: app no Entra ID, OAuth (auth code + PKCE, loopback), token no keyring, `calendarView` a cada 60 s | Tela **Hoje** lista as reuniões do dia com o link do Teams. Fallback: cadastro manual do link. |
| M2 | host-agent Notifier: alertas em T-15/5/1 com som e botões **Entrar** e **Gravar** | Alerta aparece e toca com o navegador fechado |
| M3 | Opener: abre o `joinUrl` no Chrome | Clicar em **Entrar** abre o Teams web na reunião |
| M4 | AudioCaptureService: mic e remoto em streams separados; start/stop pelo alerta ou pela UI | Arquivos por canal e stream chegando no backend |
| M5 | ASR ao vivo na GPU: VAD + faster-whisper, UI progressiva | Texto aparece em ≤ ~10–15 s da fala |
| M6 | Passe final + diarização do canal remoto; canal mic rotulado como "Sérgio" | Transcrição final com Sérgio / Speaker N |
| M7 | LLMProvider (Ollama, Claude) + `LOCAL_ONLY` | Com `LOCAL_ONLY=true`, chamada externa é bloqueada e registrada |
| M8 | Ata (template §11) + análise do arquiteto pós-reunião, itens com rastreabilidade | Cada decisão abre o trecho de origem |
| M9 | Revisão humana dos itens (aprovar, editar, rejeitar) | Status e histórico de edição persistidos |
| M10 | Insights ao vivo (janelas de extração e consolidação) | Painéis Decisões, Pendências, Riscos, Requisitos e Arquitetura atualizam durante a call |

### V1

- Classificação automática do projeto, com correção manual.
- Memória por projeto, sistema e equipe.
- Busca semântica (pgvector + texto) e chat com citações.
- Sugestão de ADR (rascunho → aprovação → exportação).
- Painel de uso da GPU.
- Importação da transcrição oficial do Teams via Graph, se o tenant permitir.
- Política de retenção de áudio.
- Início automático com o sistema.

### V2

- Modo Agente mais robusto (bot convidado) e, se houver aval do admin,
  bot oficial via Graph.
- Diarização em streaming.
- Resolução de referências como "a reunião passada".
- Integrações: Azure DevOps (work items), Obsidian, Git para ADRs.
- Múltiplos usuários.

## 11. Riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | O tenant bloqueia o consentimento do usuário para o app (Graph) | Média/alta | Alto (sem calendário automático) | Pedido pelo *admin consent workflow*. Fallback: colar o link na UI ou importar o `.ics`. |
| R2 | Política da organização / LGPD sobre gravar reuniões | Média | Alto | Aviso aos participantes, retenção curta do áudio, `LOCAL_ONLY`, confirmar a regra com a TI/jurídico |
| R3 | 6 GB de VRAM insuficientes para Whisper + LLM ao vivo | Média | Médio | Escalonamento por fase, LLM 4B, offload para CPU, extração menos frequente; spike no M0 |
| R4 | Qualidade do LLM local na análise arquitetural em pt-BR | Média | Médio | Provider plugável (Claude opcional quando permitido), testes com reuniões reais, revisão humana obrigatória |
| R5 | Detecção de bots do Teams e lobby | Alta | Baixo (o Modo Agente é secundário) | Modo Assistente como padrão |
| R6 | Transcrição oficial via Graph desligada pelo admin | Alta | Baixo | Não depender dela: transcrição local é a fonte principal |
| R7 | Eco / sangramento de áudio entre canais com alto-falante | Média | Médio | Fone, AEC do PipeWire, sink dedicado para o Chrome |
| R8 | Bluetooth muda para HFP e a qualidade cai | Média | Médio | Microfone interno, headset só como saída |
| R9 | Alucinação do Whisper em silêncio | Média | Baixo | VAD, `no_speech_threshold`, filtro de frases conhecidas, passe final |
| R10 | Ambiente duplo Docker Desktop + Engine confunde contexto, volumes e portas | Alta | Baixo | Padronizar no Engine nativo; manter o Desktop só se você usar para outros projetos |
| R11 | Python 3.14 do host incompatível com libs de ML | Alta | Baixo | Python 3.12 gerenciado pelo `uv` |
| R12 | Botões de ação do `notify-send` no GNOME 26.04 se comportarem diferente do esperado | Média | Baixo | `zenity` modal como reforço em T-1 min |
| R13 | Os modelos de 2026 citados (Qwen3.5, Gemma 4) e seus números de VRAM vêm de fontes secundárias | Média | Baixo | Validar com `ollama pull` no spike M0 |

## 12. Decisões e perguntas em aberto

### Decididas (2026-09-16)

| # | Tema | Decisão | Consequência |
|---|---|---|---|
| D1 | Projeto | Evoluir o `meeting-bot` para monorepo | O bot atual vira o Modo Agente; auth e pipeline são reaproveitados |
| D2 | Microsoft 365 | O tenant **bloqueia** o app | O Graph sai do MVP. Calendário por cadastro manual e importação `.ics`; Graph fica para quando houver aval da TI. |
| D3 | Início da gravação | **Automático no horário** da reunião | O MeetingManager dispara a captura em T-0 sem clique; parar pela UI ou pela regra de término |
| D4 | LLM externo | **Nunca**, só local | `LOCAL_ONLY=true` fixo. Ata e análise via Ollama. Claude e Deepgram são removidos do caminho padrão. |
| D5 | Entrada do calendário | **Importar `.ics` + cadastro manual** | Acesso por e-mail também é inviável: Basic Auth foi removido do IMAP/EWS, OAuth esbarra no mesmo bloqueio, e o EWS começa a ser bloqueado em 1º/10/2026 |
| D6 | Término da gravação | Após o horário previsto, **quando houver 3 min sem fala**, ou pelo botão Parar | Limite de segurança de 4 h |
| D7 | Retenção do áudio | **Guardar sempre** | ~15 MB por hora por canal (Opus). Retranscrição sempre possível. |
| D8 | Ambiente | **Autorizado** a instalar NVIDIA Container Toolkit + `pulseaudio-utils` e migrar para o Docker Engine nativo | M0 liberado |

### Pendentes

Estas decisões são suas. As quatro primeiras bloqueiam o início:

1. **Projeto:** evoluir o `meeting-bot` (monorepo, mantendo o login do
   sócio) ou criar um projeto novo, pessoal?
2. **Microsoft 365:** você sabe se o tenant permite consentir apps? Pode
   pedir aprovação à TI?
3. **Início da gravação:** automático no horário, ou só depois do clique
   em "Gravar" no alerta?
4. **LLM externo (Claude):** com `LOCAL_ONLY`, quando pode ser usado?
5. **Aviso aos participantes:** qual é a regra (mensagem no chat, fala no
   início, nome do bot)?
6. **Retenção do áudio:** apagar após a transcrição final, após X dias ou
   nunca?
7. **ADRs aprovados:** onde registrar (repo Git do projeto, Wiki do Azure
   DevOps, Obsidian, só no app)?
8. **Acesso web em localhost:** manter login com senha? O sócio também
   usará este agente?
9. **Modo Agente (bot convidado):** é permitido em reuniões corporativas?
   Começa desligado?
10. **Áudio nas reuniões:** fone Bluetooth, fone com fio ou alto-falante?
11. **Projetos iniciais:** a lista Farmácia Digital, SUS Escolha, Portal
    SES, InfraVision e Agenith está completa?
12. **Ambiente:** posso migrar para o Docker Engine nativo e instalar
    (`sudo`) o NVIDIA Container Toolkit e o `pulseaudio-utils`? O Docker
    Desktop continua sendo usado por outros projetos seus?

## 13. Fontes

- **Microsoft**
  - Fluxos de autenticação MSAL: <https://learn.microsoft.com/en-us/entra/identity-platform/msal-authentication-flows>
  - Bloqueio de fluxos de autenticação via Conditional Access: <https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows>
  - Consentimento de usuário: <https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent>
  - Admin consent workflow: <https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/admin-consent-workflow-overview>
  - Referência de permissões do Graph: <https://learn.microsoft.com/en-us/graph/permissions-reference>
  - Throttling do Graph: <https://learn.microsoft.com/en-us/graph/throttling-limits>
  - Requisitos de bots com mídia hospedada: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots>
  - Proteção contra bots em reuniões do Teams: <https://techcommunity.microsoft.com/blog/microsoftteamsblog/introducing-smarter-bot-protection-in-microsoft-teams-meetings/4531375>
  - Acesso à API de transcrição: <https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access>
  - Listar transcrições de reunião: <https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0>
  - Teams como PWA: <https://learn.microsoft.com/en-us/microsoftteams/teams-progressive-web-apps>
- **Fala**
  - faster-whisper: <https://github.com/SYSTRAN/faster-whisper>
  - Silero VAD: <https://github.com/snakers4/silero-vad>
  - SimulStreaming: <https://github.com/ufal/SimulStreaming>
  - WhisperLiveKit: <https://github.com/QuentinFuxa/WhisperLiveKit>
  - WhisperLive: <https://github.com/collabora/WhisperLive>
  - pyannote community-1: <https://huggingface.co/pyannote/speaker-diarization-community-1>
  - diart: <https://github.com/juanmc2005/diart>
  - NeMo Streaming Sortformer: <https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1>
  - Parakeet TDT 0.6b v3: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- **GPU / Docker**
  - NVIDIA Container Toolkit: <https://nvidia.github.io/container-wiki/toolkit/quickstart.html>
  - GPU no Docker Desktop: <https://docs.docker.com/desktop/features/gpu>
  - Imagens nvidia/cuda: <https://hub.docker.com/r/nvidia/cuda/tags>
- **LLM / busca**
  - Saída estruturada no Ollama: <https://docs.ollama.com/capabilities/structured-outputs>
  - Biblioteca de modelos do Ollama: <https://ollama.com/library>
  - qwen3-embedding: <https://ollama.com/library/qwen3-embedding>
  - bge-reranker-v2-m3: <https://huggingface.co/BAAI/bge-reranker-v2-m3>
- **Desktop**
  - notify-send: <https://man.archlinux.org/man/notify-send.1.en>
  - pw-cat: <https://docs.pipewire.org/page_man_pw-cat_1.html>
  - systemd de usuário: <https://wiki.archlinux.org/title/Systemd/User>

## 14. Spike M0 — medições na RTX 4050 (2026-09-16)

Ambiente:

- Docker Engine nativo + NVIDIA Container Toolkit 1.20.0.
- GPU visível nos containers.
- O meeting-bot foi migrado do Docker Desktop, com os dados.

### Whisper (`large-v3-turbo`, reunião real do Teams, 58 s de áudio pt-BR)

| Engine | Onde | Tempo | VRAM pico |
|---|---|---|---|
| `openai_whisper` | CPU (Docker Desktop, 4 vCPU) | 60 s | — (~4 GB de RAM) |
| `openai_whisper` | GPU | 4 s | **5,2 GB** (inviável junto com o LLM) |
| **`faster_whisper` int8** | GPU | **~1 s** | **1,3–1,4 GB** |

A qualidade é equivalente entre os dois engines: mesmo modelo, e o
`faster_whisper` ainda preservou marcadores como "tá?". **Decisão
técnica:** `faster_whisper` int8 como padrão; `openai_whisper` continua
selecionável no `.env`.

### LLM local (Ollama 0.32.14, extração estruturada por JSON Schema, Whisper carregado ao mesmo tempo)

Transcrição sintética de arquitetura (9 falas: Kafka, TLS, DLQ, p95,
responsáveis e prazos).

| Modelo | Contexto | tok/s | Janela quente | GPU/CPU | VRAM total | Qualidade |
|---|---|---|---|---|---|---|
| **qwen3.5:4b** | 4096 | **38,7** | **27 s** | 81/19 % | 5,0 GB | Boa cobertura (decisão, riscos, NFRs, pendência com responsável/prazo). Falhas: uma "decisão" inventada (TLS), um item duplicado, uma pendência perdida. |
| qwen3.5:4b | 8192 | 30,4 | 48 s | 77/23 % | 5,0 GB | igual |
| qwen3:8b | 8192 | 7,3 | 80 s | 52/48 % | 4,7 GB | Pior: responsável errado na decisão, perdeu a pendência dos certificados |

Conclusões:

- O `qwen3.5:4b` com contexto de 4 k serve para as janelas ao vivo (a
  cada 2–3 min) e para a análise pós-reunião.
- Um modelo de 8 B não compensa em 6 GB.
- A precisão exige **revisão humana obrigatória** (já decidido) e
  **rastreabilidade por trecho**.
- Mitigações a aplicar no prompt ou no pós-processamento:
  - exigir citação literal;
  - validar que cada item aponta para um timestamp existente;
  - deduplicar itens;
  - classificar "decisão" só com verbo de decisão explícito.
