# Feature Specification: Minhas pendências e tarefas

**Feature Branch**: `feat/002-pendencias-tarefas` (diretório de spec fixo: `specs/002-pendencias-tarefas/`)

**Created**: 2026-11-14

**Status**: Draft — 4 questões em aberto (seção "Questões em aberto")

**Input**: "F4 do plano multiusuário (`docs/analise/plataforma-multiusuario.md` §3 #19–#20, §5, §11): Minhas
pendências e tarefas. Itens da reunião (pendências e ações extraídas pela IA, que só viram definitivos com
aprovação humana, e só nas reuniões com a chave "Itens" ligada) viram tarefas com título, descrição, projeto,
reunião e item de origem, responsável, prioridade, prazo e status (5 valores). Tela 'Minhas pendências' com filtros
por status, projeto, prazo e responsável. Tarefa manual também. Isolamento por dono/RBAC e compartilhamento
existente (`meeting_shares`: leitura/edição; admin não lê conteúdo alheio). Reunião reprocessada não duplica tarefa.
Deixar um gancho para a futura integração com o Azure DevOps, sem implementá-la."

## Contexto e recorte

Hoje a pendência é só um **item** da reunião (`meeting_items`, tipo `pendencia`): nasce `proposto`, o humano aprova,
edita ou rejeita, e ela mora dentro da reunião. Falta um lugar para **acompanhar o que eu preciso fazer** depois da
reunião: status de andamento, prazo, prioridade, filtros e uma visão única de todas as reuniões.

**Escopo mínimo valioso desta feature (recomendação):**

1. Tarefa (`tasks`) com histórico (`task_history`), ligada opcionalmente a reunião, item de origem e projeto.
2. Criação por aprovação de uma pendência (sem nenhuma chamada de IA nova) e por ação explícita em qualquer item
   aprovado; criação manual.
3. Tela **Minhas pendências** com filtros, contadores e edição.
4. Isolamento estrito: a tarefa é **pessoal** (só o dono vê); o compartilhamento de reunião permite que o
   destinatário crie as **próprias** tarefas a partir dos itens compartilhados.
5. Gancho de integração externa (`externalRef`), somente leitura, sem integração implementada.

**Fora do escopo** (detalhes em "Fora do escopo"): `documents` e `generation_jobs` da F4, hub "Gerar com IA",
painel completo, delegação ou compartilhamento de tarefas, lembretes, recorrência, Azure DevOps, tela de
compartilhamento de reuniões.

**Decisão sobre `documents` e `generation_jobs`:** ficam **fora**. Tarefas nascem de itens que a IA já extraiu e o
humano já aprovou, ou de cadastro manual; nenhuma geração nova é necessária, então não há fila de jobs a criar.
Documentos (anotações, decisões, análise) são outra entrega, com fila persistente, prompts e provedores; misturar
atrasaria a parte que dá valor imediato. Eles ganham uma spec própria (`specs/00x`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Aprovar uma pendência e ela virar tarefa (Priority: P1)

O Sérgio revisa os itens de uma reunião. Ao **aprovar** uma pendência, ela passa a existir também como tarefa na
lista dele, com título, descrição, prazo (quando o prazo dito é inequívoco), projeto da reunião e link de volta para
o item e o trecho da transcrição de onde veio. Nos outros tipos aprovados (risco, requisito, débito técnico…) ele
pode escolher **Virar tarefa**. Reprocessar a reunião, reabrir e aprovar de novo ou aprovar itens parecidos não cria
tarefa repetida.

**Why this priority**: é o elo que falta entre a ata e o trabalho; sem ele a pendência morre dentro da reunião.

**Independent Test**: numa reunião com a chave "Itens" ligada e uma pendência proposta ("Enviar o desenho da
integração até 30/11", responsável Sérgio), aprovar o item e conferir que a tarefa aparece uma única vez, com prazo
30/11, e que "Gerar ata" de novo mantém uma só tarefa.

**Acceptance Scenarios**:

1. **Given** uma pendência `proposta` e o usuário com permissão de revisar, **When** ele a aprova [NEEDS
   CLARIFICATION Q1, Q2: base de trabalho = criação automática quando o responsável é o aprovador ou está vazio],
   **Then** uma tarefa `a_fazer` nasce com título derivado da descrição, a descrição completa, o projeto da reunião,
   a reunião, o item de origem e a citação do primeiro trecho de evidência.
2. **Given** a pendência com prazo dito "30/11" e outra com "sexta-feira", **When** as tarefas nascem, **Then** a
   primeira tem prazo 30/11 e a segunda fica sem data, mantendo "sexta-feira" como **prazo dito** visível para o
   usuário definir a data.
3. **Given** uma tarefa já criada a partir de um item, **When** o item é reaberto e aprovado de novo, **Then** nada
   é duplicado e a tarefa existente continua a mesma.
4. **Given** uma reunião com itens aprovados e tarefas, **When** o usuário clica em "Gerar ata" de novo
   (reprocessamento), **Then** itens aprovados e suas tarefas permanecem intactos, e uma nova proposta quase igual à
   pendência já aprovada, ao ser aprovada, **não** gera segunda tarefa: o usuário vê o aviso "Já existe uma tarefa
   parecida" com link para ela.
5. **Given** um item **aprovado** de tipo diferente de pendência (por exemplo, um risco), **When** o usuário clica em
   **Virar tarefa**, **Then** a tarefa é criada com os mesmos dados de origem.
6. **Given** um item `proposto` ou `rejeitado`, **When** alguém tenta virar tarefa, **Then** a ação é recusada
   (a IA só sugere; só o que o humano aprovou vira trabalho).
7. **Given** uma tarefa nascida de item, **When** o usuário a abre, **Then** vê reunião, item e trecho de origem e
   pode ir direto para eles (se ainda tiver acesso à reunião).
8. **Given** uma pendência cujo responsável citado é "João" (outra pessoa), **When** o usuário a aprova [NEEDS
   CLARIFICATION Q2], **Then** ela **não** vira tarefa sozinha; o botão **Virar tarefa** continua disponível e,
   usado, cria a tarefa com responsável "João".

---

### User Story 2 - Tela "Minhas pendências" com filtros (Priority: P1)

Uma tela única lista as tarefas do usuário, de todas as reuniões e projetos, com contadores e filtros por **status**,
**projeto**, **prazo** e **responsável**, e permite mudar o status e editar sem sair da lista.

**Why this priority**: sem a tela, a tarefa existiria só no banco; ela é o produto visível da feature.

**Independent Test**: com 8 tarefas variadas, filtrar "Atrasadas" + projeto "Farmácia Digital" mostra só as que
batem, a URL guarda o filtro, e marcar uma como concluída a tira do filtro "Abertas" e atualiza os contadores.

**Acceptance Scenarios**:

1. **Given** tarefas em vários estados, **When** o usuário abre a tela, **Then** vê por padrão as **abertas**
   (`a_fazer`, `em_andamento`, `bloqueada`) ordenadas por prazo (sem prazo no fim) e prioridade, com contadores por
   status e de atrasadas.
2. **Given** a tela aberta, **When** filtra por status, projeto, prazo (atrasadas, hoje, esta semana, este mês, sem
   prazo, intervalo) ou responsável (eu, não confirmado, outra pessoa + nome), **Then** a lista e os contadores
   refletem o filtro e a URL guarda a combinação para voltar depois.
3. **Given** uma tarefa na lista, **When** muda o status pelo seletor, **Then** a mudança é salva na hora, vira
   histórico, e `concluida` registra a data de conclusão.
4. **Given** uma tarefa sem responsável, **Then** aparece o selo **Responsável não confirmado**.
5. **Given** uma tarefa com prazo vencido e status aberto, **Then** aparece destacada como atrasada (texto e ícone,
   não só cor).
6. **Given** nenhuma tarefa ou nenhum resultado, **Then** a tela explica o vazio e como criar tarefas (aprovar
   pendências ou **Nova tarefa**).
7. **Given** um celular, **Then** a lista vira cartões, sem rolagem horizontal, com os mesmos filtros.

---

### User Story 3 - Tarefa manual (Priority: P2)

O usuário cria uma tarefa do zero: solta, ligada a um projeto ou a uma reunião (inclusive de reunião sem a chave
"Itens"). Edita todos os campos, vê o histórico de mudanças e exclui.

**Why this priority**: nem toda pendência sai de uma reunião gravada; o cadastro manual torna a lista confiável como
fonte única.

**Independent Test**: criar "Revisar contrato do fornecedor", prioridade alta, prazo sexta, projeto Portal SES;
editar o prazo; conferir no histórico "prazo: antes/depois" e excluir.

**Acceptance Scenarios**:

1. **Given** o formulário **Nova tarefa**, **When** informa só o título, **Then** a tarefa nasce `a_fazer`,
   prioridade `media`, responsável "eu", sem prazo.
2. **Given** o formulário, **When** escolhe uma reunião à qual tem acesso, **Then** o projeto é preenchido com o da
   reunião (editável) e a tarefa fica ligada a ela.
3. **Given** uma tarefa, **When** edita título, descrição, prioridade, prazo, projeto ou responsável, **Then** o
   histórico guarda valor anterior, novo valor, autor e data (Constituição IV).
4. **Given** um prazo no passado ao criar, **Then** é aceito (a tarefa nasce atrasada) com aviso discreto.
5. **Given** a ação **Excluir**, **When** confirmada, **Then** a tarefa e seu histórico somem; o item de origem, se
   houver, continua aprovado e pode virar tarefa de novo.
6. **Given** títulos vazios, só espaços ou maiores que o limite, **Then** o formulário recusa com mensagem clara.

---

### User Story 4 - Reunião compartilhada e isolamento (Priority: P2)

Uma reunião compartilhada (`meeting_shares`, leitura ou edição) permite ao destinatário ver os itens aprovados e
**criar as próprias tarefas** a partir deles, sem afetar a lista do dono e sem que o dono ou um administrador
leiam essas tarefas. Perder o acesso à reunião não apaga as tarefas, mas corta o vínculo.

**Why this priority**: sustenta o multiusuário (RBAC e isolamento por dono) sem abrir vazamentos novos.

**Independent Test**: Maria (dona) compartilha uma reunião com João (leitura); João vira tarefa um item aprovado;
Maria e um ADMIN não veem a tarefa de João (404 por id, ausente nas listas); Maria revoga o acesso; João continua com
a tarefa, mas o link para a reunião some.

**Acceptance Scenarios**:

1. **Given** uma reunião compartilhada com leitura, **When** o destinatário clica em **Virar tarefa** num item
   aprovado, **Then** cria a própria tarefa (não precisa de permissão de edição da reunião, porque nada na reunião
   muda).
2. **Given** uma tarefa de João, **When** Maria (dona da reunião), um ADMIN ou um SUPER_ADMIN pedem a tarefa por id
   ou listam tarefas, **Then** recebem 404 e a lista não a inclui (ninguém tem permissão de ler tarefas alheias).
3. **Given** que João perdeu o acesso à reunião, **Then** a tarefa continua na lista dele com o texto já copiado e o
   instantâneo da origem, o link para a reunião, o item e o áudio some e a API não revela nada novo da reunião [NEEDS
   CLARIFICATION Q4].
4. **Given** que a reunião foi excluída pelo dono, **Then** as tarefas ligadas a ela permanecem (ligação nula, com
   instantâneo) [NEEDS CLARIFICATION Q4].
5. **Given** um usuário `VIEWER`, **Then** a tela e as rotas de tarefas não aparecem nem respondem (papel só de
   leitura).
6. **Given** João e Maria aprovando o mesmo item numa reunião com edição compartilhada, **Then** cada um tem a sua
   tarefa, uma por item e por pessoa.

---

### User Story 5 - Resumo na tela Hoje e pendências a revisar (Priority: P3)

A tela **Hoje** mostra um cartão com tarefas atrasadas, que vencem hoje e abertas, mais um aviso "N pendências
propostas aguardando sua revisão" que leva às reuniões com itens a revisar.

**Why this priority**: visibilidade rápida; a tela principal já resolve o essencial sem isto.

**Independent Test**: com 2 tarefas atrasadas, 1 vencendo hoje e 3 pendências propostas em reuniões visíveis, o
cartão mostra 2 / 1 / 3 e os links filtram a lista correspondente.

**Acceptance Scenarios**:

1. **Given** tarefas abertas, **Then** o cartão mostra atrasadas, vencem hoje e total aberto, e cada número leva à
   tela já filtrada.
2. **Given** pendências `propostas` em reuniões visíveis ao usuário, **Then** o cartão mostra a contagem e leva à
   lista de reuniões; reuniões sem a chave "Itens" não contam.
3. **Given** que o usuário não tem a permissão de tarefas, **Then** o cartão não aparece.

---

### Edge Cases

- **Dois cliques ao aprovar ou ao virar tarefa:** a segunda requisição não cria nada e devolve a tarefa existente.
- **Item editado depois da tarefa:** a tarefa guarda o texto do momento da criação (e o instantâneo do item); não
  acompanha edições do item. O usuário pode abrir o item pelo link.
- **Item reaberto ou rejeitado depois da tarefa:** a tarefa fica, com o aviso "O item de origem foi reaberto/rejeitado";
  nada é cancelado sozinho (decisão humana).
- **Prazo dito ambíguo** ("semana que vem", "fim do mês", "sexta"): não vira data; o texto fica como prazo dito.
- **Prazo dito em formato `dd/mm`:** o ano é o da reunião; se a data cair antes do dia da reunião, usa o ano seguinte.
- **Responsável com nome parecido com o do usuário** ("Sérgio" para "Sérgio Alexandre"): reconhece só correspondência
  de nome inteiro, usuário, e-mail, ou primeiro nome com 3+ letras; na dúvida, não cria automaticamente.
- **Reunião sem a chave "Itens":** não há itens nem tarefas automáticas; tarefa manual ligada a ela continua válida.
- **Reunião excluída:** a ligação vira nula e a tarefa mantém o instantâneo (título da reunião, data, tipo e
  descrição do item, citação).
- **Usuário desativado:** perde sessões; as tarefas ficam guardadas e voltam se ele for reativado.
- **Muitas tarefas:** a lista é paginada (limite padrão 100, máximo 200) e os contadores vêm de uma consulta à parte.
- **Fuso horário:** "hoje" e "atrasada" usam o fuso do usuário (perfil) ou `APP_TIMEZONE`.
- **Projeto excluído do catálogo:** deixa a tarefa sem projeto (não apaga a tarefa).

## Requirements *(mandatory)*

### Functional Requirements

**Criação a partir de itens**

- **FR-001**: O sistema MUST criar uma tarefa a partir de um item **aprovado**; itens `proposto` ou `rejeitado`
  MUST ser recusados (Constituição III).
- **FR-002**: Ao aprovar um item do tipo `pendencia`, o sistema MUST criar a tarefa do aprovador na mesma requisição
  [NEEDS CLARIFICATION Q1: automático ao aprovar × só ação explícita], desde que o responsável do item seja o
  próprio aprovador ou esteja vazio [NEEDS CLARIFICATION Q2].
- **FR-003**: Para qualquer item aprovado (todos os 11 tipos), o usuário MUST poder usar **Virar tarefa**, com os
  dados de origem preenchidos e campos editáveis antes de confirmar (título, prazo, prioridade, responsável).
- **FR-004**: Deve existir **no máximo uma tarefa por item e por usuário**; repetir a ação (clique duplo, reabrir e
  aprovar, reprocessar) MUST devolver a tarefa existente sem criar outra.
- **FR-005**: Reprocessar a reunião ("Gerar ata" de novo) MUST NOT apagar nem duplicar tarefas. Como o
  reprocessamento só remove propostas não revisadas, itens aprovados e suas tarefas permanecem.
- **FR-006**: Ao criar a tarefa a partir de um item, o sistema MUST detectar tarefa **parecida** do mesmo usuário na
  mesma reunião (similaridade textual como a deduplicação de itens existente). Na criação automática, MUST não criar
  e avisar com link; na ação explícita, MUST pedir confirmação ("Criar mesmo assim").
- **FR-007**: A tarefa MUST guardar: item de origem, reunião, projeto (herdado da reunião, editável) e um
  **instantâneo** da origem (título e data da reunião, tipo e descrição do item, primeira citação de evidência com
  tempo), para continuar compreensível se a reunião sumir ou o acesso for revogado.
- **FR-008**: O título MUST ser derivado da descrição do item (primeira frase, até 120 caracteres) e a descrição
  MUST conservar o texto integral do item.
- **FR-009**: O prazo dito do item MUST virar data só quando inequívoco (`AAAA-MM-DD`, `dd/mm/aaaa`, `dd/mm`, "hoje",
  "amanhã", sempre relativo à data da reunião); nos demais casos, MUST ficar como **prazo dito** (texto), sem data.
- **FR-010**: O responsável MUST ser classificado como `eu` (o próprio usuário), `outra pessoa` (nome em texto) ou
  `não confirmado` (vazio). Pendência sem responsável MUST mostrar **Responsável não confirmado**.

**Tarefa: campos, estados, histórico**

- **FR-011**: A tarefa MUST ter: título (3–200 caracteres), descrição (até 4000), status, prioridade, prazo (data,
  sem hora), prazo dito, projeto, reunião, item de origem, responsável (tipo + nome), origem da criação, data de
  conclusão e datas de criação e alteração.
- **FR-012**: Status (5 valores) MUST ser `a_fazer`, `em_andamento`, `bloqueada`, `concluida`, `cancelada`; qualquer
  transição é permitida e todas ficam no histórico; `concluida` registra `completedAt`, e sair dela o limpa.
  Abertas = `a_fazer`, `em_andamento`, `bloqueada`.
- **FR-013**: Prioridade MUST ser `baixa`, `media`, `alta` ou `urgente` (padrão `media`).
- **FR-014**: Toda criação, edição e mudança de status MUST gravar histórico com valor anterior, novo valor, autor e
  data (Constituição IV). Excluir remove a tarefa e seu histórico.
- **FR-015**: O usuário MUST poder criar, editar e excluir tarefas manuais (soltas ou ligadas a reunião e/ou
  projeto), com as mesmas validações das tarefas de item.
- **FR-016**: A tarefa MUST expor um campo `externalRef` somente leitura (padrão nulo) reservado a integrações
  externas futuras (ver `contracts/azure-devops-hook.md`); nenhuma integração é executada nesta feature e nenhum
  dado sai da máquina.

**Tela e consultas**

- **FR-017**: A tela **Minhas pendências** MUST listar as tarefas do usuário de todas as reuniões, por padrão as
  abertas, com ordenação por prazo, prioridade, última alteração ou criação.
- **FR-018**: A lista MUST filtrar por status (um ou vários), projeto (ou "sem projeto"), prazo (atrasadas, hoje,
  semana, mês, sem prazo, intervalo), responsável (eu, não confirmado, outra pessoa e parte do nome), prioridade,
  reunião e busca por texto no título e na descrição; os filtros MUST ficar na URL.
- **FR-019**: A tela MUST mostrar contadores por status, de atrasadas, de vencem hoje e de sem responsável
  confirmado, calculados sobre todas as tarefas do usuário (independentes do filtro).
- **FR-020**: Mudar status MUST ser possível direto na lista; editar MUST abrir um diálogo com histórico.
- **FR-021**: A página da reunião MUST mostrar o estado da tarefa de cada item (chip "Tarefa criada" com link) e
  listar as tarefas do usuário ligadas à reunião.
- **FR-022**: A interface MUST distinguir visualmente tarefa nascida de proposta da IA aprovada pelo humano, tarefa
  manual e o selo "Responsável não confirmado" (Constituição III), e não depender só de cor para atrasada ou
  prioridade.

**Acesso e privacidade**

- **FR-023**: Tarefas MUST ser **pessoais**: só o dono (`owner_id`) as vê e altera [NEEDS CLARIFICATION Q3: pessoal ×
  delegável × compartilhada]. Consultar tarefa alheia MUST dar 404 (nunca 403), inclusive para ADMIN e SUPER_ADMIN;
  nenhuma permissão, nem `meetings.read_all`, MUST dar leitura de tarefas de terceiros.
- **FR-024**: Duas permissões novas: `tasks.read` e `tasks.manage`, concedidas a USER, ADMIN e SUPER_ADMIN; VIEWER não
  as tem. Frontend esconde o que não se aplica; o backend decide.
- **FR-025**: Criar tarefa a partir de item MUST exigir acesso de **leitura** à reunião (dono, `read` ou `edit` em
  `meeting_shares`) e `tasks.manage`; aprovar o item (e a criação automática) continua exigindo acesso de escrita.
- **FR-026**: Dados da reunião mostrados numa tarefa (título, data, link, projeto, trecho) MUST ser entregues só
  enquanto o usuário **ainda** tiver acesso à reunião; sem acesso, a resposta traz só o instantâneo gravado na
  criação [NEEDS CLARIFICATION Q4: o que fazer com o instantâneo na revogação].
- **FR-027**: Excluir uma reunião MUST manter as tarefas ligadas a ela, com ligações de reunião e item nulas e o
  instantâneo preservado [NEEDS CLARIFICATION Q4].
- **FR-028**: Nenhuma operação desta feature MUST chamar LLM, ASR ou serviço externo; `LOCAL_ONLY` permanece
  integral. Nenhuma tarefa é criada por IA sem aprovação humana.

**Resumo e revisão (P3)**

- **FR-029**: A tela Hoje MUST mostrar um cartão com atrasadas, vencem hoje, abertas e "pendências propostas a
  revisar" (itens `pendencia` `propostos` em reuniões visíveis com a chave "Itens" ligada).

**Documentação e operação**

- **FR-030**: A migração MUST ser aditiva e idempotente no `schema.ts` (sem apagar nem alterar dados existentes) e
  MUST NOT criar tarefas retroativas a partir de itens já aprovados.
- **FR-031**: Mudança de comportamento MUST atualizar `README.md`, `README.en.md` e `README.es.md`,
  `docs/ARCHITECTURE.md`, `CHANGELOG.md` e o estado da F4 em `docs/analise/plataforma-multiusuario.md`.

### Key Entities

- **Tarefa (`tasks`)**: título, descrição, status, prioridade, prazo, prazo dito, responsável (tipo e nome), dono,
  projeto, reunião, item de origem, instantâneo da origem, origem da criação, referência externa, conclusão.
- **Histórico de tarefa (`task_history`)**: tarefa, ação, antes, depois, autor, data.
- **Item** (existente): `meeting_items` de origem; **Reunião**, **Projeto**, **Compartilhamento (`meeting_shares`)**
  e **Usuário** (existentes), apenas referenciados.

## Questões em aberto

Cada marcador abaixo muda escopo ou modelo. O plano e as tarefas seguem a **recomendação como base de trabalho**,
isolando o que depende da resposta (tarefas marcadas `[Q1]`…`[Q4]`); nenhuma resposta foi assumida como decidida.

**Q1 — Gatilho "aprovar → tarefa" (FR-002).** Aprovar uma pendência cria a tarefa na hora?
- A) **Automático ao aprovar** `pendencia`; outros tipos só por **Virar tarefa**.
- B) Só por ação explícita (**Virar tarefa**) em qualquer tipo.
- C) Ao aprovar, abrir um diálogo "Criar tarefa também?".
- **Recomendação: A.** Aprovar já é o ato humano exigido pela Constituição III; a revisão de uma reunião de 1 hora
  (SC-008 do MVP, 10 min) não comporta um diálogo por item. Se escolher B, o gancho de aprovação sai do plano (menos
  código, mais cliques); C amplia a tela de revisão.

**Q2 — Quais pendências viram tarefa sozinhas (FR-002, FR-009, FR-010).** Quando o responsável do item é outra
pessoa?
- A) Todas as aprovadas viram tarefa, com o responsável como o item disse.
- B) **Só quando o responsável é o aprovador ou está vazio**; as de outra pessoa só pelo botão **Virar tarefa**.
- C) Só quando o responsável é o aprovador (vazio não cria).
- **Recomendação: B.** Mantém "Minhas pendências" realmente minha, sem ruído de terceiros, e não perde a pendência
  sem dono (que aparece como "Responsável não confirmado"). Depende de reconhecer o nome do aprovador (ver research
  R5).

**Q3 — Tarefa pessoal ou delegável/compartilhada (FR-023, US4).**
- A) **Pessoal**: só o dono vê; responsável é rótulo (eu / outra pessoa em texto / não confirmado).
- B) **Delegável**: a tarefa pode ser atribuída a outro usuário com acesso à reunião, que a vê e muda o status.
- C) **Compartilhada** com todos que têm acesso à reunião (tarefas da reunião).
- **Recomendação: A.** É a menor superfície de vazamento, cumpre "admin não lê conteúdo alheio" sem exceções e
  entrega o valor central (minha lista). B exige `assignee_id`, regras de visibilidade e de edição por papel; C exige
  uma tabela de compartilhamento de tarefas e a revisão de privacidade do dono da reunião. Ambas são aditivas depois.

**Q4 — Revogação do compartilhamento e exclusão da reunião (FR-026, FR-027).** O que acontece com o conteúdo copiado
para a tarefa do destinatário?
- A) **A tarefa fica como está** (texto e instantâneo); some o vínculo (link, item, áudio).
- B) Fica só título, prazo e status; descrição copiada e citação são ocultadas.
- C) A tarefa é arquivada ou excluída junto com o acesso.
- **Recomendação: A.** O texto da tarefa é cópia editável feita enquanto havia acesso legítimo; revogar protege o
  acesso futuro, não apaga o que a pessoa já sabe, e excluir o trabalho dela surpreenderia. Quem quiser rigor maior
  escolhe B; ele só muda o serializador.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Aprovar uma pendência com responsável vazio ou o próprio usuário faz a tarefa aparecer na tela
  **Minhas pendências** em até 2 s (p95), sem recarregar a página.
- **SC-002**: Após 10 reprocessamentos seguidos de uma reunião com 5 itens aprovados, o número de tarefas continua 5
  (teste automatizado de banco).
- **SC-003**: O usuário encontra "tarefas atrasadas de um projeto" em até 3 interações, e o filtro sobrevive a
  recarregar a página.
- **SC-004**: 100% das tarefas nascidas de item exibem reunião, item e citação de origem (ou o instantâneo, se o
  acesso foi perdido).
- **SC-005**: Zero vazamentos nos testes de acesso cruzado: tarefa alheia dá 404 por id, não aparece em listas,
  contadores nem no cartão de Hoje, para outro USER, ADMIN, SUPER_ADMIN, VIEWER e usuário com acesso à reunião.
- **SC-006**: Criar uma tarefa manual leva menos de 30 s e uma alteração de status, 1 clique.
- **SC-007**: Com 500 tarefas, a lista filtrada responde em menos de 1 s (consulta com índices).
- **SC-008**: Nenhum byte novo sai da máquina e nenhuma chamada de LLM acontece nesta feature (verificável pelo egress
  guard e pelos testes).

## Assumptions

- A feature usa as estruturas existentes: `meeting_items`, `item_evidence`, `meeting_shares`, `projects`, RBAC e
  `visibleMeetingsSql`; nenhuma ferramenta de migração nova.
- O dono da máquina ainda é o único usuário real (`sergio`); a modelagem multiusuário vale para o sócio e para
  testes, e **não há tela de compartilhamento** hoje. O comportamento de compartilhamento é verificado com linhas em
  `meeting_shares` nos testes; a tela de compartilhar é outra entrega.
- Os 5 status e as 4 prioridades são proposta desta spec (uso comum de quadros Kanban); mudam só nas constantes de
  `packages/contracts`.
- Prazo é data civil (sem hora) no fuso do usuário.
- Tela única "Minhas pendências" (a F4 do plano previa "Minhas pendências" e "Minhas tarefas": esta spec as unifica
  porque pendência aprovada e tarefa são o mesmo trabalho em estágios diferentes).
- O VIEWER é papel só de leitura e não recebe `tasks.*`.
- Textos de interface e documentação em português do Brasil.

## Fora do escopo (registrado, não esquecido)

- **`documents` e `generation_jobs`** (F4): anotações, decisões, análise e hub "Gerar com IA" — spec própria.
- **Painel completo** da F4 (KPIs de decisões, ADRs): aqui só o cartão de P3.
- **Delegação e compartilhamento de tarefas** (Q3 B/C), comentários, anexos, subtarefas, dependências, etiquetas.
- **Lembretes e notificações** de prazo (alertas do host-agent, e-mail) e eventos em tempo real por WebSocket.
- **Recorrência** de tarefas e **exportação** (CSV, ata com tarefas).
- **Tarefas retroativas** das pendências aprovadas antes desta entrega (ficam como item; o usuário usa **Virar
  tarefa**).
- **Integração com Azure DevOps**: só o campo `externalRef` e o desenho em `contracts/azure-devops-hook.md`. Qualquer
  envio exigiria aval formal da TI (Constituição II) e, se levasse conteúdo para fora, uma emenda ao Princípio I.
- **Tela de compartilhamento de reuniões** e a revogação imediata das assinaturas do WebSocket (pendência já listada
  em `docs/analise/plataforma-multiusuario.md` §13).
