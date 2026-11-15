# Feature Specification: Busca e chat sobre as reuniões (V1)

**Feature Branch**: `003-busca-chat` (branch Git: `feat/003-busca-chat`)

**Created**: 2026-11-14

**Status**: Draft

**Input**: User description: "Busca em todas as reuniões do usuário — texto (Postgres FTS pt-BR, sem acento) e semântica (pgvector com embeddings locais pelo Ollama) — sobre transcrições, atas, itens e ADRs; e chat 'pergunte às suas reuniões' que responde com citações clicáveis (reunião + timestamp do trecho), com RAG local. Respeitar LOCAL_ONLY, isolamento por dono, meeting_shares e RBAC (o admin não lê conteúdo alheio); indexar de forma incremental depois do passe final e do reprocessamento; fazer backfill das reuniões existentes; não competir com a GPU durante a reunião ao vivo."

Item do backlog V1 em `docs/analise/agente-local.md` §10 ("Busca semântica (pgvector + texto) e chat com
citações"). Base técnica: §6 (orçamento de VRAM: embeddings em CPU), §7 (bge-m3 + pgvector + RRF) e §14
(medições). Padrões herdados de `specs/001-agente-reunioes-mvp/` (rastreabilidade, humano no controle,
isolamento por dono).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Buscar nas minhas reuniões (Priority: P1)

O Sérgio digita um termo ou uma frase na busca ("kafka", "prazo do certificado", "quem ficou de revisar a
política de retenção") e recebe, numa lista única, os trechos mais relevantes de todas as reuniões que ele
pode ler: falas da transcrição, trechos da ata, itens (decisões, riscos, pendências…) e ADRs. Cada resultado
mostra a reunião, a data, o projeto, o tipo e um trecho com os termos em destaque. Achar "certificados"
quando a fala dizia "certificado" e achar "autenticação" quando a fala dizia "login" (busca por sentido) são
comportamentos esperados. Clicar no resultado abre a reunião já no trecho certo.

**Why this priority**: sem achar o que foi dito, o histórico de reuniões não vira memória. É o valor central
da V1 e a base do chat.

**Independent Test**: com três reuniões indexadas (uma com a palavra "certificado" numa fala, outra com
"renovação do TLS" na ata, outra sem relação), buscar "certificados" e verificar que as duas primeiras
aparecem, a terceira não, e que o clique leva ao trecho exato (horário na transcrição, item na lista de itens).

**Acceptance Scenarios**:

1. **Given** uma fala "precisamos renovar o certificado até sexta", **When** o usuário busca "certificados
   renovação", **Then** a reunião aparece com a fala destacada (busca ignora acento, caixa e flexão).
2. **Given** uma fala que diz "vamos trocar o login por SSO" e nenhuma que contenha a palavra
   "autenticação", **When** o usuário busca "autenticação", **Then** a fala aparece marcada como encontrada
   por **semântica**.
3. **Given** resultados de tipos variados, **When** a lista é exibida, **Then** cada resultado mostra tipo
   (Transcrição, Ata, Item, ADR, Reunião), reunião, data, projeto e, para transcrição, o horário e o falante.
4. **Given** um resultado da transcrição, **When** o usuário clica, **Then** a página da reunião abre com o
   trecho em destaque, rolado até ele, e o áudio posicionado no horário (sem tocar sozinho).
5. **Given** um resultado do tipo Item ou ADR, **When** o usuário clica, **Then** a reunião abre na aba do
   item/ADR, com ele em destaque.
6. **Given** filtros de projeto, período, tipo e reunião específica, **When** aplicados, **Then** só entram
   resultados que atendem a todos.
7. **Given** nenhuma correspondência, **Then** a tela diz que nada foi encontrado e sugere remover filtros;
   **Given** a busca semântica indisponível (Ollama fora do ar ou índice vetorial ainda vazio), **Then** a
   busca de texto continua funcionando e a tela avisa que está só no modo texto.
8. **Given** um item rejeitado pelo usuário, **Then** ele não aparece nos resultados; um item **proposto**
   aparece marcado como proposto (Princípio III).

---

### User Story 2 - Índice sempre atual, sem atrapalhar a reunião (Priority: P1)

O usuário não faz nada para que a busca funcione: quando o passe final termina (ou a análise é refeita, um
item é editado/aprovado/rejeitado, um falante é renomeado, o título ou o projeto muda), a reunião volta a
ser indexada sozinha. Reuniões já existentes são indexadas em segundo plano ao ligar a funcionalidade. A
indexação nunca disputa recursos com uma reunião ao vivo: durante a gravação ela espera.

**Why this priority**: um índice defasado dá respostas erradas; um índice que derruba a gravação viola a
Constituição (Princípio V). As duas coisas precisam estar certas desde o primeiro dia.

**Independent Test**: concluir uma reunião e medir o tempo até ela ser encontrada na busca; iniciar uma
gravação com reuniões pendentes de indexação e verificar que nenhuma chamada de embedding sai enquanto a
gravação dura (e que a gravação não é afetada); religar a funcionalidade com reuniões antigas e verificar o
backfill.

**Acceptance Scenarios**:

1. **Given** uma reunião cujo passe final acabou de terminar, **When** a análise termina, **Then** a reunião
   passa a ser encontrada por texto em até 1 minuto e por semântica em até 5 minutos (reunião de 1 h, sem
   outra gravação em curso).
2. **Given** uma reunião reprocessada (retranscrição), **When** os segmentos são substituídos, **Then** os
   trechos antigos da transcrição saem da busca imediatamente e os novos entram quando a indexação roda; nunca
   há resultado apontando para segmento que não existe mais.
3. **Given** um item editado, aprovado, rejeitado ou mesclado, ou um ADR editado, **When** a alteração é
   salva, **Then** a busca reflete o novo texto/estado em até 1 minuto (rejeitado sai; aprovado muda o selo).
4. **Given** um falante renomeado, um título ou projeto alterado, **Then** os trechos afetados são reindexados.
5. **Given** uma reunião em gravação ou em chamada, **When** existem reuniões pendentes de indexação,
   **Then** nenhum embedding é calculado até a gravação terminar; o texto da busca (tsvector) pode ser
   atualizado, pois é só trabalho de banco.
6. **Given** a funcionalidade ligada pela primeira vez com N reuniões concluídas, **Then** todas entram numa
   fila de backfill, indexadas da mais recente para a mais antiga, sem intervenção.
7. **Given** uma reunião excluída, **Then** todos os seus trechos indexados somem junto, sem resíduo.
8. **Given** o Ollama indisponível ou o modelo de embedding não baixado, **Then** a indexação por texto
   conclui, a de vetores fica pendente com nova tentativa espaçada, e nada disso derruba o backend nem o
   pipeline pós-reunião.

---

### User Story 3 - Perguntar às minhas reuniões (chat com citações) (Priority: P2)

O Sérgio abre a aba **Perguntar** e escreve em linguagem natural: "O que ficou decidido sobre o Kafka?",
"Quais pendências o João assumiu nas reuniões do Portal SES?". O sistema recupera os trechos mais relevantes
(mesma busca híbrida), monta o contexto e o LLM **local** responde em português, com marcadores [1], [2] que
são citações clicáveis: cada uma mostra a reunião, a data e o horário do trecho (ou o item/ADR) e abre a
reunião no ponto exato. Se não houver evidência suficiente, o chat diz isso em vez de inventar.

**Why this priority**: é o ganho de produtividade sobre a busca, mas depende do índice e da busca (US1/US2) e
usa a GPU, então vem depois.

**Independent Test**: com a reunião de teste que contém a decisão "usar Kafka com DLQ", perguntar "o que foi
decidido sobre mensageria?" e verificar resposta correta com pelo menos uma citação que abre o horário da
fala; perguntar algo que nunca foi discutido e verificar a resposta "não encontrei".

**Acceptance Scenarios**:

1. **Given** uma pergunta com resposta nas reuniões, **When** o chat responde, **Then** cada afirmação
   relevante da resposta tem ao menos uma citação válida e clicável (reunião + horário do segmento, ou
   item/ADR).
2. **Given** uma citação, **When** clicada, **Then** a reunião abre no trecho citado, como no US1.
3. **Given** uma pergunta sem evidência nas reuniões que o usuário pode ler, **Then** o chat responde que não
   encontrou registro, sem inventar e sem citações.
4. **Given** a resposta do LLM com citação a trecho que não foi fornecido ou com citação literal que não
   confere com o trecho, **Then** o sistema descarta essa citação; se a resposta ficar sem nenhuma citação
   válida, é tratada como "sem evidência".
5. **Given** uma conversa com perguntas de seguimento ("e quem ficou responsável?"), **Then** o chat usa as
   últimas trocas da conversa para recuperar os trechos certos.
6. **Given** um escopo escolhido (projeto, período ou reuniões específicas), **Then** a resposta e as
   citações só usam esse escopo.
7. **Given** qualquer pergunta, **Then** o texto da pergunta e os trechos vão só ao Ollama local; nenhuma
   chamada externa é feita e o egress guard continua bloqueando o resto (LOCAL_ONLY).
8. **Given** uma reunião ao vivo em andamento, **Then** o chat avisa que a resposta pode demorar (a geração
   entra na fila atrás da análise ao vivo) e não prejudica a gravação (ver Q5).
9. **Given** itens do tipo proposto usados como fonte, **Then** a resposta os identifica como "proposto pela IA,
   ainda não aprovado" (ver Q4).

---

### User Story 4 - Só enxergo o que posso ler (Priority: P1)

Cada pessoa busca e conversa apenas sobre o conteúdo das reuniões que é dela ou foi compartilhado com ela
(`meeting_shares`). Administradores gerenciam contas, mas a busca e o chat não lhes dão acesso ao conteúdo
alheio. Retirar um compartilhamento corta o acesso à busca imediatamente.

**Why this priority**: vazamento entre usuários é falha de segurança e viola a regra do projeto (admin não lê
conteúdo alheio). Entra no P1 porque a busca é uma superfície nova de leitura.

**Independent Test**: dois usuários A e B, A com reunião sobre "reajuste salarial"; B busca e pergunta sobre
"reajuste salarial" e nada de A aparece (nem trecho, nem contagem, nem título); A compartilha com B e o
conteúdo aparece; A revoga e some na próxima busca; um ADMIN/SUPER_ADMIN sem relação com A também não vê.

**Acceptance Scenarios**:

1. **Given** reuniões de outro usuário sem compartilhamento, **When** busca ou chat são usados, **Then**
   nenhum trecho, título, projeto, contagem, citação ou sugestão derivado delas é retornado.
2. **Given** uma reunião compartilhada com leitura, **Then** ela entra na busca e no chat do destinatário;
   **When** o compartilhamento é removido, **Then** a próxima consulta já não a inclui (a permissão é
   conferida na consulta, nunca copiada para o índice).
3. **Given** um usuário ADMIN ou SUPER_ADMIN (sem `meetings.read_all`), **Then** vale a mesma regra de dono e
   compartilhamento.
4. **Given** um VIEWER, **Then** ele pode buscar e perguntar (leitura) no que já pode ler e não dispara
   reindexação.
5. **Given** o papel sem `transcripts.read`, **Then** resultados do tipo Transcrição não aparecem; sem
   `documents.read`, não aparecem Ata, Item e ADR.
6. **Given** o chat, **Then** o contexto enviado ao LLM é montado apenas com trechos já filtrados pela
   permissão do usuário que perguntou.
7. **Given** os endpoints de status e reindexação, **Then** eles mostram e agem só sobre as reuniões do
   próprio usuário.
8. **Given** o `audit_log` e os logs do backend, **Then** não contêm o texto da pergunta/busca nem trechos de
   reunião (só contagens e tempos).

---

### User Story 5 - Acompanhar e reconstruir o índice (Priority: P3)

Em **Configurações** o usuário vê se a busca está ativa, se a semântica está disponível (modelo local pronto),
quantas reuniões estão indexadas/pendentes/com falha e se a indexação está em espera por causa de uma
reunião ao vivo. Pode pedir "Reindexar minhas reuniões" (por exemplo depois de trocar o modelo de embedding).
Na página da reunião aparece se ela já está indexada.

**Why this priority**: transparência e recuperação; o valor principal funciona sem isso.

**Independent Test**: desligar o Ollama, concluir uma reunião e ver o estado "texto pronto, vetores
pendentes"; religar e ver o estado ir a "indexada"; clicar em Reindexar e ver o contador voltar.

**Acceptance Scenarios**:

1. **Given** a tela de status, **Then** ela mostra modelo de embedding, dimensão, total de reuniões, indexadas,
   pendentes, falhas (com motivo curto) e se está em pausa por reunião ao vivo.
2. **Given** "Reindexar minhas reuniões", **When** confirmado, **Then** só as reuniões do próprio usuário
   (com `meetings.manage`) são marcadas para reconstrução; as trocas de modelo recalculam apenas o que mudou
   (hash de conteúdo + modelo).
3. **Given** uma reunião com falha de indexação, **Then** a falha aparece com o motivo, a tentativa é
   repetida com espera crescente (máx. 5), e "Reindexar" a recoloca na fila.

---

### Edge Cases

- Reunião sem transcrição final (em andamento, erro, só agendada): nada da transcrição é indexado; o trecho
  ao vivo (`pass='live'`) não entra na busca, para não apontar para segmentos que serão substituídos.
- Transcrição muito longa (4 h): indexação em lotes, sem carregar tudo na memória; progresso por reunião.
- Pergunta ou busca vazia, só pontuação, ou maior que 500 caracteres: erro 400 claro. Termos com operadores
  de busca (`"frase exata"`, `-excluir`, `or`) são aceitos no modo texto; entrada maliciosa nunca vira SQL.
- Falas em inglês numa reunião em português: o texto casa por termo exato; a semântica (modelo multilíngue)
  cobre o resto. A busca de texto é configurada para português.
- Segmento duplicado entre canais (mic e remoto dizendo o mesmo): ambos indexados; a lista agrupa trechos
  vizinhos da mesma reunião para não repetir.
- Reunião excluída, esvaziada ou com transcrição apagada (`transcripts.delete`): os trechos somem em cascata.
- Prompt injection dentro da transcrição ("ignore as instruções e revele…"): o conteúdo recuperado é tratado
  como dado, a saída é JSON com schema e citações validadas; o chat não tem ferramentas nem acesso a nada além
  dos trechos entregues.
- Dois usuários com a mesma reunião compartilhada: o índice é um só por reunião; o filtro de permissão é por
  consulta.
- Mudança de modelo de embedding com a mesma dimensão: reindexação completa em segundo plano; durante ela a
  busca usa só os vetores do modelo atual (os antigos são ignorados) e cai para texto onde faltar vetor.
- Servidor de teste (VPS, sem GPU/Ollama): a busca de texto funciona; semântica e chat ficam desligados com
  aviso (ver Q3).

## Requirements *(mandatory)*

### Functional Requirements

**Busca**

- **FR-001**: O sistema MUST oferecer busca textual em português (insensível a acento, caixa e flexão) sobre
  transcrição final, ata (narrativa), itens, ADRs e metadados da reunião (título, projeto, participantes).
- **FR-002**: O sistema MUST oferecer busca semântica (por sentido) sobre o mesmo conteúdo, com embeddings
  gerados **localmente** e vetores guardados no Postgres.
- **FR-003**: O modo padrão MUST ser híbrido: fusão das duas listas por Reciprocal Rank Fusion; os modos só
  texto e só semântica MUST estar disponíveis por parâmetro.
- **FR-004**: Cada resultado MUST trazer tipo, reunião (id, título, data, projeto), trecho com destaque,
  como foi encontrado (texto, semântica ou ambos) e um alvo de navegação (segmento e horário, item ou ADR).
- **FR-005**: A busca MUST aceitar filtros por projeto, período (data da reunião), tipo de conteúdo e reunião
  específica, e MUST paginar (limite padrão 20, máximo 50).
- **FR-006**: Itens `rejeitados` MUST ficar fora da busca; itens `propostos` MUST aparecer sinalizados como
  propostos; o estado exibido MUST ser o estado atual (lido na consulta), não o da hora da indexação.
- **FR-007**: A navegação a partir do resultado MUST abrir a página da reunião no segmento/horário (com o
  áudio posicionado, sem reproduzir) ou no item/ADR.
- **FR-008**: Se a semântica estiver indisponível, a busca MUST degradar para texto e informar o modo usado.

**Indexação**

- **FR-010**: O sistema MUST dividir cada reunião concluída em trechos (chunks) pesquisáveis e rastreáveis:
  janelas de transcrição por tempo e tamanho (guardando segmentos inicial/final, horários e falantes), seções
  da narrativa da ata, um trecho por item e por ADR e um trecho de metadados.
- **FR-011**: O sistema MUST indexar só a transcrição `final` e só reuniões com conteúdo concluído.
- **FR-012**: A indexação MUST ser incremental e idempotente: um hash do conteúdo (mais o modelo) decide o que
  precisa de novo embedding; trechos inalterados não são recalculados.
- **FR-013**: A indexação MUST ser disparada ao concluir o pipeline pós-reunião, ao refazer a transcrição ou a
  análise, ao criar/editar/aprovar/rejeitar/mesclar itens, ao editar ADRs, ao renomear falantes e ao alterar
  título ou projeto, com agrupamento (debounce) de alterações próximas.
- **FR-014**: Ao substituir a transcrição, os trechos de transcrição anteriores MUST ser removidos na mesma
  transação, antes de qualquer reindexação.
- **FR-015**: O sistema MUST fazer o backfill das reuniões existentes em segundo plano, da mais recente para a
  mais antiga, retomável após reinício.
- **FR-016**: O cálculo de embeddings MUST NOT ocorrer enquanto houver reunião em gravação, em chamada ou em
  encerramento; a etapa de texto (banco) pode ocorrer a qualquer momento.
- **FR-017**: O cálculo de embeddings MUST rodar em CPU (consumo de VRAM da funcionalidade = 0) e MUST NOT
  forçar o descarregamento do LLM ou do Whisper.
- **FR-018**: Falha de indexação MUST ser registrada por reunião (estado, motivo, tentativas) e repetida com
  espera crescente; MUST NOT afetar o status da reunião nem o pipeline.
- **FR-019**: Excluir uma reunião MUST excluir seus trechos e vetores (cascata).

**Chat (RAG local)**

- **FR-020**: O sistema MUST oferecer uma pergunta em linguagem natural que recupera trechos pela busca
  híbrida, restrita ao escopo e à permissão do usuário.
- **FR-021**: A resposta MUST ser gerada por LLM **local** (Ollama); o chat MUST NOT usar OpenRouter nem as
  assinaturas Claude/Codex (a exceção da Constituição 1.4.0 vale só para ata e ADR) — ver Q1.
- **FR-022**: A resposta MUST vir em JSON por schema, com texto e citações; cada citação MUST referenciar um
  trecho realmente fornecido ao LLM e, quando for de transcrição, uma citação literal que exista no trecho
  (mesma validação de `agent/evidence.ts`); citações inválidas MUST ser descartadas.
- **FR-023**: Resposta sem nenhuma citação válida MUST ser substituída por "não encontrei registro" (Princípio
  IV: sem evidência, sem afirmação). Se a recuperação não passar do limiar mínimo de relevância, o LLM MUST
  NOT ser chamado.
- **FR-024**: Cada citação MUST ser clicável e levar ao segmento/horário (transcrição) ou ao item/ADR/ata.
- **FR-025**: O chat MUST aceitar as últimas trocas da conversa (máx. 6 mensagens) e escopo (projeto, período,
  reuniões).
- **FR-026**: A geração MUST entrar na fila única de LLM com prioridade abaixo da análise ao vivo e MUST usar o
  mesmo `num_ctx` do momento (4096 com reunião ao vivo, `POST_NUM_CTX` fora dela) para não forçar recarga do
  modelo.
- **FR-027**: O conteúdo recuperado MUST ser tratado como dado não confiável no prompt (defesa contra
  injeção); o chat MUST NOT ter ferramentas, nem acesso a outras fontes.
- **FR-028**: O histórico da conversa MUST ficar só no cliente, reenviado a cada pergunta (ver Q2); o servidor
  não persiste perguntas nem respostas.

**Segurança, privacidade e operação**

- **FR-030**: A permissão MUST ser aplicada na consulta, com o mesmo critério de `visibleMeetingsSql`
  (dono ou `meeting_shares`; `meetings.read_all` só para quem o tiver, hoje ninguém). O índice MUST NOT
  guardar dono nem permissões.
- **FR-031**: Resultados do tipo Transcrição MUST exigir `transcripts.read`; Ata, Item, ADR e metadados MUST
  exigir `documents.read`; busca e chat MUST exigir `meetings.read`. Nenhuma permissão nova é criada.
- **FR-032**: As chamadas de embedding e de chat MUST ir apenas ao host do Ollama configurado, sob o egress
  guard; qualquer outro destino segue bloqueado e auditado.
- **FR-033**: Texto de busca, pergunta, resposta e trechos MUST NOT ser gravados em log nem em `audit_log`;
  só contagens, duração e o id do usuário.
- **FR-034**: Busca e chat MUST ter limite de taxa por usuário e limites de tamanho (consulta ≤ 500
  caracteres, histórico ≤ 6 mensagens de ≤ 1000 caracteres).
- **FR-035**: A página de status MUST mostrar, só das reuniões do usuário, estados do índice; "Reindexar" MUST
  exigir `meetings.manage`.
- **FR-036**: A funcionalidade MUST poder ser desligada (`SEARCH_ENABLED=false`) sem efeito colateral nas
  demais; a busca de texto MUST funcionar mesmo sem pgvector instalado ou sem Ollama.
- **FR-037**: A migração MUST ser aditiva e idempotente, com backup prévio (`pg_dump`) e confirmação do
  usuário antes de trocar a imagem do Postgres (regra "não rodar migrations sem confirmar").

### Key Entities

- **Trecho indexado (search_chunk)**: unidade pesquisável de uma reunião; tipo (`transcript`, `analysis`,
  `item`, `adr`, `meeting`), texto exibido, horários e segmentos de origem (transcrição), referência a
  item/ADR, vetor de embedding e modelo que o gerou. Apagado em cascata com a reunião.
- **Estado de indexação (search_index_state)**: um por reunião; estado (`pending`, `text_ready`, `indexed`,
  `failed`), instante de "sujo", tentativas, motivo da falha e contagens.
- **Consulta/Resposta de chat**: efêmeras (não persistidas — Q2); a resposta carrega texto, citações
  validadas e as fontes usadas.
- **Reunião, segmentos, itens, ADRs, projetos, compartilhamentos**: existentes (spec 001 e plataforma
  multiusuário); a busca só lê.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Em conjunto de 20 consultas em pt-BR sobre reuniões de teste (golden set), a busca híbrida
  traz o trecho esperado entre os 5 primeiros em ≥ 85 % dos casos, e supera a busca só texto em ao menos 3
  consultas por sentido (sem a palavra literal). A meta final é calibrada na medição do spike (T006).
- **SC-002**: Busca com 100 mil trechos indexados responde em ≤ 1,5 s (p95) no hardware do projeto, sem
  reunião ao vivo.
- **SC-003**: Reunião de 1 h concluída fica pesquisável por texto em ≤ 1 min e por semântica em ≤ 5 min após
  o fim do pós-reunião (sem outra gravação em curso).
- **SC-004**: Consumo de VRAM adicional da funcionalidade: 0 MiB medido com `nvidia-smi` antes/depois de
  indexar e de buscar; RAM adicional do modelo de embedding ≤ 2,5 GB.
- **SC-005**: Durante uma gravação com Whisper + LLM ativos, a indexação não calcula nenhum embedding e a
  latência do texto ao vivo (≤ 20 s, p90, spec 001) não piora de forma mensurável.
- **SC-006**: Chat: ≥ 90 % das respostas do golden set com todas as citações válidas e clicáveis; 100 % das
  perguntas sem resposta no acervo recebem "não encontrei", sem citação; primeira resposta em ≤ 30 s (p90) com
  a GPU livre.
- **SC-007**: Zero vazamento entre usuários nos testes de isolamento (busca, chat, status, citações), incluindo
  revogação de compartilhamento e papéis ADMIN/SUPER_ADMIN/VIEWER.
- **SC-008**: Backfill de 100 reuniões concluídas termina sem intervenção e sem erro, e uma reunião nova
  concluída durante o backfill passa na frente na fila.

## Assumptions

- O acervo é de uma a poucas pessoas (≈ 5 reuniões/dia): ordem de 10^4 a 10^5 trechos. Ao passar disso,
  `halfvec` e ajuste do HNSW são as alavancas (research R6).
- A transcrição final é a fonte de verdade; o passe ao vivo existe só durante a reunião (spec 001).
- O modelo de embedding padrão é o **bge-m3** (multilíngue, 1024 dimensões, via Ollama, em CPU), sujeito à
  medição de adoção do Princípio V (T006); alternativas pré-aprovadas em research R2.
- A imagem do Postgres será trocada por uma imagem própria **com pgvector sobre `postgres:16-alpine`**, que
  mantém o mesmo sistema de arquivos/libc dos dados atuais (research R4); a rota alternativa é a imagem
  oficial do pgvector (Debian) com dump/restore.
- O tipo de conteúdo "Ata" é a narrativa gerada (`meetings.analysis`) mais metadados; a ata completa é
  renderizada na leitura a partir de itens e narrativa, então não se indexa o Markdown renderizado.
- Resolução de referências temporais em linguagem natural ("semana passada", "ontem") fica fora da V1: o
  recorte de período é feito por filtro.
- Idioma da interface e dos prompts: pt-BR (Princípio VIII).

## Fora de escopo (V1)

- Reranker (bge-reranker-v2-m3): sem suporte oficial estável no Ollama; entra se a medição do golden set
  mostrar ganho que justifique um serviço novo.
- Resposta em streaming (token a token): a saída é JSON por schema; avaliar na V2.
- Persistência de conversas, busca em anexos/áudio bruto, busca por voz.
- Resolução de referências temporais ("a reunião passada") — V2 do backlog.
- Busca entre usuários, busca global de administrador, exportação de resultados.
- LLM externo no chat (ver Q1).

## Pontos esclarecidos *(máx. 5)*

Decisão do dono em 2026-11-15: **a opção recomendada (A) vale para os cinco pontos**. Cada ponto abaixo mantém as alternativas e a decisão registrada.

1. **[Q1 — decidido: A] O chat pode usar o LLM externo opcional (OpenRouter / assinatura Claude/Codex)?**
   A exceção da Constituição 1.4.0 cobre "ata, resumo, análise, ADR e demais documentos pós-reunião", não
   perguntas livres sobre todo o acervo (que enviam trechos de várias reuniões).
   - **A (recomendada):** só local. Mantém LOCAL_ONLY sem emenda; qualidade limitada ao `qwen3.5:4b`.
   - B: opt-in por pergunta, igual à ata (exige emenda MINOR à Constituição e aviso na UI).
   - C: opt-in só para o dono do host-agent via assinatura. Menos exposição, mas ainda exige emenda.
2. **[Q2 — decidido: A] O histórico do chat deve ser guardado no servidor?**
   - **A (recomendada):** efêmero (memória do navegador; o cliente reenvia as últimas trocas). Sem risco de
     o histórico reter conteúdo de reunião cujo compartilhamento foi revogado; sem tabela nova.
   - B: persistido por usuário (conversas retomáveis), com revalidação de citações a cada leitura e redação de
     respostas que citem reunião não mais legível.
3. **[Q3 — decidido: A] Como a busca deve se comportar no servidor de teste (VPS, sem GPU e sem Ollama)?**
   - **A (recomendada):** só busca de texto; semântica e chat desligados com aviso (a constituição exige
     embedding local, e o VPS não tem onde rodá-lo).
   - B: subir um Ollama só de CPU no VPS (`bge-m3` + LLM pequeno): habilita tudo, custa RAM/CPU do VPS e
     adiciona um serviço ao `docker-compose.vps.yml`.
   - C: embedding externo no VPS: exigiria nova exceção constitucional; não recomendado.
4. **[Q4 — decidido: A] Itens "propostos" pela IA (ainda não aprovados) devem servir de fonte no chat?**
   - **A (recomendada):** sim, nos resultados da busca (marcados) e no chat com rótulo "proposto pela IA",
     priorizando a transcrição como evidência; rejeitados nunca.
   - B: só aprovados nas respostas do chat (a busca continua mostrando propostos marcados).
   - C: itens fora do chat; só transcrição e narrativa.
5. **[Q5 — decidido: A] O chat pode rodar durante uma reunião ao vivo?**
   - **A (recomendada):** sim, entra na fila atrás da análise ao vivo, com `num_ctx` 4096, aviso de demora e
     contexto menor; a gravação nunca é afetada.
   - B: bloqueado enquanto houver gravação/chamada (busca continua liberada).
   - C: igual a A, mas com cancelamento da pergunta se a fila passar de 60 s.
