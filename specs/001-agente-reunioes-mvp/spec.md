# Feature Specification: Agente Local de Reuniões — MVP

**Feature Branch**: `001-agente-reunioes-mvp`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "MVP do Agente Local de Reuniões e Arquitetura (evolução do meeting-bot): reuniões do dia por .ics ou cadastro manual, tela Hoje, alertas nativos 15/5/1 min com Entrar e Não gravar, gravação automática com microfone e áudio remoto separados, transcrição progressiva, agente arquiteto com extração periódica e memória corrente, parada por silêncio após o fim previsto, transcrição final com falantes, ata no template definido, sugestões de ADR, revisão humana com histórico e rastreabilidade, projetos manuais; mantém login, upload e Modo Agente; tudo local."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agenda do dia e alertas antes da reunião (Priority: P1)

O Sérgio importa o convite da reunião (arquivo de calendário exportado do Outlook/Teams) ou
cadastra a reunião manualmente. A tela **Hoje** lista as reuniões do dia em ordem de horário com
seu estado. Antes de cada reunião, mesmo com o navegador fechado, o computador exibe alertas
persistentes com som aos 15, 5 e 1 minuto, com as opções **Entrar** (abre a reunião no navegador)
e **Não gravar**.

**Why this priority**: sem saber quais reuniões existem e quando começam, nenhuma outra etapa
(gravação, transcrição, análise) acontece; o alerta já entrega valor sozinho (não perder
reuniões).

**Independent Test**: importar um convite de teste com início daqui a 16 minutos, fechar o
navegador e verificar os três alertas com som; clicar em **Entrar** abre o link correto.

**Acceptance Scenarios**:

1. **Given** um arquivo de convite válido com título, horário, participantes e link do Teams,
   **When** o usuário o importa, **Then** a reunião aparece na tela Hoje com título, horário,
   duração prevista, organizador, participantes e link.
2. **Given** um convite de reunião recorrente, **When** importado, **Then** as ocorrências dos
   próximos dias aparecem individualmente na agenda.
3. **Given** o mesmo convite importado duas vezes, **When** a segunda importação termina,
   **Then** a reunião não é duplicada (os dados são atualizados).
4. **Given** uma reunião cadastrada manualmente com título, data/hora, duração, link e projeto,
   **When** salva, **Then** aparece na agenda com o estado **Próxima**.
5. **Given** uma reunião às 10:00 e o navegador fechado, **When** o relógio marca 09:45, 09:55 e
   09:59, **Then** o sistema exibe um alerta persistente com som em cada momento, e o de 09:59 é
   o mais insistente.
6. **Given** um alerta aberto, **When** o usuário clica em **Entrar**, **Then** o link da reunião
   abre no navegador padrão; **When** clica em **Não gravar**, **Then** a reunião fica marcada
   para não ser gravada e os alertas seguintes não oferecem gravação.

---

### User Story 2 - Gravação automática e transcrição ao vivo (Priority: P1)

No horário da reunião a gravação começa sozinha, captando separadamente a voz do Sérgio
(microfone) e o áudio dos demais participantes (som da reunião). A tela da reunião em andamento
mostra tempo decorrido, estado da gravação e da transcrição, uso da GPU e a transcrição
aparecendo progressivamente. A gravação termina quando o horário previsto passou e houve 3
minutos sem fala, ou quando o usuário clica em **Parar**.

**Why this priority**: é o núcleo do produto — sem áudio e texto não há ata nem análise.

**Independent Test**: agendar uma reunião para daqui a 2 minutos com 5 minutos de duração, falar
ao microfone e tocar um áudio de outra pessoa no computador; verificar texto aparecendo com
atraso curto, identificação "Sérgio" x demais, e parada automática após 3 minutos de silêncio
depois do horário de término.

**Acceptance Scenarios**:

1. **Given** uma reunião sem a marca **Não gravar**, **When** chega o horário de início,
   **Then** a gravação começa sem nenhum clique e o estado muda para **Em andamento**.
2. **Given** a gravação em curso, **When** o usuário fala, **Then** o texto correspondente
   aparece na tela identificado como o usuário em até 20 segundos após a fala.
3. **Given** a gravação em curso, **When** outro participante fala na reunião, **Then** o texto
   aparece identificado como participante remoto em até 20 segundos.
4. **Given** o horário previsto de término já passou, **When** ninguém fala por 3 minutos,
   **Then** a gravação termina automaticamente.
5. **Given** a gravação em curso, **When** o usuário clica em **Parar**, **Then** a gravação
   termina em até 10 segundos; **When** a gravação atinge 4 horas, **Then** termina sozinha.
6. **Given** uma reunião marcada **Não gravar**, **When** chega o horário, **Then** nada é
   gravado e a reunião aparece como não gravada.
7. **Given** a tela da reunião em andamento, **Then** ela mostra título, tempo decorrido,
   participantes, estado da gravação, estado da transcrição e uso atual da GPU.

---

### User Story 3 - Agente arquiteto durante a reunião (Priority: P2)

Enquanto a reunião acontece, o agente analisa a conversa em janelas periódicas (não a cada
frase) e mostra em painéis paralelos: decisões, decisões arquiteturais, pendências, riscos,
requisitos e demais itens. Periodicamente ele consolida uma memória da reunião com um resumo
corrente e itens sem duplicidade.

**Why this priority**: diferencial do produto, mas depende de a transcrição ao vivo existir.

**Independent Test**: reproduzir na reunião uma conversa roteirizada contendo uma decisão
arquitetural, um risco, um requisito não funcional e uma pendência com responsável e prazo;
verificar que os quatro aparecem nos painéis durante a reunião, cada um com link para o trecho
de origem.

**Acceptance Scenarios**:

1. **Given** uma reunião em andamento com fala nova, **When** se passam no máximo 3 minutos,
   **Then** os itens identificados nesse trecho aparecem nos painéis correspondentes.
2. **Given** um item exibido, **When** o usuário o seleciona, **Then** vê o trecho exato da
   transcrição que o originou (horário e texto).
3. **Given** o mesmo assunto repetido em momentos diferentes, **When** a consolidação roda,
   **Then** o painel mostra um único item para ele.
4. **Given** a reunião em andamento há mais de 15 minutos, **Then** existe um resumo corrente
   da reunião atualizado nos últimos 15 minutos.
5. **Given** um item sem trecho de origem identificável, **Then** ele não é exibido.

---

### User Story 4 - Pós-reunião: transcrição final, ata e ADRs (Priority: P2)

Quando a gravação termina, o sistema produz uma transcrição final mais precisa que substitui a
ao vivo, com o Sérgio identificado pelo microfone e os demais como Speaker 1, Speaker 2...
(renomeáveis). Em seguida gera a ata no template definido e sugestões de ADR para as decisões
arquiteturais.

**Why this priority**: entrega o documento final; depende das histórias 2 e 3.

**Independent Test**: encerrar uma reunião gravada com duas vozes remotas e verificar a
transcrição final com rótulos distintos, a ata com todas as seções do template e ao menos uma
sugestão de ADR quando houver decisão arquitetural.

**Acceptance Scenarios**:

1. **Given** uma reunião encerrada, **When** o processamento termina, **Then** a transcrição
   final substitui a ao vivo e os itens continuam apontando para trechos válidos.
2. **Given** a transcrição final com vozes remotas distintas, **Then** cada voz recebe um
   rótulo próprio (Speaker 1, 2...); **When** o usuário renomeia um rótulo, **Then** o novo nome
   aparece em toda a transcrição e na ata.
3. **Given** o processamento concluído, **Then** existe uma ata com as seções: Data, Horário,
   Duração, Projeto, Participantes, Objetivo, Resumo executivo, Assuntos discutidos, Decisões,
   Decisões arquiteturais, Requisitos identificados, Riscos, Débitos técnicos, Pendências,
   Responsáveis, Próximas ações, Perguntas em aberto, Possíveis ADRs e Observações do Arquiteto;
   seções sem conteúdo informam isso explicitamente.
4. **Given** uma decisão arquitetural identificada, **Then** existe uma sugestão de ADR com
   Contexto, Problema, Alternativas avaliadas, Decisão, Consequências, Riscos e Status
   "proposto".
5. **Given** a ata gerada, **When** o usuário a copia ou baixa, **Then** recebe o texto
   formatado completo.
6. **Given** durante o processamento, **Then** a reunião aparece como **Transcrevendo** e depois
   **Processando**, e por fim **Concluída**.

---

### User Story 5 - Revisão humana dos itens (Priority: P2)

Todo item gerado pelo agente (decisões, ADRs, responsáveis, prazos, requisitos, riscos,
pendências) nasce como **proposto**. O Sérgio pode editar, aprovar ou rejeitar cada item, e
cada mudança fica registrada.

**Why this priority**: a IA local erra (inventa ou duplica itens); sem revisão, o conteúdo não
é confiável.

**Independent Test**: editar o responsável de uma pendência, aprovar uma decisão e rejeitar um
risco; verificar estados, histórico e reflexo na ata.

**Acceptance Scenarios**:

1. **Given** um item proposto, **When** o usuário o aprova, **Then** seu estado passa a
   **aprovado** e o histórico registra quem e quando.
2. **Given** um item, **When** o usuário edita descrição, responsável ou prazo, **Then** o
   histórico guarda o valor anterior e o novo.
3. **Given** um item rejeitado, **Then** ele deixa de aparecer na ata, mas continua consultável
   como rejeitado.
4. **Given** uma sugestão de ADR, **Then** ela só recebe número definitivo (ex.: ADR-001) quando
   aprovada.
5. **Given** a ata, **Then** itens propostos e aprovados são distinguíveis visualmente.

---

### User Story 6 - Projetos, upload e Modo Agente (Priority: P3)

O usuário associa cada reunião a um projeto (lista inicial: Farmácia Digital, SUS Escolha,
Portal SES, InfraVision, Agenith), pode cadastrar novos projetos, envia arquivos de áudio já
gravados para transcrição e análise, e pode enviar o bot convidado para uma reunião (Modo
Agente), que depende de admissão manual.

**Why this priority**: complementos que já existem ou são simples; o fluxo principal funciona
sem eles.

**Independent Test**: criar um projeto, associá-lo a uma reunião, enviar um arquivo de áudio e
verificar ata e itens gerados para ele.

**Acceptance Scenarios**:

1. **Given** a lista de projetos, **When** o usuário escolhe um projeto para a reunião,
   **Then** ele aparece na agenda e na ata.
2. **Given** um título de reunião que contém o nome de um projeto, **When** a reunião é
   importada, **Then** esse projeto já vem sugerido (o usuário pode trocar).
3. **Given** um arquivo de áudio enviado, **When** o processamento termina, **Then** ele tem
   transcrição, itens e ata como uma reunião gravada.
4. **Given** um link de reunião e o Modo Agente, **When** o usuário envia o bot, **Then** o bot
   aguarda admissão, grava ao ser admitido e o resultado segue o mesmo processamento.

### Edge Cases

- Convite sem link de reunião online: a reunião entra na agenda; o alerta não oferece **Entrar**
  e a gravação automática ainda ocorre (reunião presencial com microfone).
- Convite cancelado (arquivo de cancelamento importado): a reunião é marcada como cancelada e não
  é gravada.
- Reuniões sobrepostas: apenas uma gravação local por vez; a segunda reunião avisa o conflito e
  começa quando a primeira terminar ou quando o usuário parar a primeira.
- O computador estava desligado ou suspenso no horário: ao voltar, reuniões em andamento
  (dentro do horário previsto) iniciam a gravação imediatamente; alertas já vencidos não são
  reemitidos.
- O agente nativo não está em execução: a tela Hoje exibe aviso de que alertas e gravação estão
  indisponíveis.
- Sem microfone ou sem saída de áudio disponível: a gravação continua com o canal disponível e
  a tela indica o canal ausente.
- Fone Bluetooth conectado/desconectado durante a reunião: a gravação continua no novo
  dispositivo padrão sem perder o arquivo já gravado.
- GPU ocupada ou memória insuficiente: a transcrição ao vivo atrasa (indicador de atraso na
  tela), mas nenhum áudio é perdido; o processamento final conclui depois.
- Silêncio total durante a reunião: a ata informa que não houve fala reconhecida.
- Reinício do serviço durante uma gravação: o áudio já gravado é preservado e processado.
- Arquivo de convite inválido ou de outro formato: mensagem clara, nada é importado.
- Horários em fuso diferente no convite: exibidos no fuso local do usuário.

## Requirements *(mandatory)*

### Functional Requirements

**Agenda**

- **FR-001**: O sistema MUST importar convites no formato padrão de calendário (arquivo .ics,
  incluindo eventos recorrentes e cancelamentos), extraindo título, início, fim, organizador,
  participantes, descrição, local e link de reunião online (Teams ou Meet).
- **FR-002**: O sistema MUST evitar duplicidade ao reimportar o mesmo evento, atualizando os
  dados existentes.
- **FR-003**: Usuários MUST poder cadastrar, editar e excluir reuniões manualmente (título,
  data/hora, duração, link, projeto).
- **FR-004**: A tela Hoje MUST listar as reuniões do dia em ordem de horário com os estados
  Próxima, Em andamento, Transcrevendo, Processando, Concluída (além de Não gravada, Cancelada e
  Erro), e permitir navegar para outros dias.

**Alertas e entrada**

- **FR-005**: O sistema MUST emitir alertas locais com som aos 15, 5 e 1 minuto antes de cada
  reunião, independentemente de o navegador da aplicação estar aberto.
- **FR-006**: O alerta de 1 minuto MUST exigir interação (permanecer visível até ser
  respondido ou até a reunião começar) e repetir o som.
- **FR-007**: Os alertas MUST oferecer **Entrar** (abre o link da reunião no navegador padrão)
  quando houver link, e **Não gravar**.
- **FR-008**: A interface MUST indicar quando o agente nativo (alertas e captura) não está
  ativo.

**Gravação**

- **FR-009**: O sistema MUST iniciar a gravação automaticamente no horário de início de cada
  reunião não marcada como **Não gravar**, e MUST permitir iniciar manualmente uma gravação
  para qualquer reunião.
- **FR-010**: A gravação MUST capturar em canais separados o microfone do usuário e o áudio
  remoto reproduzido pelo computador.
- **FR-011**: A gravação MUST terminar quando (a) o horário previsto de término passou e houve
  3 minutos consecutivos sem fala em nenhum canal, (b) o usuário clicar em **Parar**, ou
  (c) atingir 4 horas.
- **FR-012**: O áudio de cada canal MUST ser guardado indefinidamente e ficar disponível para
  ouvir na tela da reunião.
- **FR-013**: Apenas uma gravação local MUST ocorrer por vez; conflitos MUST ser informados.

**Transcrição**

- **FR-014**: O sistema MUST exibir a transcrição progressivamente durante a gravação, com
  atraso típico de até 20 segundos em relação à fala.
- **FR-015**: Cada trecho MUST registrar horário relativo ao início, canal e falante.
- **FR-016**: O canal do microfone MUST ser atribuído ao usuário (nome configurável, padrão
  "Sérgio") sem necessidade de identificação por voz.
- **FR-017**: Ao fim da gravação, o sistema MUST produzir uma transcrição final que substitui a
  ao vivo, com falantes remotos distintos rotulados como Speaker 1, Speaker 2...
- **FR-018**: Usuários MUST poder renomear rótulos de falantes, refletindo em toda a reunião.
- **FR-019**: A tela da reunião em andamento MUST mostrar tempo decorrido, participantes,
  estado da gravação, estado/atraso da transcrição e uso atual da GPU.

**Agente arquiteto**

- **FR-020**: Durante a gravação, o sistema MUST analisar a transcrição em janelas periódicas
  (no máximo a cada 3 minutos de fala nova, nunca a cada frase) e extrair itens dos tipos:
  decisão, decisão arquitetural, pendência, risco, requisito funcional, requisito não funcional,
  regra de negócio, restrição, premissa, pergunta em aberto e débito técnico.
- **FR-021**: Pendências MUST ter ação, responsável, prazo, dependência e status; decisões MUST
  ter responsável, motivação, impacto, sistema afetado e prazo quando mencionados; riscos MUST
  ter categoria (arquitetura, segurança, infraestrutura, prazo, integração, dados, performance,
  escalabilidade, governança).
- **FR-022**: Todo item MUST referenciar ao menos um trecho existente da transcrição; itens sem
  referência válida MUST ser descartados.
- **FR-023**: O sistema MUST consolidar periodicamente (no máximo a cada 15 minutos e ao final)
  uma memória da reunião com resumo corrente e itens sem duplicidade.
- **FR-024**: Os itens MUST aparecer durante a reunião em painéis paralelos por tipo
  (Decisões, Decisões arquiteturais, Pendências, Riscos, Requisitos e Outros).
- **FR-025**: Após a transcrição final, o sistema MUST reanalisar a reunião completa,
  reconciliar os itens com os da análise ao vivo e manter as referências válidas.

**Ata e ADR**

- **FR-026**: O sistema MUST gerar a ata no template: Data, Horário, Duração, Projeto,
  Participantes, Objetivo, Resumo executivo, Assuntos discutidos, Decisões, Decisões
  arquiteturais, Requisitos identificados, Riscos, Débitos técnicos, Pendências, Responsáveis,
  Próximas ações, Perguntas em aberto, Possíveis ADRs, Observações do Arquiteto.
- **FR-027**: As seções de itens da ata MUST refletir o estado atual dos itens (rejeitados
  excluídos, propostos identificados) e ser atualizadas quando itens forem revisados.
- **FR-028**: Para cada decisão arquitetural, o sistema MUST sugerir um ADR com Contexto,
  Problema, Alternativas avaliadas, Decisão, Consequências, Riscos e Status.
- **FR-029**: Usuários MUST poder copiar e baixar a ata como texto formatado.

**Revisão humana**

- **FR-030**: Todo item e ADR MUST nascer como **proposto** e poder ser editado, aprovado ou
  rejeitado.
- **FR-031**: Toda mudança em item MUST ser registrada com valor anterior, novo valor, autor e
  data.
- **FR-032**: ADRs MUST receber numeração sequencial definitiva apenas ao serem aprovados.

**Projetos, upload, Modo Agente e acesso**

- **FR-033**: Usuários MUST poder associar uma reunião a um projeto e cadastrar projetos; o
  sistema MUST iniciar com Farmácia Digital, SUS Escolha, Portal SES, InfraVision e Agenith.
- **FR-034**: O sistema MUST sugerir o projeto quando o título da reunião contiver o nome de um
  projeto cadastrado.
- **FR-035**: Usuários MUST poder enviar arquivos de áudio/vídeo, que passam pelo mesmo
  processamento final (transcrição, itens, ata, ADRs).
- **FR-036**: Usuários MUST poder enviar o bot convidado para reuniões Meet/Teams (Modo Agente),
  que só grava após ser admitido e segue o mesmo processamento.
- **FR-037**: O acesso MUST exigir login com usuário e senha; mais de um usuário pode existir.
- **FR-038**: Nenhum áudio, transcrição, item ou ata MUST sair do computador; toda análise por
  IA MUST ser executada localmente, e qualquer tentativa de uso de serviço externo de IA MUST
  ser bloqueada e registrada. Única exceção: o ASR externo de teste (FR-040).
- **FR-039**: O sistema MUST NOT acessar calendário ou e-mail corporativo por nenhum meio
  além dos arquivos importados pelo usuário.
- **FR-040** (adicionado em 2026-09-16, a pedido do usuário): como opção secundária de teste, o
  passe final e os uploads MAY usar um serviço externo de transcrição (Deepgram nova-3 via
  OpenRouter), somente com a liberação explícita na configuração. A transcrição local continua
  o padrão; a transcrição ao vivo e toda a análise por IA continuam locais; cada envio é
  auditado sem conteúdo.
- **FR-041**: A escolha do serviço de transcrição MUST ser possível por configuração (padrão)
  e por reunião (upload e "Reprocessar"), e a interface MUST avisar antes do envio e indicar
  nas reuniões transcritas externamente que o áudio saiu da máquina.

### Key Entities

- **Reunião**: título, início e fim previstos, início e fim reais, organizador, participantes,
  descrição, local, link, plataforma, origem (convite, manual, upload, bot), identificador do
  convite, projeto, estado, marca "não gravar", resumo corrente, ata.
- **Projeto**: nome e palavras associadas.
- **Canal de áudio**: reunião, tipo (microfone, remoto, misto), arquivo, duração.
- **Trecho de transcrição**: reunião, canal, falante, início, fim, texto, passe (ao vivo ou
  final).
- **Falante**: reunião, rótulo (Speaker N ou usuário), nome exibido.
- **Item**: reunião, tipo, título/descrição, atributos do tipo (responsável, prazo, motivação,
  impacto, sistema, dependência, categoria), estado (proposto, aprovado, rejeitado), origem
  (ao vivo, final), trechos de origem.
- **Histórico de item**: item, ação, valor anterior, valor novo, autor, data.
- **Sugestão de ADR**: item vinculado à decisão arquitetural, seções do ADR, número definitivo
  após aprovação.
- **Usuário**: nome de usuário, senha protegida, nome exibido.
- **Registro de auditoria**: tentativas bloqueadas de uso externo e eventos de segurança.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das reuniões importadas ou cadastradas recebem os três alertas no horário
  (tolerância de 30 segundos) com o navegador fechado.
- **SC-002**: A gravação começa em até 30 segundos após o horário de início em 100% das
  reuniões não marcadas como "não gravar", sem nenhum clique.
- **SC-003**: Em reuniões reais, 90% dos trechos falados aparecem na tela em até 20 segundos.
- **SC-004**: Para uma reunião de 1 hora, a ata e os itens finais ficam prontos em até 15
  minutos após o fim da gravação.
- **SC-005**: Em uma conversa roteirizada de teste, ao menos 80% das decisões, riscos,
  requisitos e pendências roteirizados aparecem como itens, e 100% dos itens exibidos apontam
  para um trecho real.
- **SC-006**: A voz do usuário é atribuída corretamente ao usuário em ao menos 95% dos trechos
  do canal do microfone.
- **SC-007**: Nenhum byte de áudio, transcrição ou ata é enviado para fora do computador
  (verificável por auditoria de rede durante uma reunião).
- **SC-008**: O usuário consegue revisar (aprovar/editar/rejeitar) todos os itens de uma
  reunião de 1 hora em até 10 minutos.
- **SC-009**: Uma reunião cadastrada manualmente leva menos de 1 minuto para ser criada.

## Assumptions

- Usuário principal único (Sérgio) no computador onde o agente roda; o sócio pode ter login
  próprio para consultar, mas alertas e gravação são da máquina local.
- O usuário participa das reuniões pelo Teams/Meet no navegador deste computador (Modo
  Assistente) e usa fone ou microfone interno; com alto-falante pode haver eco entre canais.
- Convites são obtidos pelo próprio usuário no Outlook/Teams (download do .ics); o tenant
  corporativo bloqueia integração direta (decisão D2/D5).
- Reuniões em português do Brasil.
- Recorrências são expandidas para os próximos 30 dias a cada importação.
- "Sem fala" significa ausência de voz detectada em ambos os canais.
- O nome exibido do usuário para o canal do microfone é configurável e padrão "Sérgio".
- Qualidade da IA local é limitada (medições em docs/analise/agente-local.md §14); a revisão
  humana é parte do fluxo, não exceção.
- Separação de falantes remotos depende de um modelo local que exige aceite de termos de uso
  do provedor do modelo pelo usuário; sem isso, falantes remotos aparecem como "Remoto".
- O aviso aos participantes sobre a gravação é responsabilidade do usuário.
