# Feature Specification: Nome dos falantes pela chamada

**Feature Branch**: `006-nome-dos-falantes` (branch git `feat/nome-dos-falantes`)

**Created**: 2026-11-18

**Status**: Draft (decisões tomadas em 2026-11-18; seletores de DOM dependem da captura real)

**Input**: User description: "Nome dos falantes pela chamada: enquanto está na reunião, o assistente lê na tela do Teams/Meet quem está falando (indicador de fala ativa + nome do participante) e grava uma linha do tempo (nome, início, fim, relativos ao início do áudio gravado). No passe final, cada \"Speaker N\" da diarização recebe o nome com maior sobreposição de tempo; ao vivo, os trechos da transcrição já saem rotulados com o nome de quem fala. Sem dados da chamada, tudo fica como hoje. Sem biometria de voz (descartada por LGPD), tudo local, sem contornar políticas da organização."

## Contexto

Hoje a transcrição final separa as vozes ("Speaker 1", "Speaker 2"…) com o pyannote, mas só o usuário
sabe quem é quem e precisa renomear cada falante à mão, reunião por reunião
(`apps/frontend/src/components/Speakers.tsx`). Ao vivo a fala sai sem rótulo nenhum
(`speaker = null` no canal `mixed`). A chamada, porém, já mostra o nome de quem fala para qualquer
convidado: o assistente só precisa ler o que está na tela.

Fora de escopo, por decisão do usuário: assinatura/biometria de voz (LGPD); qualquer leitura que a tela do
convidado não mostre; Graph/API de reunião; fala de pessoa fora da chamada (sala presencial).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Falantes da transcrição final já saem com o nome (Priority: P1)

O Sérgio coloca o assistente numa reunião do Teams (ou do Meet) com cinco pessoas. O assistente entra,
grava e, durante a chamada, anota quem aparece falando e em que momento do áudio. Depois do passe final,
a página da reunião já mostra "Maria Souza", "João Lima"… no lugar de "Speaker 1", "Speaker 2". Ele só
corrige o que estiver errado.

**Why this priority**: é o valor principal e elimina o trabalho manual de renomear a cada reunião.

**Independent Test**: reunião de teste (ou áudio gravado + linha do tempo sintética de fixture) com 3
falantes e nomes conhecidos: ao fim do passe final, os 3 "Speaker N" têm o nome certo, com origem "da
chamada"; renomear um à mão mantém o nome manual mesmo reaplicando.

**Acceptance Scenarios**:

1. **Given** uma reunião gravada pelo assistente com a linha do tempo de 3 pessoas, **When** o passe
   final termina, **Then** cada "Speaker N" com sobreposição suficiente com um nome passa a exibir esse
   nome, com a origem "da chamada" e uma confiança.
2. **Given** um "Speaker N" cuja fala se divide entre duas pessoas sem maioria clara, **When** o
   casamento roda, **Then** o rótulo permanece "Speaker N" (nome errado é pior que nome nenhum).
3. **Given** que o usuário renomeou "Speaker 2" para "Dr. Paulo", **When** o passe final é refeito
   (retranscrição) ou os nomes da chamada são reaplicados, **Then** "Dr. Paulo" não é sobrescrito.
4. **Given** dois "Speaker N" que a diarização separou por engano e que pertencem à mesma pessoa,
   **When** o casamento roda, **Then** os dois recebem o mesmo nome.
5. **Given** a transcrição final feita pelo ASR externo de teste (Deepgram) com falantes
   ("Speaker 1 (parte 2)"), **When** o casamento roda, **Then** os nomes são aplicados da mesma forma e
   nada novo sai da máquina.

---

### User Story 2 - A leitura da tela nunca atrapalha a gravação (Priority: P1)

Se o Teams/Meet mudar a tela e os seletores deixarem de achar os participantes, ou se não houver dados
(reunião sem link, "Gravar agora"), o assistente continua gravando e transcrevendo exatamente como
hoje, e a reunião mostra um aviso curto de que os nomes da chamada não estavam disponíveis.

**Why this priority**: restrição de projeto: o áudio é guardado sempre (regra do projeto) e a gravação
não pode cair por causa de um recurso acessório.

**Independent Test**: com a página da reunião de fixture sem nenhum tile reconhecível, ou com o leitor
lançando exceção, o bot permanece na chamada, o áudio é gravado, o passe final roda com "Speaker N" e a
reunião indica "nomes da chamada indisponíveis".

**Acceptance Scenarios**:

1. **Given** seletores que não encontram nada, **When** o assistente está na chamada, **Then** a
   gravação, a transcrição ao vivo e a saída da reunião funcionam como antes e o estado da linha do
   tempo fica "indisponível".
2. **Given** o leitor lançando exceção ou travando, **When** o ciclo do assistente roda, **Then** o
   erro é registrado uma vez no log (sem repetir a cada leitura) e nenhuma etapa do bot é interrompida.
3. **Given** um indicador "preso" (todos falando o tempo todo) ou sem nenhuma fala detectada apesar de
   haver som, **When** a verificação de saúde roda, **Then** a linha do tempo é marcada como
   "parcial/inválida" e não é usada para nomear (sem nomes errados em massa).
4. **Given** uma reunião sem assistente na chamada ("Gravar agora" sem link, gravação pelo host-agent),
   **When** a transcrição termina, **Then** nada muda: "Speaker N" e o canal do microfone como hoje.

---

### User Story 3 - A transcrição ao vivo mostra quem está falando (Priority: P2)

Durante a reunião, na aba de transcrição ao vivo, cada trecho aparece com o nome de quem falava naquele
momento ("Maria Souza: …"), e o agente arquiteto ao vivo passa a ver os nomes nos itens e no resumo.

**Why this priority**: melhora a experiência durante a reunião, mas o passe final já resolve o registro
definitivo.

**Independent Test**: com o assistente numa reunião de teste e a linha do tempo alimentada por fixture,
um trecho ao vivo cujo intervalo cai quase todo sobre uma pessoa sai com o nome dela; trecho sem
maioria sai sem rótulo.

**Acceptance Scenarios**:

1. **Given** a linha do tempo com "Maria Souza" ativa entre 120 s e 134 s, **When** um trecho ao vivo de
   121 s a 133 s é transcrito, **Then** o segmento sai com `speakerName = "Maria Souza"`.
2. **Given** um trecho ao vivo em que duas pessoas se alternam sem que uma tenha ao menos metade do
   tempo, **When** é transcrito, **Then** sai sem nome (como hoje).
3. **Given** o passe final concluído, **When** a transcrição final substitui a ao vivo, **Then** os
   rótulos ao vivo temporários são descartados junto com os segmentos ao vivo (os nomes valem pelo
   casamento do passe final).

---

### User Story 4 - Revisão humana dos nomes (Priority: P2)

Na página da reunião, a lista de falantes mostra de onde veio cada nome ("da chamada", "manual") e a
confiança; o usuário renomeia, volta ao "Speaker N" ou reaplica os nomes da chamada sem retranscrever.

**Why this priority**: o princípio III (humano no controle) exige que o automático seja visível e
corrigível; sem isto o recurso não é confiável.

**Independent Test**: reunião com nomes automáticos: a UI exibe a origem e a confiança; renomear grava
origem "manual"; "Reaplicar nomes da chamada" refaz só os não manuais.

**Acceptance Scenarios**:

1. **Given** falantes com nome da chamada, **When** o usuário abre a reunião, **Then** vê o selo "da
   chamada" e a faixa de confiança (alta / conferir) em cada um.
2. **Given** um nome automático errado, **When** o usuário renomeia, **Then** a origem passa a "manual"
   e a transcrição, a ata e a lista de participantes mostram o nome novo.
3. **Given** um nome da chamada, **When** o usuário escolhe "Voltar ao Speaker N", **Then** o nome
   volta ao rótulo e não é reaplicado automaticamente até pedir "Reaplicar".
4. **Given** um leitor (VIEWER) da reunião, **When** abre a lista de falantes, **Then** vê os nomes mas
   não os controles de edição (como hoje).

---

### Edge Cases

- Convidado anônimo e conta logada no Teams têm telas diferentes; o Meet tem layout em grade, em
  destaque e com painel de pessoas. Cada variante tem fixture e seletor próprio.
- Reuniões grandes: o palco mostra só parte dos participantes; quem não aparece em tile não é
  nomeado (fica "Speaker N").
- Duas pessoas com o mesmo nome de exibição: viram "Nome" e "Nome (2)" (pela chave do participante).
- Nome mudou no meio da chamada (ex.: "Convidado" → nome real): a chave do participante junta os
  intervalos, e vale o último nome.
- O próprio assistente e a tela de apresentação ("Maria está apresentando") nunca viram falantes.
- Fala simultânea: o tempo sobreposto é dividido entre as pessoas ativas, sem dar crédito inteiro a
  ninguém.
- Defasagem entre o indicador visual e o áudio (até ~2 s): o casamento estima o deslocamento por
  reunião.
- Pessoa que entra e sai e volta: vários intervalos, mesma chave.
- Reunião com mais de um assistente ou assistente reiniciado no meio: a linha do tempo é por reunião e
  relativa ao áudio daquela gravação.
- Retranscrição: os "Speaker N" mudam de numeração; o casamento é refeito e nomes manuais continuam
  valendo por rótulo, com aviso na UI (ver plan, Decisão 5).
- Reunião no VPS (sem GPU, ASR externo): funciona igual, pois o casamento é local.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Com o assistente na chamada e `BOT_SPEAKER_NAMES=true`, o sistema MUST ler, na tela do
  Teams (convidado e conta logada) e do Meet, quem está com o indicador de fala ativa e registrar
  intervalos (pessoa, início, fim) relativos ao início do áudio gravado.
- **FR-002**: O sistema MUST ler somente o que a tela do convidado já mostra; MUST NOT abrir
  endpoints internos, interceptar tráfego da plataforma, usar API/Graph nem pedir permissões extras ao
  organizador.
- **FR-003**: O sistema MUST NOT usar assinatura, impressão ou biometria de voz para identificar
  pessoas, nem guardar vetores de voz de pessoas.
- **FR-004**: A leitura MUST ser isolada por plataforma (um módulo de seletores por plataforma, ao lado
  do `platforms.ts`) e qualquer falha dela (seletor, exceção, travamento, página navegando) MUST NOT
  interromper a gravação, a transcrição ao vivo, a saída da reunião nem o passe final.
- **FR-005**: O sistema MUST ignorar o próprio assistente, a pessoa "apresentando" e tiles sem nome, e
  MUST normalizar o nome (remover marcadores como "(Você)", "(Guest)", estado do microfone etc.).
- **FR-006**: O sistema MUST manter uma chave estável por participante (identificador da plataforma
  quando existir, senão o nome normalizado) e MUST desambiguar nomes iguais de pessoas diferentes.
- **FR-007**: O relógio da linha do tempo MUST ser o do áudio gravado: um intervalo em `t` segundos
  corresponde ao mesmo `t` de `transcript_segments.start_seconds`.
- **FR-008**: O sistema MUST persistir a linha do tempo em lotes durante a chamada (perda máxima em
  falha: poucos segundos) e MUST apagá-la junto com a reunião.
- **FR-009**: No passe final, o sistema MUST casar cada "Speaker N" com o nome de maior sobreposição
  temporal, estimando o deslocamento entre indicador e áudio, dividindo fala simultânea e respeitando
  limiares de evidência, pureza e margem; abaixo deles o rótulo MUST permanecer "Speaker N".
- **FR-010**: Dois rótulos MAY receber o mesmo nome (mesma pessoa em 2 clusters). Um rótulo MUST NOT
  receber o nome de duas pessoas.
- **FR-011**: O nome manual MUST prevalecer sobre o nome da chamada em qualquer reaplicação ou
  retranscrição; o rótulo do microfone (`user`) e o rótulo `Remoto` sem diarização MUST NOT ser
  renomeados pelo casamento.
- **FR-012**: Cada nome automático MUST ficar marcado com a origem ("call") e a confiança, e a
  interface MUST mostrar a origem e permitir renomear, voltar ao rótulo e reaplicar.
- **FR-013**: Na transcrição ao vivo do assistente (canal `mixed`), cada segmento MUST receber o nome da
  pessoa com ao menos metade do tempo do segmento; sem maioria, sem nome. Os rótulos ao vivo são
  temporários e MUST NOT entrar em `meeting_speakers`.
- **FR-014**: Sem linha do tempo válida (reunião sem assistente, leitura indisponível, linha do tempo
  inválida), o comportamento MUST ser idêntico ao de hoje; a reunião MUST mostrar o estado da leitura
  (ok / parcial / indisponível).
- **FR-015**: O sistema MUST verificar a saúde da leitura (sem tiles, sem indicador apesar de haver
  som, indicador preso, pouca correlação com o áudio) e MUST descartar para fins de nomeação uma linha
  do tempo reprovada.
- **FR-016**: O sistema MUST registrar na auditoria apenas contadores e estado (ex.: nº de pessoas,
  nº de intervalos, estado), sem nomes nem conteúdo.
- **FR-017**: O casamento MUST funcionar também com as transcrições finais do ASR externo de teste
  (rótulos "Speaker N" e "Speaker N (parte i)"), sem enviar nomes nem a linha do tempo para fora.
- **FR-018**: Nomes obtidos da chamada MUST aparecer onde os nomes de falantes já aparecem (transcrição,
  ata, lista de participantes, agente arquiteto) sem duplicar o dono quando ele também está no convite.
- **FR-019**: O sistema MUST permitir reaplicar os nomes da chamada sem retranscrever
  (`POST /meetings/:id/speakers/apply-call-names`), com a mesma permissão de renomear falantes.
- **FR-020**: O custo da leitura MUST ser desprezível para a gravação (meta: menos de 3% de um núcleo
  e nenhuma espera no ciclo principal do bot).
- **FR-021**: Os nomes de terceiros MUST ser guardados com a reunião e apagados junto com ela (cascade),
  sem prazo próprio, e MUST ser tratados como o resto do conteúdo quanto ao LLM externo: só seguem ao
  provedor de `LLM_GENERATION_PROVIDER` quando `ALLOW_EXTERNAL_LLM=true`, e a linha do tempo
  (`speaker_activity`) nunca é enviada (decisões 1 e 3 do plan.md, tomadas em 2026-11-18).
- **FR-022**: A funcionalidade MUST poder ser desligada por configuração (`BOT_SPEAKER_NAMES=false`),
  voltando exatamente ao comportamento atual.

### Key Entities

- **Atividade de fala (`speaker_activity`)**: um intervalo em que uma pessoa da chamada esteve com o
  indicador de fala ativo. Atributos: reunião, chave do participante, nome exibido, plataforma,
  início e fim em segundos do áudio.
- **Estado da linha do tempo (`meetings.speaker_timeline_meta`)**: resumo da leitura da reunião:
  estado (ok / parcial / indisponível / desligado), fonte (camada de seletor usada), nº de pessoas e
  intervalos, deslocamento estimado.
- **Falante da reunião (`meeting_speakers`, ampliada)**: rótulo, nome exibido, origem do nome
  (`call` / `manual` / sem origem = padrão) e confiança.
- **Segmento (`transcript_segments`)**: sem mudança de estrutura; o rótulo ao vivo temporário usa o
  prefixo de contrato `live:`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Em reuniões reais de 3 a 6 pessoas com a leitura em estado "ok", pelo menos 80% do tempo
  de fala fica com o nome correto após o passe final, sem nenhuma renomeação manual (medido em 3
  reuniões reais, com a verdade conferida pelo usuário).
- **SC-002**: Em nenhuma reunião de validação o casamento atribui o nome de uma pessoa a uma voz de
  outra com confiança "alta"; erros ficam em rótulos marcados "conferir" ou sem nome.
- **SC-003**: Com a leitura quebrada de propósito (seletor inválido, exceção, indicador preso), 100% das
  gravações terminam com áudio íntegro e transcrição final, idênticas ao comportamento sem o recurso.
- **SC-004**: Ao vivo, o nome aparece no segmento no mesmo ciclo em que ele é exibido (sem atraso
  adicional perceptível) em pelo menos 70% dos segmentos de uma fala com uma só pessoa por vez.
- **SC-005**: O usuário reduz de "renomear todos os falantes" para "conferir" em reuniões recorrentes:
  nenhuma ação obrigatória após o passe final quando a confiança é alta.
- **SC-006**: A leitura consome menos de 3% de um núcleo na reunião de validação com 8 participantes.
- **SC-007**: Nenhum nome ou linha do tempo trafega para fora da máquina em nenhum modo (verificado
  pelo egress guard e pelo `ss`, como no quickstart V7 do MVP).

## Assumptions

- O assistente já entra na chamada (convidado ou conta do agente) e grava com ffmpeg a partir do sink
  dedicado; o PCM ao vivo e o `.ogg` partem do mesmo instante de captura.
- A interface do convidado mostra o nome de quem fala (indicador no tile e/ou lista de pessoas); isso
  vale para Teams web e Meet web em inglês (o bot usa `--lang=en-US`; rótulos em português também
  são cobertos).
- Os seletores reais ainda não foram capturados neste repositório: a primeira tarefa é uma captura
  controlada de DOM numa reunião do próprio usuário, gerando fixtures anonimizadas. A estratégia do
  plano parte de hipóteses a confirmar.
- Reuniões presenciais ou com várias pessoas numa mesma sala/conta aparecem como um único nome da
  chamada; fora de escopo separar quem está na sala.
- Só o assistente (processo do backend) lê a tela; o host-agent não participa.
- A diarização continua sendo do pyannote (local) ou do Deepgram (ASR externo de teste); esta feature
  não troca modelos nem usa GPU extra (Princípio V).
