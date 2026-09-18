# Agente de Reuniões (meeting-bot)

**Português** · [English](README.en.md) · [Español](README.es.md)

Agente **local** de reuniões e arquitetura de software. Ele:

- traz a agenda do dia por convites `.ics` ou cadastro manual;
- avisa no desktop 15, 5 e 1 minuto antes de cada reunião;
- no horário, manda o **assistente** para dentro da chamada (Teams/Meet), que grava mesmo se você não entrar;
- transcreve ao vivo e, no fim, faz uma transcrição final melhor, com separação de falantes;
- extrai durante a reunião decisões, pendências, riscos e requisitos, sempre com o trecho de origem;
- gera a ata (template de 19 seções) e sugestões de ADR;
- deixa tudo como **proposto** até você revisar.

Tudo roda na máquina: Whisper (faster-whisper) e LLM (Ollama, `qwen3.5:4b`) na GPU local. A
única exceção é o **ASR externo de teste**, que fica desligado por padrão
([ver abaixo](#asr-externo-de-teste-opcional)).

Também continuam disponíveis o **upload de áudio/vídeo** e o **Modo Agente**, em que um bot
convidado entra no Meet/Teams.

- Especificação do MVP: [specs/001-agente-reunioes-mvp/spec.md](specs/001-agente-reunioes-mvp/spec.md)
- Plano, contratos e validação: [specs/001-agente-reunioes-mvp/](specs/001-agente-reunioes-mvp/)
- Arquitetura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Constituição do projeto: [.specify/memory/constitution.md](.specify/memory/constitution.md)

## Arquitetura em uma tela

```text
 Ubuntu (host)                                Docker Engine nativo (GPU)
┌──────────────────────────┐   heartbeat 5 s  ┌────────────────────────────────────────┐
│ host-agent (systemd)     │ ───────────────► │ backend (Node 24) :3000                │
│  alertas, som, xdg-open  │   WS PCM 16 kHz  │  agenda, gravação, agente, ata, UI     │
│  parec: mic + monitor    │ ───────────────► │   │            │             │         │
└──────────────────────────┘                  │ postgres   worker-gpu      ollama      │
 navegador → http://127.0.0.1:3000            │            (whisper,       (qwen3.5:4b)│
                                              │             pyannote)                  │
                                              └────────────────────────────────────────┘
```

| Pasta | Conteúdo |
|---|---|
| `apps/backend` | API, WebSockets, agendador de gravação, agente arquiteto, ata, Modo Agente (Playwright) |
| `apps/frontend` | UI React (Hoje, Reuniões, Reunião, Projetos) |
| `apps/worker-gpu` | FastAPI com faster-whisper e pyannote |
| `apps/host-agent` | Serviço do desktop: alertas, captura PipeWire, envio do áudio e geração com a sua assinatura (Claude Code/Codex) |
| `packages/contracts` | Tipos e schemas compartilhados |

## Requisitos

- Ubuntu com sessão gráfica (GNOME), PipeWire e GPU NVIDIA (medido numa RTX 4050, 6 GB)
- **Docker Engine nativo** + NVIDIA Container Toolkit (o Docker Desktop não enxerga GPU nem áudio)
- `uv`, `parec`/`pactl`, `notify-send`, `zenity`, `canberra-gtk-play` e `xdg-open` no host

## Instalação

```bash
sudo bash scripts/setup-host.sh          # NVIDIA Container Toolkit + pulseaudio-utils (uma vez)
cp .env.example .env                     # preencha POSTGRES_PASSWORD e AGENT_TOKEN
export DOCKER_CONTEXT=default            # sempre o Engine nativo
docker compose up -d --build
docker compose exec ollama ollama pull qwen3.5:4b
docker compose exec backend npm run user:create -- sergio --role=SUPER_ADMIN
apps/host-agent/install.sh               # serviço do desktop (systemd --user)
```

- Gere o `AGENT_TOKEN` com `openssl rand -hex 32`.
- Na primeira transcrição, o worker baixa o modelo do Whisper (~1,6 GB).
- A interface fica em http://127.0.0.1:3000.

### Usuários e papéis

Cada usuário só vê as próprias reuniões (e as compartilhadas com ele).

Papéis:

- **SUPER_ADMIN:** tudo;
- **ADMIN:** o próprio conteúdo e gestão de usuários comuns;
- **USER:** o próprio conteúdo;
- **VIEWER:** só leitura.

O backend confere a permissão em toda rota.

Ao migrar um banco antigo, o usuário mais antigo vira SUPER_ADMIN e os demais viram USER.

Pela interface, use **Administração > Usuários** (quem tem `users.read`). Pela linha de comando:

```bash
docker compose exec backend npm run user:create -- socio            # papel USER (o 1º usuário vira SUPER_ADMIN)
docker compose exec backend npm run user:create -- ana --role=ADMIN
docker compose exec backend npm run user:list
docker compose exec backend npm run user:passwd -- socio   # redefine a senha e derruba as sessões
docker compose exec backend npm run user:delete -- socio
```

### Separação de falantes (opcional)

1. Aceite os termos de
   [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Crie um token de leitura em https://huggingface.co/settings/tokens.
3. Coloque-o em `HF_TOKEN` no `.env` e rode `docker compose up -d worker-gpu`.

Sem token, o áudio da reunião aparece como "Remoto". O microfone é sempre você
(`USER_DISPLAY_NAME`). Depois do primeiro download, o modelo roda offline.

## Uso

### Hoje

- **Importar convites**: no Outlook, salve o convite como `.ics` e arraste-o para a tela
  **Hoje**. Reimportar atualiza a reunião sem duplicar; um cancelamento a marca como cancelada.
- **Nova reunião**: cadastro manual com título, início, duração, link e projeto.
- O projeto é **sugerido** pelas palavras-chave do título. Confirme-o em **Editar**.
- **Não gravar**: disponível na tela ou no alerta do desktop; o assistente não entra.
- **Enviar assistente agora**: manda o assistente antes do horário ou de novo depois de uma falha.
- **Gravar agora**: só em reunião sem link; grava pelo computador (microfone e áudio do PC).

### Durante a reunião

- No horário, o **assistente** entra em toda reunião com link do Teams/Meet que não esteja marcada
  "Não gravar", com o nome configurado e o sufixo "assistente gravando". Admita-o na sala de espera.
  - Ele entra mudo e sem câmera; a reunião mostra as iniciais do nome (convidado não tem foto).
  - A transcrição aparece ao vivo na página da reunião, com o agente arquiteto e o resumo corrente.
  - Ele espera a admissão até o fim previsto e não sai por estar sozinho antes dele.
  - Sai quando a chamada acaba, quando fica sozinho na chamada por 5 min (contando as pessoas na
    barra do Teams/Meet) depois do fim previsto, quando passa do fim previsto com 3 min sem som,
    em **Parar** ou em 4 h. Sem horário previsto (assistente enviado à mão), sai com 10 min sem som.
  - Se o backend reiniciar no meio e ainda for horário, ele entra de novo.
  - O computador não grava sozinho (`AUTO_LOCAL_RECORDING=false`); reunião sem link não é gravada,
    a não ser por **Gravar agora**.
- A gravação pelo computador para quando o horário previsto passou e houve 3 min sem fala, ao
  clicar em **Parar**, ou ao atingir 4 h.
- A aba **Ao vivo** mostra a transcrição (alguns segundos de atraso), o estado dos canais, a GPU,
  o resumo corrente e os painéis de itens.
- Clicar num horário ou na evidência de um item leva ao trecho e toca o áudio.

### Depois da reunião

- A transcrição final substitui a ao vivo. As evidências dos itens são remapeadas.
- O agente reanalisa a reunião, consolida os itens e gera a ata e os ADRs sugeridos.
- **Itens**: aprovar, rejeitar, reabrir, editar e ver o histórico. Itens criados à mão já
  nascem aprovados. O histórico é uma linha do tempo: quem fez o quê e quando, com o texto de antes
  riscado nas edições.
- **Ata**: sempre montada com o estado atual dos itens. Rejeitados somem e propostos aparecem
  marcados. Dá para copiar ou baixar em `.md`.
  - Na tela, data, horário, duração, projeto e participantes ficam numa ficha no topo; há um índice
    das seções e as seções vazias aparecem numa linha só. O `.md` copiado ou baixado mantém as 19 seções.
- **Resumo para enviar** (aba Ata): texto curto para colar no Teams ou no e-mail, com objetivo,
  resumo, decisões, decisões arquiteturais, pendências abertas (responsável e prazo) e riscos.
  Só entram itens aprovados; o diálogo avisa quantos ainda não revisados ficaram de fora.
- **ADRs**: editar e aprovar. O número definitivo (`ADR-001`…) só é atribuído na aprovação.
  - Filtros Ativos, Propostos, Aprovados e Rejeitados; os propostos vêm primeiro.
  - Os cartões ficam recolhidos, mostrando o começo da decisão ("Expandir todos" abre todos).
  - O link da decisão de origem abre a aba Itens já no cartão dela.
- **Falantes**: renomeie "Speaker 1" etc. na aba Transcrição.
- **Reprocessar**: refaz a transcrição final e a análise.
- **Itens ligados/desligados** (chave abaixo do painel ao vivo, só para o dono): decisões, pendências,
  riscos, requisitos e ADRs só são gerados nas reuniões em que você liga a chave. Vem **desligada**;
  reunião de teste assistido ou de entrega fica só com transcrição e ata com o resumo.
  - Desligada: a extração ao vivo não roda, e a análise pós-reunião gera só o resumo (sem itens, sem ADR).
  - **Gerar itens** liga a chave e pergunta onde gerar (local, OpenRouter ou assinatura), como o Gerar ata.
    Ligada no meio da reunião, a extração ao vivo começa dali.
  - **Desligar itens** não apaga nada: o que já existe fica, e criar item à mão continua valendo.
  - Reuniões anteriores a esta chave que já tinham itens ou análise entram como ligadas.
- **Gerar ata** (aba Ata): refaz só a análise sobre a transcrição final, sem transcrever de novo.
  - Gerar de novo começa do zero: apaga os itens propostos pela IA que ninguém tocou (e os ADRs
    sugeridos deles). Ficam os aprovados, os rejeitados, os editados e os criados à mão.
  - Itens repetidos são mesclados sozinhos. Se um novo repete um já revisado, ele é absorvido pelo
    revisado (a evidência passa para o aprovado; repetido de um rejeitado é descartado).
- **Gerar ADRs** (aba ADRs) e **Gerar ADR** (em cada decisão arquitetural, na aba Itens): geram ou
  refazem os ADRs sugeridos. ADRs aprovados, rejeitados ou editados à mão não são sobrescritos.
- Cada botão pergunta onde gerar: **modelo local**, **OpenRouter** ou **sua assinatura**
  (Claude Code ou Codex), conforme o que estiver habilitado. O que foi gerado fora aparece marcado
  ("OpenRouter", "Claude" ou "Codex" no item, no ADR e na ata).

### Upload e Modo Agente

Em **Reuniões**:

- envie um áudio/vídeo para transcrever;
- ou mande o assistente convidado para um link do Meet/Teams. Admita o assistente na sala de espera.

A tela da reunião mostra as etapas ao vivo: Preparando agente, Conectando, Abrindo reunião, Entrando, Aguardando admissão, Conectado.

O mesmo link não recebe dois assistentes ao mesmo tempo.

Na tela de login, o olho mostra a senha digitada e "Esqueceu sua senha?" explica o caminho (um
administrador redefine em Configurações > Usuários; sozinho, use `npm run user:passwd`). Não há
recuperação por e-mail: nada sai da máquina.

O nome na sala segue **Configurações > Reuniões**: meu nome, nome do agente ou um nome personalizado. Não há sufixo: o nome precisa dizer que é a ata (ex.: "Ata do Sérgio"), e um nome sem "ata", "gravação" ou "transcrição" entra como "Ata de <nome>". Convidado anônimo não tem foto no Meet/Teams: aparecem as iniciais do nome. Com `BOT_CAMERA=true` o assistente liga uma câmera virtual com o avatar do agente (imagem parada), mas na chamada isso vira um quadro de vídeo.

**Conta do agente no Teams** (Configurações > Meu agente): sem ela, o assistente entra no Teams como convidado sem conta, e o Teams marca isso. Com uma conta Microsoft **só do agente** (nunca a sua), ele entra logado e aparece com o nome da conta, que também precisa dizer que é a ata (ex.: "Ata do Sérgio"; o sistema recusa nome que não diz).
1. Na máquina do projeto: `npm run teams:login`. No navegador que abrir, entre com a conta do agente e marque "Manter conectado"; volte ao terminal e aperte Enter. Sai o arquivo `teams-session.json`.
2. Em Meu agente, informe o nome da conta e envie o arquivo. Depois apague o arquivo: ele vale como uma senha.
3. A senha nunca passa pelo sistema. Fica só a sessão, cifrada (AES-256-GCM, chave derivada do `AGENT_TOKEN`) e por usuário; trocar o `AGENT_TOKEN` exige conectar de novo. A cada reunião o Teams renova a sessão e o sistema guarda a nova.
4. Se a sessão vencer, o assistente cai para convidado, a tela mostra "Sessão vencida" e você repete o passo 1. A conta vale só para Teams; no Meet o assistente continua convidado.

Quando o assistente não entrar, veja a captura de tela em **Áudio e debug**.

### Configurações

Cada usuário tem as próprias configurações:

- **Perfil:** nome real, nome de exibição, e-mail, idioma, fuso e foto. O e-mail (o mesmo dos convites do Outlook/Teams) reconhece você entre os participantes do `.ics`: seu convite não aparece duplicado ao lado do canal do seu microfone na ata.
- **Meu agente:** persona do agente arquiteto, tecnologias, tipos de decisão, prompt base, avatar, gravação do nome falado e conta do agente no Teams.
- **Reuniões:** identidade na sala.
- **Documentação:** nível de detalhe e formatos.
- **Consumo de IA:** tokens e custo do mês por provedor, modelo e reunião, mais as últimas chamadas.
  Vem do `audit_log`, é só leitura e não bloqueia geração. A assinatura não cobra por chamada: só
  tokens. Cada um vê o consumo das reuniões que enxerga.

## Configuração principal (`.env`)

| Variável | Padrão | Uso |
|---|---|---|
| `AGENT_TOKEN` | — | Segredo compartilhado com o host-agent (≥ 32 caracteres) |
| `USER_DISPLAY_NAME` | `Sérgio` | Nome do canal do microfone |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Fuso da agenda e da ata |
| `ASR_MODEL` / `ASR_COMPUTE_TYPE` | `large-v3-turbo` / `int8_float16` | Whisper no worker |
| `HF_TOKEN` | vazio | Separação de falantes |
| `OLLAMA_MODEL` | `qwen3.5:4b` | LLM local |
| `LIVE_EXTRACT_MIN_SPEECH_SECONDS` | 90 | Extração ao vivo a cada N s de fala nova… |
| `LIVE_EXTRACT_MAX_INTERVAL_SECONDS` | 180 | …ou no máximo a cada M s |
| `LIVE_CONSOLIDATE_INTERVAL_SECONDS` | 900 | Resumo corrente e deduplicação |
| `SILENCE_STOP_SECONDS` / `MAX_RECORDING_MINUTES` | 180 / 240 | Regras de parada |
| `AGENT_OWNER` | vazio | Usuário cujas reuniões o host-agent desta máquina grava (vazio = primeiro usuário cadastrado, se ainda for SUPER_ADMIN ativo; defina sempre que houver mais de um usuário) |
| `DEFAULT_AGENT_NAME` | `Assistente` | Nome inicial do agente de cada usuário |
| `BOT_JOIN_TIMEOUT_SECONDS` | 45 | Limite para o assistente chegar à sala ou à espera |
| `BOT_SILENCE_STOP_MINUTES` | 10 | Silêncio que encerra uma reunião sem horário previsto |
| `BOT_CAMERA` | `false` | Câmera virtual com o avatar do agente (imagem parada; vira quadro de vídeo na chamada) |
| `BOT_LIVE_TRANSCRIPTION` | `true` | Transcrição ao vivo do áudio gravado pelo assistente |
| `MAX_AVATAR_KB` / `MAX_VOICE_KB` / `MAX_VOICE_SECONDS` | 2048 / 4096 / 60 | Limites dos arquivos de perfil |
| `EGRESS_ALLOWLIST` | `ollama,worker-gpu,localhost,127.0.0.1` | Hosts que o backend pode acessar |

### ASR externo de teste (opcional)

Para comparar a qualidade, o passe final e os uploads podem usar o **Deepgram nova-3 via
OpenRouter**.

> **Atenção:** com essa opção, o **áudio sai da máquina**. Use apenas com áudio que a política
> da organização permite enviar para terceiros. A transcrição ao vivo e todo o LLM continuam
> locais.

```bash
# .env
ALLOW_EXTERNAL_ASR=true
OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/settings/keys
ASR_PROVIDER=local                    # padrão; "openrouter" usa o Deepgram em todo passe final
OPENROUTER_STT_MODEL=deepgram/nova-3
```

Depois, `docker compose up -d backend`.

- A escolha por reunião aparece no **upload** e em **Reprocessar**.
- A reunião transcrita externamente mostra um aviso.
- Cada envio fica em `audit_log` (`external_asr`), sem conteúdo.
- O egress libera apenas `https://openrouter.ai/api/v1/audio/transcriptions`.
- Os falantes são numerados a cada 20 min de áudio, porque o provedor não mantém a identidade
  entre requisições.

### LLM externo (opcional)

A ata e os ADRs podem ser gerados por um modelo do **OpenRouter** (melhor qualidade que o 4B
local, com custo por uso).

> **Atenção:** com essa opção, a **transcrição inteira da reunião sai da máquina**. Use apenas
> com conteúdo que a política da organização permite enviar para terceiros. A análise ao vivo
> continua sempre local.

```bash
# .env
ALLOW_EXTERNAL_LLM=true
OPENROUTER_API_KEY=sk-or-...                    # a mesma chave do ASR externo
OPENROUTER_LLM_MODEL=anthropic/claude-sonnet-5  # qualquer modelo com structured outputs
LLM_GENERATION_PROVIDER=local                   # "openrouter" = análise automática pós-reunião também externa
OPENROUTER_LLM_TIMEOUT_SECONDS=180
OPENROUTER_LLM_MAX_TOKENS=32000             # modelos que raciocinam gastam parte disso
```

Depois, `docker --context default compose up -d backend`.

- Os botões **Gerar ata**, **Gerar ADRs** e **Gerar ADR** perguntam, a cada clique, se a geração
  é local ou no OpenRouter, e avisam antes de enviar.
- Com `LLM_GENERATION_PROVIDER=openrouter`, o processamento automático depois de cada reunião
  também usa o OpenRouter. Sem `ALLOW_EXTERNAL_LLM=true`, o backend não sobe com essa opção.
- A resposta segue um JSON Schema estrito (`response_format`) e só vai a provedores que o
  suportam (`provider.require_parameters`).
- Cada chamada fica em `audit_log` (`external_llm`), com tokens e custo, sem conteúdo. Cada pedido
  pela interface fica em `generation_requested`.
- O egress libera apenas `https://openrouter.ai/api/v1/chat/completions`.
- Só o dono da reunião gera documentos (quem recebeu compartilhamento não gera).

### Sua assinatura: Claude Code ou Codex (opcional)

Em vez de pagar por uso no OpenRouter, a ata e os ADRs podem sair da **sua assinatura** do Claude
(Pro/Max) ou do ChatGPT (Codex). Quem executa é o **host-agent**, com o `claude` ou o `codex`
instalados na sua máquina e o seu login; o backend nunca vê credenciais.

> **Atenção:** a transcrição sai da máquina e vai para a Anthropic ou a OpenAI pelo seu plano
> pessoal, que segue os termos de consumidor. Confira na sua conta se as conversas podem ser usadas
> para treino. Use só com conteúdo que a política da organização permite enviar.

```bash
# .env (também precisa de ALLOW_EXTERNAL_LLM=true)
CLAUDE_CLI_ENABLED=true
CLAUDE_CLI_MODEL=sonnet          # sonnet, opus ou o nome completo do modelo
CODEX_CLI_ENABLED=true
CODEX_CLI_MODEL=                 # vazio = padrão do Codex
LLM_GENERATION_PROVIDER=claude   # opcional: análise automática pela assinatura
```

1. Instale o host-agent (`apps/host-agent/install.sh`); ele precisa estar rodando.
2. **Claude:** usa o login normal do Claude Code (`claude` → `/login`).
3. **Codex:** usa uma pasta própria, sem as suas configurações e skills. Faça login uma vez:
   `CODEX_HOME=~/.config/agente-reunioes/codex codex login --device-auth`
4. `docker --context default compose up -d backend`

Regras:

- Vale só para as reuniões do dono do host-agent (`AGENT_OWNER`). A assinatura é pessoal: as
  reuniões de outra pessoa nunca usam o seu plano.
- O diálogo mostra por que a opção está indisponível (host-agent desligado, CLI sem login,
  reunião de outra pessoa).
- Na análise automática, se a assinatura estiver fora por um tempo (host-agent reiniciando, CLI
  sem login), a reunião espera até `SUBSCRIPTION_WAIT_MINUTES` (30) com o aviso "Aguardando a
  assinatura". Se não voltar, fica com erro e a transcrição salva; a ata sai pelo **Gerar ata**.
  Nunca cai no modelo local por isso. Só reunião de outra pessoa usa o modelo local.
- O CLI roda isolado: sem ferramentas, hooks, MCP ou instruções do usuário, numa pasta
  temporária, com o texto por stdin. Consome o limite do seu plano (não tem custo por uso).
- Cada chamada fica em `audit_log` (`external_llm`, com tokens), sem conteúdo.

## Publicar em rede (HTTPS)

Não exponha a porta 3000 sem TLS. Com o Caddy incluído:

```bash
# .env: DOMAIN=ata.suaempresa.com.br, COOKIE_SECURE=true, TRUST_PROXY=1
docker compose --profile https up -d
```

### Servidor de teste (VPS com Dokploy)

`docker-compose.vps.yml` sobe a mesma aplicação num servidor, sem GPU e sem desktop: a transcrição
final vai pelo OpenRouter, a ata e os ADRs pela sua assinatura do Claude (container `agent-cli`) e
quem grava é o assistente dentro da chamada — funciona com o seu computador desligado. Passo a
passo, limites e cópia dos dados: [`docs/vps-dokploy.md`](docs/vps-dokploy.md).

## Desenvolvimento

```bash
npm install                    # workspaces: contracts, frontend, backend
npm run typecheck
npm test                       # testes unitários do backend (Vitest)
npm run test:db -w @meeting-bot/backend      # Postgres descartável em container
# E2E (Chromium real, backend real, Postgres descartável na 55434, app na 3310)
npm run build -w @meeting-bot/frontend && npm run test:e2e -w @meeting-bot/backend
E2E_SHOTS=/tmp/capturas npm run test:e2e -w @meeting-bot/backend   # guarda capturas das telas
(cd apps/host-agent && uv run pytest -q)
# worker sem baixar torch: só as dependências dos testes
(cd apps/worker-gpu && uv run --no-project --python 3.12 --with fastapi --with numpy \
  --with httpx --with pytest --with pydantic python -m pytest -q)
npm run dev:backend            # precisa de Postgres, worker-gpu e Ollama acessíveis
npm run dev:frontend           # Vite com proxy para /api
scripts/fixture-ics.sh 20      # convite de teste começando em 20 min
```

- O roteiro para testar o agente ao vivo está em `scripts/roteiro-arquitetura.md`.
- Os cenários de validação ficam em `specs/001-agente-reunioes-mvp/quickstart.md`.

## Limitações conhecidas

- **Seletores do Meet/Teams quebram** quando as plataformas mudam a tela (assistente e Modo
  Agente). Eles ficam em `apps/backend/src/bot/platforms.ts`.
- **Uma gravação pelo computador por vez** ("Gravar agora" ou `AUTO_LOCAL_RECORDING=true`). Numa
  reunião emendada na outra, a segunda espera a primeira parar (3 min sem fala depois do horário)
  ou o **Parar**; o host-agent avisa o conflito. O assistente dentro da chamada não tem esse
  limite: entra em até `MAX_CONCURRENT_BOTS` reuniões ao mesmo tempo.
- **A análise ao vivo usa o modelo local de 4B**, que erra e repete itens. Por isso todo item nasce
  proposto, com evidência validada, e itens repetidos são mesclados na análise final. Ata e ADRs
  saem melhores com o LLM externo ou a assinatura (`LLM_GENERATION_PROVIDER`).
- **Decisão arquitetural criada à mão** não tem trecho da transcrição associado: o ADR dela é
  gerado só com a descrição e o resumo da reunião.
- **Um host-agent por máquina**, ligado a um só usuário (`AGENT_OWNER`). Outros usuários usam o
  upload ou o assistente convidado.
- **Compartilhar reunião** ainda não tem tela (a estrutura `meeting_shares` já existe no backend).
- **O assistente aparece só com as iniciais** na reunião: convidado anônimo não tem foto no Meet
  nem no Teams. A câmera virtual (`BOT_CAMERA`) mostra o ícone, mas como quadro de vídeo.
- **Convite `.ics` de uma só ocorrência** não traz a repetição da série. A importação avisa; exporte
  a série inteira no Outlook.
- **Docker Desktop no Linux** não serve: a VM dele não enxerga a GPU nem mostra os containers do
  Docker nativo. Use o Docker Engine nativo.
- **Servidor de teste (VPS)** não tem transcrição ao vivo nem gravação pelo computador: só o
  assistente na chamada e o passe final pelo OpenRouter.

**Avise os participantes** de que a reunião está sendo gravada e transcrita (LGPD). O nome do
assistente já diz que é a ata, mas isso não substitui o aviso.

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md): fluxo de branches (`develop` → `homolog` → `main`),
testes exigidos e regras que nenhuma mudança pode quebrar. Falhas de segurança:
[SECURITY.md](SECURITY.md). Convivência: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licença

[GNU Affero General Public License v3.0 ou posterior](LICENSE). Quem modificar e oferecer o sistema
como serviço, inclusive pela web, precisa disponibilizar o código-fonte das mudanças.
