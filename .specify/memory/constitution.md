<!--
Sync Impact Report
- Versão: 2.0.0 → 2.1.0 (MINOR: o aviso de gravação sai do sufixo e passa para o próprio nome;
  decisão do usuário em 2026-09-17)
- Princípio modificado: II. Respeito às Políticas da Organização — sem sufixo; o nome do bot MUST
  dizer que é a ata ou a gravação (ex.: "Ata do Sérgio"); nome que não diz ganha "Ata de" na frente.
- Artefatos dependentes: apps/backend/src/bot/identity.ts, apps/backend/src/config.ts, .env.example,
  .env.vps.example, README.md, CLAUDE.md, docs/ARCHITECTURE.md
- TODOs adiados: nenhum

Histórico anterior (1.6.0 → 2.0.0)
- Versão: 1.6.0 → 2.0.0 (MAJOR: o Princípio I passa a falar de "infraestrutura do dono" e não só
  "a máquina"; decisão do usuário em 2026-09-17 para o ambiente de teste no VPS com Dokploy)
- Princípio redefinido: I. Local-first e Privacidade — o conteúdo pode viver num servidor alugado
  pelo dono (VPS de teste), com requisitos próprios (HTTPS, segredos por ambiente, apagar ao fim);
  continua proibido mandar conteúdo para serviços de terceiros fora das exceções de ASR/LLM.
- Princípio modificado: VI. Desktop Nativo, Serviços em Container — o agente ganha o modo "llm"
  (container sem desktop, só executa a assinatura); alertas e captura continuam nativos.
- Seção modificada: Regras Operacionais → "Gravação": no servidor só grava o assistente na chamada.
- Artefatos dependentes: docker-compose.vps.yml, .env.vps.example, docs/vps-dokploy.md, README.md,
  CLAUDE.md, docs/ARCHITECTURE.md
- TODOs adiados: nenhum

Histórico anterior (1.5.0 → 1.6.0)
- Versão: 1.5.0 → 1.6.0 (MINOR: o assistente mostra o ícone do agente na reunião e transcreve ao
  vivo; decisão do usuário em 2026-09-17)
- Princípio modificado: II. Respeito às Políticas da Organização — "não exibe imagem nem câmera"
  passa a "a câmera virtual mostra só o ícone do agente, parado"; nada é filmado e o sufixo de
  gravação continua obrigatório no nome.
- Princípio I (assinatura pessoal): nas reuniões do dono, a geração automática espera a assinatura
  voltar em vez de trocar para o modelo local ("gerar sempre com o Claude").
- Seção modificada: Regras Operacionais → "Transcrição": a gravação pelo assistente também tem o
  passe ao vivo (local), com o agente arquiteto ao vivo.
- Artefatos dependentes: README.md, CLAUDE.md, .env.example, docs/ARCHITECTURE.md,
  docs/analise/plataforma-multiusuario.md
- TODOs adiados: nenhum

Histórico anterior (1.4.0 → 1.5.0)
- Versão: 1.4.0 → 1.5.0 (MINOR: regra operacional de gravação — quem grava no horário é o assistente
  convidado, de dentro da chamada; decisão do usuário em 2026-09-17)
- Seção modificada: Regras Operacionais → "Gravação", "Canais de áudio" e "Agente do desktop":
  - no horário, o assistente entra em toda reunião da agenda com link do Teams/Meet, exceto as
    marcadas "Não gravar", e grava de dentro da chamada;
  - o computador não grava sozinho (o usuário nem sempre entra na reunião); reunião sem link só
    grava por ação manual ("Gravar agora").
- Artefatos dependentes: README.md, CLAUDE.md, .env.example, docs/ARCHITECTURE.md
- TODOs adiados: nenhum

Histórico anterior (1.3.0 → 1.4.0)
- Versão: 1.3.0 → 1.4.0 (MINOR: a exceção de LLM externo ganha a assinatura pessoal do dono
  — Claude Code e Codex — executada pelo host-agent; decisão do usuário em 2026-09-17)
- Princípio modificado: I. Local-first e Privacidade — exceção "LLM externo opcional" passa a
  aceitar `claude`/`codex` (CLI oficial com o login do dono), nos botões e na geração automática.
- Artefatos dependentes: README.md, CLAUDE.md, .env.example, docs/ARCHITECTURE.md,
  docs/agente-arquiteto.md, docs/analise/plataforma-multiusuario.md, apps/host-agent
- TODOs adiados: nenhum

Histórico anterior (1.2.0 → 1.3.0)
- Versão: 1.2.0 → 1.3.0 (MINOR: a exceção de LLM externo passa a cobrir a geração automática
  pós-reunião quando escolhida no `.env`, e a chave pode vir do `.env` até existir o cadastro de
  provedores)
- Princípio modificado: I. Local-first e Privacidade — exceção "LLM externo opcional":
  - `LLM_GENERATION_PROVIDER=openrouter` (decisão do usuário em 2026-09-17) vale como escolha
    explícita para a análise pós-reunião automática;
  - a chave pode ficar em `OPENROUTER_API_KEY` (`.env` com modo 600, nunca exposta na interface);
    a chave cifrada no banco chega com o cadastro de provedores (fase F3);
  - o egress libera só `/api/v1/chat/completions`.
- Artefatos dependentes: README.md, CLAUDE.md, .env.example, docs/ARCHITECTURE.md,
  docs/agente-arquiteto.md, docs/analise/plataforma-multiusuario.md
- TODOs adiados: nenhum

Histórico anterior (1.1.0 → 1.2.0)
- Versão: 1.1.0 → 1.2.0 (MINOR: exceção opt-in de LLM externo no Princípio I; regras de
  plataforma multiusuário em Regras Operacionais; identidade do assistente no Princípio II)
- Princípios modificados:
  - I. Local-first e Privacidade: nova exceção "LLM externo opcional" (Q1, aprovada pelo usuário em
    2026-09-16); o racional deixa de dizer "nunca usar LLM externo".
  - II. Respeito às Políticas da Organização: sufixo obrigatório e sem imagem na reunião (Q5, Q6).
- Seções ampliadas: Regras Operacionais → "Acesso" (RBAC, isolamento, admin sem leitura de
  conteúdo — Q2; dono do host-agent — Q4).
- Artefatos dependentes: docs/analise/plataforma-multiusuario.md (§10–13), CLAUDE.md, README.md;
  a implementação do AIProvider externo entra na fase F3.
- TODOs adiados: nenhum

Histórico anterior
- 1.0.0 → 1.1.0 (MINOR: exceção opt-in no Princípio I; padrão continua 100% local)
- Princípio modificado: I. Local-first e Privacidade — nova exceção "ASR externo de teste"
  (Deepgram nova-3 via OpenRouter), aprovada pelo usuário em 2026-09-16
- Seções adicionadas: nenhuma. Regras Operacionais → "Transcrição" menciona a exceção
- Artefatos dependentes: spec.md (FR-040/FR-041), research.md (R21), plan.md (Constitution
  Check), tasks.md (T114–T119), .env.example
- TODOs adiados: nenhum

Histórico
- 1.0.0 (2026-09-16): adoção inicial
- Princípios definidos:
  I. Local-first e Privacidade
  II. Respeito às Políticas da Organização
  III. Humano no Controle
  IV. Rastreabilidade
  V. Orçamento de GPU Consciente
  VI. Desktop Nativo, Serviços em Container
  VII. Evolução Incremental e Verificável
  VIII. Stack e Idioma Padronizados
- Seções adicionadas: Regras Operacionais; Fluxo de Desenvolvimento e Quality Gates; Governança
- Seções removidas: nenhuma
- Templates (.specify/templates/*): nenhum ajuste necessário — o "Constitution Check" do
  plan-template lê este arquivo em tempo de execução
- TODOs adiados: nenhum
-->

# Agente Local de Reuniões e Arquitetura (meeting-bot) Constitution

## Core Principles

### I. Local-first e Privacidade (NÃO NEGOCIÁVEL)

- `LOCAL_ONLY=true` é o único modo suportado. Áudio, transcrição, ata, itens extraídos e
  documentos ficam na **infraestrutura do dono** — o computador dele ou um servidor que ele
  controla — e não podem ir para serviços de terceiros, salvo as exceções de ASR e LLM abaixo.
- **Fora do computador do dono (servidor de teste):** só com decisão explícita dele, e então
  MUST ter HTTPS em todo acesso, segredos próprios daquele ambiente (nunca os do computador),
  cópia apenas do que o teste precisa e remoção dos volumes quando o teste acabar. Sem GPU no
  servidor, o passe ao vivo fica desligado (ele é sempre local) e o passe final usa a exceção de
  ASR externo.
- Todo LLM, modelo de fala, diarização e embedding MUST rodar localmente (Ollama, faster-whisper,
  pyannote etc.). Adaptadores para provedores externos não podem ser habilitados por padrão
  e qualquer chamada externa MUST ser bloqueada e registrada em log de auditoria.
- **Exceção — ASR externo de teste (opt-in):** com `ALLOW_EXTERNAL_ASR=true`, o áudio pode ser
  enviado ao endpoint de transcrição do OpenRouter (padrão `deepgram/nova-3`), somente no passe
  final e em uploads, e somente quando escolhido no `.env` (`ASR_PROVIDER=openrouter`) ou por
  reunião. Requisitos: o Whisper local continua o padrão; o ao vivo é sempre local; o LLM é
  sempre local; o egress libera apenas o caminho `/api/v1/audio/transcriptions`; cada envio é
  registrado na auditoria (sem conteúdo); a UI MUST avisar quando uma transcrição usou o
  provedor externo. Sem a flag, qualquer tentativa é recusada.
- **Exceção — LLM externo opcional (opt-in):** com `ALLOW_EXTERNAL_LLM=true`, gerações de IA
  pós-reunião (ata, resumo, análise, ADR e demais documentos) podem usar um provedor externo
  configurado (OpenRouter primeiro, depois OpenAI), somente quando escolhido explicitamente:
  a cada pedido na interface, ou para a análise automática pós-reunião com
  `LLM_GENERATION_PROVIDER=openrouter` no `.env`. Requisitos:
  - o LLM local (Ollama) continua o padrão e a análise ao vivo é sempre local;
  - as chaves nunca aparecem na interface nem em logs; enquanto não houver cadastro de
    provedores, a chave fica no `.env` (modo 600); com o cadastro, cifrada no banco e mostrada só
    pelo final;
  - o egress libera apenas os endpoints de geração do provedor configurado;
  - cada chamada é registrada com uso e custo, sem conteúdo;
  - a UI MUST avisar antes de enviar um pedido e marcar o que foi gerado fora;
  - toda saída continua proposta (Princípio III).

  **Assinatura pessoal (Claude Code / Codex):** com `CLAUDE_CLI_ENABLED`/`CODEX_CLI_ENABLED`
  (além da flag acima), a geração pode usar a assinatura do dono da máquina. Requisitos:
  - quem executa é o host-agent nativo, com o CLI oficial sem modificação e o login feito pelo
    fluxo do próprio fornecedor; o backend nunca lê, guarda ou repassa credenciais;
  - vale só para as reuniões do dono do host-agent (`AGENT_OWNER`); reunião de outra pessoa
    nunca usa essa assinatura (a geração automática dela usa o modelo local); nas reuniões do dono,
    assinatura fora do ar faz a geração automática esperar, sem trocar de modelo;
  - o CLI roda isolado: sem ferramentas, hooks, MCP ou instruções do usuário, numa pasta
    temporária, com o conteúdo por stdin;
  - a UI MUST avisar que planos pessoais seguem os termos de consumidor.

  Sem a flag, qualquer tentativa é recusada e auditada.
- Saídas de rede permitidas: download inicial de imagens e modelos, e integrações
  corporativas aprovadas (Princípio II). Após o download, bibliotecas de modelos MUST operar em
  modo offline (ex.: `HF_HUB_OFFLINE=1`).
- A interface web MUST escutar apenas em `127.0.0.1` por padrão; exposição em rede exige
  HTTPS e autenticação.

Racional: as reuniões contêm dados corporativos e de saúde pública, por isso o padrão é 100%
local. As exceções de ASR e LLM existem por decisão explícita do usuário (2026-09-16): a de ASR
serve para comparar a qualidade da transcrição; a de LLM serve para gerações de melhor
qualidade quando ele quiser. Nas duas, o usuário responde por usá-las apenas com conteúdo que
a política da organização permite enviar.

### II. Respeito às Políticas da Organização (NÃO NEGOCIÁVEL)

- É proibido contornar controles de segurança: sem scraping de Outlook/Teams para burlar
  bloqueio de apps, sem encaminhar e-mails corporativos para fora, sem automação que simule o
  usuário para obter dados que a organização não liberou.
- Senhas corporativas MUST NOT ser solicitadas, armazenadas ou registradas. Tokens OAuth, quando
  houver, ficam no keyring do usuário.
- Integrações corporativas (Microsoft Graph, transcrição oficial do Teams, bots de reunião) só
  entram com aval formal da TI. Até lá, o calendário entra por importação `.ics` e cadastro
  manual.
- O bot convidado (Modo Agente) só entra por admissão explícita na reunião e MUST se identificar
  como gravação: o próprio nome na sala MUST dizer que é a ata ou a gravação (ex.: "Ata do
  Sérgio"), sem sufixo. Nome sem "ata", "gravação", "record" ou "transcrição" entra com "Ata de" na
  frente; entrar só com o nome de uma pessoa não é permitido. O bot MUST NOT se passar por uma
  pessoa presente. Ele entra como convidado anônimo, então a
  reunião mostra as iniciais do nome — convidado não tem foto. Com `BOT_CAMERA=true` (desligado
  por padrão, porque no Teams vira um quadro de vídeo) a câmera virtual mostra só o ícone do
  agente, parado. O bot MUST NOT filmar nem transmitir vídeo de ninguém.

Racional: o tenant bloqueia apps e acesso por e-mail; o usuário exigiu nunca burlar políticas.

### III. Humano no Controle

- Todo item gerado por IA (decisão, decisão arquitetural, risco, requisito, pendência,
  responsável, prazo, ADR) nasce com status `proposto` e só se torna `aprovado` por ação humana.
- Itens podem ser editados, aprovados, rejeitados ou corrigidos; rejeições permanecem
  registradas.
- Um ADR MUST NOT ser registrado ou exportado como definitivo sem aprovação explícita.
- A UI MUST distinguir visualmente conteúdo proposto pela IA de conteúdo aprovado.

Racional: o LLM local medido (qwen3.5:4b) acerta a maioria dos itens mas inventa e duplica
alguns (docs/analise/agente-local.md §14).

### IV. Rastreabilidade

- Todo item extraído MUST referenciar ao menos um segmento de transcrição existente (id e
  timestamp); itens sem evidência válida são descartados antes de persistir.
- Quando uma retranscrição substitui segmentos, as referências MUST ser remapeadas por tempo.
- Edições humanas MUST gravar histórico (valor anterior, novo valor, autor, data).
- Reunião, áudio por canal, segmentos, itens, resumos, ADRs sugeridos e embeddings são
  armazenados em entidades separadas e ligadas por chave.

Racional: uma decisão só é confiável se for possível ouvir ou ler de onde ela veio.

### V. Orçamento de GPU Consciente

- A VRAM disponível (RTX 4050, 6 GB) é restrição de projeto. Todo componente que usa GPU MUST
  declarar seu consumo medido e respeitar o orçamento da fase (durante a reunião: ASR + LLM
  pequeno; pós-reunião: cargas sequenciais).
- Padrões vigentes: faster-whisper `large-v3-turbo` int8 (~1,4 GB) e `qwen3.5:4b` com contexto
  de 4k (~3 GB). Embeddings rodam em CPU.
- Trocar ou adicionar modelo exige medição real na máquina (tempo, VRAM, qualidade em pt-BR)
  registrada na documentação antes da adoção.
- Falta de VRAM MUST degradar de forma controlada (fila, offload, menor frequência), nunca
  derrubar a gravação.

Racional: medições mostraram que `openai_whisper` (5,2 GB) e modelos 8B inviabilizam o
uso simultâneo.

### VI. Desktop Nativo, Serviços em Container

- Notificações, som, abertura de links, captura PipeWire e keyring rodam no `host-agent`
  nativo (Python 3.12, `systemd --user`, `graphical-session.target`).
- Backend, workers, banco, filas, LLM e UI rodam no Docker Engine nativo (contexto `default`)
  com NVIDIA Container Toolkit. Docker Desktop MUST NOT ser usado para este projeto.
- A comunicação host-agent ↔ backend é local (loopback) e autenticada.
- No servidor sem desktop, o agente roda em container no modo `llm` (`AGENTE_MODE=llm`): executa
  só as gerações com a assinatura, não emite alertas nem captura áudio, e o backend recusa a
  gravação pelo computador enquanto for esse o agente conectado.
- A gravação MUST continuar mesmo com o navegador da aplicação fechado.

Racional: a VM do Docker Desktop não acessa GPU, PipeWire nem DBus e limita a CPU.

### VII. Evolução Incremental e Verificável

- A ordem de entrega é MVP → V1 → V2 (backlog em docs/analise/agente-local.md §10);
  funcionalidades de V1/V2 não entram antes do MVP estar validado.
- Cada entrega MUST ter critério de aceite verificável e teste automatizado quando viável
  (unitário/contrato no backend e workers; smoke do pipeline de áudio).
- Nenhuma funcionalidade de reunião é declarada pronta sem validação com reunião real ou
  áudio real.
- Decisões de comportamento que dependem do usuário MUST ser perguntadas antes de implementadas;
  decisões puramente técnicas são pesquisadas, justificadas e documentadas.

Racional: pedido explícito do usuário (spec §24) e seletores/políticas externas que mudam sem
aviso.

### VIII. Stack e Idioma Padronizados

- Backend: Node 24 + TypeScript (evolução do meeting-bot). Workers de ML e host-agent:
  Python 3.12 gerenciado por `uv`. Banco: Postgres + pgvector. Filas/eventos: Redis.
  Frontend: React + Vite + TypeScript.
- Contratos entre serviços (eventos, itens, jobs) são definidos por JSON Schema compartilhado.
- Commits, documentação, textos de UI e prompts em português do Brasil.
- Mudanças de stack exigem emenda a esta constituição.

Racional: aproveita o código validado e a stack principal do usuário.

## Regras Operacionais

- **Gravação**: no horário, o assistente convidado entra em toda reunião da agenda com link do
  Teams/Meet (exceto as marcadas "Não gravar") e grava de dentro da chamada; espera a admissão
  até o fim previsto e sai quando a chamada acaba ou quando fica sozinho depois do fim previsto.
  O computador MUST NOT gravar sozinho: reunião sem link só grava por ação manual ("Gravar
  agora"), que para quando o horário previsto passou e houve 3 minutos sem fala, ou por comando.
  Num servidor (sem desktop) existe só o assistente na chamada. O assistente MUST sair quando a
  chamada termina, quando fica sozinho ou quando não há mais som, para não gravar sala vazia.
  Limite de segurança de 4 horas nos dois casos.
- **Retenção**: o áudio de cada canal é guardado indefinidamente; exclusão só por ação do
  usuário.
- **Calendário (MVP)**: importação de convites `.ics` e cadastro manual; Microsoft Graph apenas
  após aprovação da TI.
- **Canais de áudio**: na gravação pelo computador, microfone do usuário e áudio remoto são
  capturados separadamente, e o canal do microfone é atribuído ao usuário sem diarização; na
  gravação pelo assistente, o áudio da chamada vem num canal só, com diarização.
- **Transcrição**: dois passes — ao vivo (VAD + trechos de 10–30 s, também na gravação pelo
  assistente) e final no áudio completo com diarização do canal remoto. O passe final e os uploads podem, por escolha explícita, usar o
  ASR externo de teste (Princípio I).
- **Acesso**:
  - login com usuário e senha (hash scrypt), com sessões em cookie `httpOnly`;
  - papéis SUPER_ADMIN, ADMIN, USER e VIEWER, com permissões conferidas no backend;
  - cada usuário vê só as próprias reuniões e as compartilhadas com ele;
  - administradores gerenciam contas, mas não leem o conteúdo de terceiros;
  - ações administrativas vão para a auditoria.
- **Agente do desktop**: cada host-agent emite os alertas e, quando pedido, grava só as reuniões
  do seu dono (`AGENT_OWNER`). Por enquanto há um só; host-agent por usuário fica para depois.

## Fluxo de Desenvolvimento e Quality Gates

- Fluxo Spec Kit: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-implement`, com o "Constitution Check" do plano validando os princípios I–VIII.
- Antes de concluir uma tarefa: typecheck/lint sem erros, testes automatizados passando e
  verificação manual do fluxo afetado (UI no navegador quando houver interface).
- Commits pequenos, mensagens em português, sem assinatura de ferramentas de IA; nenhum commit
  sem revisão do diff.
- Segredos (`.env`, tokens, senhas) nunca são versionados; `.rtk/` e artefatos locais ficam
  fora do Git.
- Instalação de pacotes no host, uso de `sudo` e migrações destrutivas exigem confirmação do
  usuário.

## Governance

- Esta constituição prevalece sobre outras práticas do projeto. Planos e tarefas que violem um
  princípio MUST registrar a justificativa na tabela de complexidade do plano ou ser rejeitados.
- Emendas: proposta documentada com motivação → aprovação do usuário → atualização deste
  arquivo com Sync Impact Report → revisão dos artefatos dependentes.
- Versionamento semântico: MAJOR para remoção ou redefinição incompatível de princípio; MINOR
  para princípio ou seção nova ou ampliação material; PATCH para esclarecimentos.
- Revisão de conformidade: a cada `/speckit-plan` e antes de fechar cada entrega (MVP, V1, V2).
- Orientação de execução do dia a dia: `CLAUDE.md` do repositório e
  `docs/analise/agente-local.md`.

**Version**: 2.1.0 | **Ratified**: 2026-09-16 | **Last Amended**: 2026-09-17
