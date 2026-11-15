# Feature Specification: Compartilhamento de reunião

**Feature Branch**: `005-compartilhamento` (diretório fixo `specs/005-compartilhamento/`)

**Created**: 2026-11-14

**Status**: Draft

**Input**: "Tela de compartilhamento de reunião: o dono compartilha com outro usuário da plataforma (leitura ou edição), lista quem tem acesso, altera e revoga; 'Compartilhadas comigo' na lista de reuniões; indicação visual de reunião compartilhada e do nível. Manter: 'edit' mexe só no conteúdo; gravar, parar, reprocessar, reagendar, link, skip e auto-off-day só o dono; admin não lê conteúdo alheio; auditoria de grant/revoke; WebSocket filtra por público e share/revoke refletem ao vivo."

## Contexto (o que já existe)

A tabela `meeting_shares` (`meeting_id`, `user_id`, `access` read|edit, `granted_by`, `created_at`) e toda a
aplicação do acesso já estão no backend (F2 da plataforma multiusuário): `meetingAccess`,
`meetingParamGuard`/`childParamGuard`, `visibleMeetingsSql`, `meetingAudience` e o `OWNER_ONLY_ROUTES`.
**Faltam** as rotas de gestão, a busca de usuário, a tela, os eventos ao vivo de grant/revoke e a auditoria.
Detalhes e evidências em `research.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compartilhar uma reunião com outro usuário (Priority: P1)

Na página da reunião, o dono abre **Compartilhar**, digita o nome ou usuário de alguém da plataforma, escolhe
**Leitura** ou **Edição** e confirma. A pessoa passa a ver a reunião.

**Why this priority**: sem isso a tabela `meeting_shares` só serve por SQL manual; é o valor central.

**Independent Test**: com dois usuários USER (Ana, Bia), a Ana compartilha uma reunião com a Bia em leitura; a Bia
abre a reunião (200) e não consegue editar item (403).

**Acceptance Scenarios**:

1. **Given** a Ana é dona da reunião, **When** busca "bia" e escolhe a Bia com **Leitura**, **Then** a Bia aparece
   em "Quem tem acesso" com o nível e a data, e a Bia consegue abrir a reunião.
2. **Given** a Ana escolhe **Edição**, **When** a Bia edita um item ou renomeia um falante, **Then** funciona;
   **When** a Bia tenta gravar, parar, reprocessar, reagendar, trocar o link, "não gravar", "dia sem agenda",
   cancelar, gerar ADRs, ligar itens ou excluir, **Then** recebe 403.
3. **Given** a Ana tenta compartilhar com ela mesma, com usuário desativado ou inexistente, **When** confirma,
   **Then** a API recusa (422) com mensagem clara e nada é gravado.
4. **Given** a Bia é VIEWER (sem `meetings.manage`), **When** a Ana escolhe **Edição** para ela, **Then** a API
   recusa (422); **Leitura** é aceita.
5. **Given** quem não é dono (destinatário com edição, admin, outro usuário), **When** chama qualquer rota de
   compartilhamento daquela reunião, **Then** recebe 404 (sem acesso) ou 403 (acesso sem ser dono); nunca a lista.

---

### User Story 2 - Ver, alterar e revogar quem tem acesso (Priority: P1)

O dono vê a lista de pessoas com acesso (nome, usuário, nível, desde quando, se já abriu), troca Leitura e Edição
e remove o acesso. A mudança vale na hora, inclusive para quem está com a reunião aberta.

**Why this priority**: compartilhar sem poder revogar não é aceitável para dados de reunião.

**Independent Test**: a Bia está com a reunião aberta e o WebSocket inscrito; a Ana revoga; em até 2 s a Bia deixa
de receber eventos e a próxima requisição dela devolve 404; a reunião some da lista dela.

**Acceptance Scenarios**:

1. **Given** a Bia com Leitura, **When** a Ana muda para Edição, **Then** a Bia passa a editar conteúdo sem
   recarregar a página (botões atualizam por evento).
2. **Given** a Bia com Edição, **When** a Ana muda para Leitura, **Then** os botões de edição somem na hora e uma
   escrita em andamento é recusada com 403.
3. **Given** a Bia assistindo a transcrição ao vivo, **When** a Ana revoga, **Then** a Bia para de receber
   segmentos e itens em até 2 s, vê o aviso "Seu acesso a esta reunião foi removido" e sai da página.
4. **Given** um usuário desativado com acesso, **When** o dono abre a lista, **Then** ele aparece marcado
   "Desativado" e pode ser revogado.
5. **Given** a revogação, **Then** existe um registro de auditoria `meeting_share_revoked` com quem revogou, de
   quem e qual reunião (só ids, sem título nem conteúdo).

---

### User Story 3 - "Compartilhadas comigo" e indicação visual (Priority: P1)

O destinatário vê, em **Reuniões**, o filtro **Compartilhadas comigo** (ao lado de Todas e Minhas), e as reuniões
compartilhadas mostram um selo com o nível ("Compartilhada · leitura" ou "· edição") e quem compartilhou. Na tela
**Hoje** e no detalhe o selo também aparece. O que é novo vem com "Nova" até a pessoa abrir.

**Why this priority**: sem encontrar a reunião, o compartilhamento não serve ao destinatário.

**Independent Test**: após o grant, a Bia abre Reuniões, filtra "Compartilhadas comigo" e vê a reunião com o selo;
abre e a marca "Nova" some; "Minhas" não a lista.

**Acceptance Scenarios**:

1. **Given** reuniões próprias e compartilhadas, **When** o usuário escolhe "Compartilhadas comigo", **Then** só
   aparecem as de outros donos com acesso a ele; **When** escolhe "Minhas", **Then** só as próprias.
2. **Given** o dono, **When** vê a lista, **Then** reuniões que ele compartilhou mostram "Compartilhada com N".
3. **Given** a Ana compartilha enquanto a Bia está logada, **When** o evento chega, **Then** a reunião entra na
   lista da Bia sem recarregar e um aviso (toast) "Ana compartilhou «Título» com você (leitura)" aparece.
4. **Given** a Bia não quer mais ver, **When** clica em **Sair desta reunião** e confirma, **Then** o próprio acesso
   é removido (auditoria `meeting_share_left`) e a reunião some.
5. **Given** o selo, **Then** o nível não depende só de cor (texto e ícone) e funciona com teclado e leitor de tela.

---

### User Story 4 - Série recorrente: ocorrência ou série (Priority: P2)

Quando a reunião pertence a uma série (recorrência manual por `series_id` ou convite `.ics` por `ical_uid`), o
diálogo pergunta o alcance: **Só esta ocorrência** (padrão) ou **Esta e as próximas já na agenda**. Revogar e
alterar o nível têm o mesmo seletor. Ocorrências passadas nunca entram no lote.

**Why this priority**: o dono de uma daily não quer repetir o ato 20 vezes, mas não pode expor histórico por engano.

**Independent Test**: série com 5 ocorrências (2 passadas, 3 futuras); compartilhar a primeira futura com
"esta e as próximas" cria 3 linhas; revogar "só esta" remove 1.

**Acceptance Scenarios**:

1. **Given** a série e a opção "esta e as próximas", **Then** o diálogo mostra "Vale para N ocorrências" antes de
   confirmar, e a resposta informa `affected`.
2. **Given** ocorrências passadas, **Then** elas não são alteradas pelo lote (só pelo ato direto em cada uma).
3. **Given** uma ocorrência criada depois pela extensão da série, **Then** ela **não** herda os acessos nesta
   versão (ver [NEEDS CLARIFICATION #1]); o diálogo avisa.

---

### User Story 5 - Isolamento e papéis (Priority: P1, teste de regressão)

O compartilhamento não pode abrir portas: admin não lê conteúdo alheio, ações do dono continuam do dono, usuário
desativado não entra.

**Independent Test**: suíte `compartilhamento.test.ts` (banco real) cobrindo a matriz papel x ação x nível e a
tentativa de contornar o guard com maiúsculas, barras duplas e codificação.

**Acceptance Scenarios**:

1. **Given** ADMIN ou SUPER_ADMIN que não é dono nem destinatário, **When** chama `GET /meetings/:id/shares`,
   **Then** 404; **When** tenta `POST /meetings/:id/shares` concedendo a si, **Then** 404 (não é dono).
2. **Given** admin dono da própria reunião, **When** compartilha, **Then** funciona como qualquer dono; **Then** não
   há rota de admin que liste compartilhamentos alheios, com ou sem título.
3. **Given** o destinatário com Edição, **When** tenta re-compartilhar, alterar ou revogar o acesso de outro,
   **Then** 403.
4. **Given** um usuário desativado, **Then** ele não aparece na busca, não pode receber novo acesso e, se tinha
   sessão, já a perdeu; ao reativar, os acessos antigos voltam a valer.
5. **Given** requisições `/MEETINGS/<id>/shares` e variações, **Then** o guard decide pelo padrão da rota (404/403),
   nunca pela URL digitada.

---

### Edge Cases

- Dono revoga durante gravação ao vivo: a gravação e o pipeline não são afetados; só a audiência muda.
- Compartilhar a mesma pessoa duas vezes: `POST` devolve 409; a UI oferece alterar o nível.
- Duas abas do dono mudando o mesmo acesso: a última escrita vence; a resposta traz o estado final.
- Reunião excluída pelo dono: os acessos somem em cascata (FK); o destinatário vê a reunião desaparecer (evento
  `meeting_access` com `access: null`) e a rota devolve 404.
- Reunião em andamento (`recording`, `in_call`): compartilhar é permitido; o destinatário assina o ao vivo (lê, e
  com edição corrige itens), mas não controla a gravação.
- Dono desativado depois de compartilhar: ver [NEEDS CLARIFICATION #5].
- Busca com menos de 3 caracteres ou com curingas (`%`, `_`): recusada ou escapada; sem enumeração por varredura.
- Reunião com `skipRecording`, `cancelled`, `missed` ou `error`: compartilhar continua permitido.
- Destinatário com a reunião aberta quando o nível cai de Edição para Leitura com formulário preenchido: o envio
  falha com 403 e a UI mostra a mensagem sem perder o texto digitado.
- Projeto: compartilhar a reunião não compartilha o projeto.
- Link da reunião (`url`) e participantes continuam visíveis para quem tem acesso (comportamento atual de
  `MeetingSummary`); o dono é avisado no diálogo ("o destinatário verá link, participantes, transcrição e áudio").

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O backend MUST expor gestão de compartilhamento **só ao dono** da reunião com `meetings.manage`
  (listar, conceder, alterar, revogar). Qualquer outro papel ou nível MUST receber 404 (sem acesso) ou 403 (com
  acesso sem ser dono), inclusive nos `GET`.
- **FR-002**: Os níveis MUST ser `read` e `edit`, como no banco. `edit` MUST continuar restrito a conteúdo (itens,
  falantes, ADRs); as rotas de `OWNER_ONLY_ROUTES` MUST continuar só do dono, e as novas rotas de compartilhamento
  MUST entrar no mesmo mecanismo (incluindo `GET`).
- **FR-003**: O sistema MUST recusar compartilhar com o próprio dono, com usuário inexistente ou desativado (mesma
  mensagem, sem distinguir) e conceder `edit` a quem não tem `meetings.manage` (ex.: VIEWER).
- **FR-004**: O destinatário MUST NOT re-compartilhar nem alterar acessos, mesmo com `edit`.
- **FR-005**: A busca de usuário MUST ser restrita a quem tem `meetings.manage`, exigir ao menos 3 caracteres,
  casar por prefixo de usuário ou de nome, devolver no máximo 8 ativos (sem o próprio) e só `id`, `username`,
  `name` e `canEdit`; MUST ter limite de taxa por usuário; MUST NOT devolver e-mail, papéis, estado de login nem
  a lista completa (ver [NEEDS CLARIFICATION #2]).
- **FR-006**: A lista de acessos (dono) MUST mostrar nome, usuário, nível, `grantedAt`, se já abriu (`seen`) e se o
  usuário está ativo.
- **FR-007**: Conceder, alterar e revogar MUST gravar auditoria (`meeting_share_granted`, `_changed`, `_revoked`,
  `_left`) só com ids, nível e alcance, nunca título ou conteúdo.
- **FR-008**: Grant, mudança de nível e revogação MUST refletir ao vivo: o destinatário recebe `meeting_access`
  (e a reunião entra ou sai da lista), o hub MUST invalidar o cache de audiência e remover a assinatura da reunião
  daquele usuário na hora (até 2 s), sem esperar a revalidação de 30 s.
- **FR-009**: A lista de reuniões MUST aceitar `scope=all|mine|shared|shared_by_me` e devolver, por item, o
  `access` de quem pede, o nome do dono (quando não é o próprio) e, para o dono, `shareCount`. Esses campos são
  por espectador e MUST NOT ir nos eventos difundidos (`meeting`), que continuam iguais para todos.
- **FR-010**: A UI MUST mostrar o selo de reunião compartilhada e o nível na lista, em Hoje e no detalhe; o dono vê
  "Compartilhada com N"; o destinatário vê "Compartilhada por <nome> · leitura|edição".
- **FR-011**: O destinatário MUST poder sair da reunião (remove só a própria linha) e marcá-la como vista.
- **FR-012**: Para séries, o alcance MUST ser `occurrence` (padrão) ou `following` (esta e as próximas existentes,
  da mesma série e do mesmo dono, com início igual ou posterior ao desta); passadas ficam de fora; a resposta MUST
  trazer `affected`.
- **FR-013**: Admin (qualquer papel) MUST NOT ler conteúdo alheio por este recurso: sem `meetings.read_all`, sem
  rota administrativa de shares e sem títulos de reuniões alheias em nenhuma resposta nova.
- **FR-014**: Acessos de usuário desativado MUST ser preservados (voltam na reativação), exibidos como
  "Desativado" ao dono e ignorados nas notificações; a desativação já encerra sessões e assinaturas.
- **FR-015**: O consumo de IA (`/llm/usage`) MUST considerar só reuniões do próprio usuário (custo é do dono), não
  as compartilhadas com ele.
- **FR-016**: Contratos (zod) em `packages/contracts`; `MeetingDetail` ganha o nome do dono; eventos novos no
  `LiveServerMessage`.
- **FR-017**: Mudança de comportamento MUST atualizar os três READMEs, `CHANGELOG.md`,
  `docs/ARCHITECTURE.md` e `docs/analise/plataforma-multiusuario.md` §13 (item "tela de compartilhamento").
- **FR-018**: Operações de lote (`following`) MUST ser atômicas (uma transação) e idempotentes.
- **FR-019**: A notificação ao destinatário MUST ser dentro do app (toast ao vivo e selo "Nova" persistente até
  abrir); nenhuma mensagem sai da máquina (Princípio I). Ver [NEEDS CLARIFICATION #3].

### Key Entities

- **Compartilhamento (`meeting_shares`)**: liga reunião e usuário com `access`; ganha `updated_at` e `seen_at`.
- **Entrada de acesso (`ShareEntry`)**: visão do dono sobre um destinatário (nome, usuário, nível, datas, ativo).
- **Item de lista por espectador (`MeetingListItem`)**: `MeetingSummary` mais `access`, `ownerName`, `shareCount`,
  `shareUnseen`.
- **Série**: ocorrências com o mesmo `series_id` (manual) ou o mesmo `(created_by, ical_uid)` (`.ics`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Do clique em Compartilhar até o destinatário abrir a reunião, em menos de 30 s para quem sabe o
  nome da pessoa (busca, nível e confirmar, no máximo 4 interações).
- **SC-002**: Após revogar, 100% das requisições seguintes do destinatário a `/meetings/:id/*` devolvem 404 e nenhum
  evento da reunião chega ao WebSocket dele depois de 2 s.
- **SC-003**: A matriz papel x nível x rota (pelo menos 40 combinações) tem teste de banco e nenhum caso permite
  ação de dono a destinatário nem leitura de conteúdo a admin sem acesso.
- **SC-004**: A busca nunca devolve mais de 8 usuários, nunca devolve desativados nem campos fora do contrato, e
  varrer o diretório por prefixos de 3 letras esbarra no limite de taxa.
- **SC-005**: Typecheck, `npm test`, `npm run test:db` e o E2E (desktop e celular) passam; checklist do Sonar limpo
  nos arquivos alterados.

## Assumptions

- Plataforma com poucos usuários na mesma instância (hoje o `sergio` e, em breve, o sócio); sem e-mail nem
  integração externa de convite.
- O destinatário já tem conta; convidar quem não tem conta está fora do escopo.
- Reaproveita `meetings.manage` para "poder gerir compartilhamento" (sem permissão nova), porque o modo `owner`
  do guard já a exige.
- Compartilhar por projeto, por grupo, link público e transferência de propriedade ficam fora do escopo.
- `MeetingSummary.url` e participantes continuam visíveis a quem tem acesso (não muda nesta feature).
- Host-agent, alertas e gravação continuam ligados ao dono (`created_by`); destinatário nunca dispara gravação.

## Clarifications Needed

1. **[NEEDS CLARIFICATION #1] Série recorrente.**
   - A) Só a ocorrência.
   - B) Ocorrência **ou** "esta e as próximas já na agenda" (lote único, sem herança para ocorrências criadas
     depois). **Recomendada**: cobre o caso da daily sem criar regra viva escondida.
   - C) Série "viva": tabela de compartilhamento por série que a extensão e a importação copiam para as novas
     ocorrências (maior alcance, mais risco de expor sem o dono perceber).
2. **[NEEDS CLARIFICATION #2] Quem encontra quem (diretório).**
   - A) Quem tem `meetings.manage` busca por prefixo (pelo menos 3 caracteres, máx. 8, só ativos, campos mínimos,
     limite de taxa). **Recomendada**.
   - B) Só usuário exato (sem enumeração, mas exige saber o login).
   - C) Lista completa para qualquer logado (rejeitada: vaza o diretório e inclui VIEWER).
3. **[NEEDS CLARIFICATION #3] Notificação ao destinatário.**
   - A) Só no app: toast ao vivo, selo "Nova" e contador no filtro. **Recomendada** (nada sai da máquina).
   - B) A mais notificação do desktop pelo host-agent, só quando o destinatário for o `AGENT_OWNER`.
   - C) E-mail (exige SMTP e abre egress; conflita com o Princípio I sem emenda).
4. **[NEEDS CLARIFICATION #4] Quem enxerga a lista de acessos.**
   - A) Só o dono vê todos os destinatários; o destinatário vê "compartilhada por X" e o próprio nível.
     **Recomendada** (privacidade entre destinatários).
   - B) Todos com acesso veem a lista completa (transparência, mas expõe quem mais foi convidado).
5. **[NEEDS CLARIFICATION #5] Dono desativado.**
   - A) Os destinatários mantêm o acesso como está (a reunião continua legível). **Recomendada**: desativar não
     deve destruir o trabalho dos outros e é reversível.
   - B) Os acessos ficam suspensos enquanto o dono estiver desativado.
   - C) Exigir que um admin transfira a propriedade antes (fora do escopo e fere "admin não lê conteúdo").
