# Feature Specification: Painel de Uso e Custo de IA e Auditoria Visível (F6)

**Feature Branch**: `feat/004-uso-custo` (diretório de spec fixo: `specs/004-uso-custo/`)

**Created**: 2026-11-14

**Status**: Implementação (clarificações Q1–Q5 aceitas pelo dono em 2026-11-15: opção recomendada A em todas)

**Input**: User description: "F6 do plano multiusuário: registrar cada chamada de IA (usuário, provedor, modelo, tokens de entrada e saída, custo estimado, reunião, tipo ata/ADR/itens/resumo/ASR, duração, sucesso ou erro), também os minutos de ASR (Whisper local × Deepgram) e o tempo de GPU quando viável. Painel do usuário (só os próprios dados) e painel de admin agregado (sem conteúdo de reunião alheia, sem títulos de reuniões alheias). Auditoria visível na interface (o usuário vê os eventos de segurança dele; o admin vê a auditoria do sistema, sem conteúdo). Retenção dos logs. Nada sai da máquina."

Contexto: hoje já existe uma versão enxuta (aba "Consumo de IA", `GET /llm/usage`, lida do
`audit_log`) que cobre só chamadas externas bem-sucedidas, sem ASR, sem falhas, sem a chamada
local, sem visão de admin e sem tela de auditoria. Esta feature a substitui e completa
(`docs/analise/plataforma-multiusuario.md` §5 `ai_usage_logs`, §7, §8, §11 F6).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cada chamada de IA fica registrada (Priority: P1)

Sempre que o sistema chama um modelo de linguagem para uma reunião (ata, itens, resumo, ADR ou
análise ao vivo), fica registrado quem pediu (dono da reunião), qual provedor e modelo, quantos
tokens entraram e saíram, quanto custou (quando o provedor informa), a reunião, a finalidade,
quanto tempo levou e se deu certo ou errado. Isso vale para o modelo local, o OpenRouter e a
assinatura pessoal (Claude/Codex). Falhas também são registradas, sem texto de reunião.

**Why this priority**: sem o registro não existe painel; é a base de tudo e já responde "quanto
gastei e com o quê" mesmo antes de qualquer tela nova.

**Independent Test**: gerar uma ata com cada provedor habilitado (local, OpenRouter, assinatura) e
uma com falha forçada (chave inválida); conferir uma linha por geração com provedor, modelo,
tokens, finalidade e resultado, e nenhuma linha com texto da reunião.

**Acceptance Scenarios**:

1. **Given** uma reunião do usuário A, **When** a ata é gerada pelo OpenRouter, **Then** existe um
   registro de A com provedor `openrouter`, modelo, tokens de entrada e saída, custo em USD
   informado pelo provedor, finalidade `ata`, duração e sucesso.
2. **Given** a mesma geração pela assinatura (Claude ou Codex), **When** termina, **Then** o
   registro tem tokens e duração, e o custo aparece como "sem custo por chamada" (não zero
   inventado e não estimado).
3. **Given** a geração pelo modelo local, **When** termina, **Then** o registro tem tokens (contagem
   do próprio Ollama), duração e tempo de inferência local; custo "sem custo".
4. **Given** uma chamada que falha (chave inválida, assinatura indisponível, resposta fora do
   schema), **When** o erro ocorre, **Then** é gravado um registro com `sucesso = não` e um código
   curto da causa, sem mensagem do provedor e sem trecho da reunião.
5. **Given** a análise ao vivo, **When** o agente extrai itens a cada janela, **Then** cada chamada
   local entra com finalidade `ao_vivo`, ligada à reunião e ao dono.
6. **Given** uma chamada sem reunião (teste, utilitário), **When** registrada, **Then** fica sem
   dono ("instância") e só aparece no painel de admin.
7. **Given** que a gravação do registro falha (banco indisponível), **When** a geração termina,
   **Then** a geração do usuário não falha por causa disso.

---

### User Story 2 - Minutos e tempo de transcrição (ASR) registrados (Priority: P1)

A transcrição também é consumo: minutos de áudio transcritos pelo Whisper local (ao vivo e no passe
final) e pelo Deepgram (via OpenRouter, quando o usuário escolhe o ASR externo de teste), com o
custo informado pelo provedor externo e o tempo de processamento. Para o Whisper local mostra-se o
tempo de GPU quando for mensurável.

**Why this priority**: o ASR externo é o único item que cobra por minuto e o passe local é o maior
consumidor de GPU; sem isso o painel de custo fica incompleto.

**Independent Test**: processar uma reunião com Whisper local e outra com ASR externo; conferir os
minutos de áudio, o provedor, o custo (só no externo) e o tempo em cada uma.

**Acceptance Scenarios**:

1. **Given** uma reunião transcrita pelo Deepgram, **When** o passe final termina, **Then** há um
   registro por canal com minutos de áudio, modelo, custo em USD informado e duração.
2. **Given** uma reunião transcrita localmente, **When** o passe final termina, **Then** há registro
   com minutos de áudio, provedor "Whisper local", custo "sem custo" e tempo de processamento.
3. **Given** uma reunião ao vivo de 1 hora, **When** ela termina, **Then** o consumo ao vivo
   aparece agregado (não centenas de linhas), com minutos de áudio e tempo de inferência totais.
4. **Given** o ASR externo falhando (402, 413, rede), **When** o erro ocorre, **Then** o registro
   marca erro e a causa curta, e os minutos não contam como transcritos.

---

### User Story 3 - Painel do usuário: meu uso e meu custo (Priority: P1)

O usuário abre "Consumo de IA" nas Configurações e vê, para o mês (ou outro período), só os dados
das próprias reuniões: total de chamadas, tokens, custo em USD, minutos de ASR (local × externo),
tempo de inferência local, quebra por finalidade, provedor e modelo, evolução por dia, as reuniões
dele que mais consumiram (com o título, que é dele) e a lista das últimas chamadas, com filtro de
falhas.

**Why this priority**: entrega o valor visível da feature para quem usa; o usuário decide quando
vale usar OpenRouter ou assinatura em vez do local.

**Independent Test**: com dois usuários com consumo diferente, cada um vê só os próprios totais; o
total do painel bate com a soma das linhas registradas.

**Acceptance Scenarios**:

1. **Given** consumo no mês, **When** o usuário abre o painel, **Then** vê totais e quebras do mês
   corrente, e pode trocar para outro mês ou intervalo.
2. **Given** chamadas pela assinatura e pelo local, **When** o painel mostra o custo, **Then** esses
   itens mostram tokens e tempo e "sem custo por chamada", sem somar zero como se fosse preço.
3. **Given** o usuário B, **When** abre o painel, **Then** não vê nenhum total, linha, reunião ou
   título do usuário A.
4. **Given** uma reunião compartilhada com B (leitura ou edição), **When** B abre o painel, **Then**
   o consumo dela não entra no painel de B (o custo é do dono).
5. **Given** um período sem consumo, **When** abre o painel, **Then** vê estado vazio explicativo.
6. **Given** chamadas com falha, **When** o usuário filtra por erro, **Then** vê só elas, com a
   causa curta e sem texto de reunião.

---

### User Story 4 - Painel de admin: uso e custo agregados, sem conteúdo (Priority: P2)

Um administrador com a permissão de leitura de uso vê o consumo da instância: totais, por usuário,
por provedor, por modelo, por finalidade e por dia. A tela nunca mostra título, id, transcrição ou
qualquer dado de reunião de outra pessoa. As chamadas sem dono aparecem como um grupo "instância".

**Why this priority**: o admin precisa saber quem e o que está gastando (especialmente OpenRouter),
mas a regra "admin não lê conteúdo alheio" é inviolável; vem depois do painel pessoal porque depende
do mesmo registro.

**Independent Test**: com um admin e dois usuários, o admin vê os totais por usuário; a resposta da
API e a tela não contêm nenhum título nem id de reunião; um usuário comum recebe 403.

**Acceptance Scenarios**:

1. **Given** consumo de vários usuários, **When** o admin abre "Uso de IA", **Then** vê o total da
   instância e a quebra por usuário, provedor, modelo, finalidade e dia.
2. **Given** qualquer visão do admin, **When** inspecionada (tela e resposta da API), **Then** não há
   título, id, participantes, trechos ou contagem por reunião individual de terceiros.
3. **Given** um usuário USER ou VIEWER, **When** tenta abrir a página ou a API de admin, **Then**
   recebe 403 e a página nem aparece no menu.
4. **Given** um usuário desativado ou excluído, **When** o admin consulta períodos antigos, **Then**
   o consumo dele continua nos totais (como "usuário removido" quando o cadastro não existe mais).

---

### User Story 5 - Auditoria visível na interface (Priority: P2)

O usuário vê, em Configurações > Segurança, os eventos de segurança que dizem respeito a ele:
entradas e tentativas de entrada na conta, troca de senha, conta Teams conectada ou removida,
ações de um administrador sobre a conta dele (papel, ativação, redefinição de senha) e envios
externos feitos em nome dele (qual provedor, quando). O admin vê, em Administração > Auditoria, os
eventos do sistema (ações administrativas, bloqueios de saída, falhas de autenticação do agente,
envios externos, poda de logs), sempre sem conteúdo de reunião.

**Why this priority**: transparência e rastreabilidade (Princípio IV) e a única forma de o usuário
saber se algo externo saiu em nome dele; o `audit_log` hoje só é lido por SQL.

**Independent Test**: criar eventos com dois usuários e um admin; cada um vê o permitido; nenhum
campo livre do registro vaza (só campos de uma lista de exibição por tipo de evento).

**Acceptance Scenarios**:

1. **Given** um login com senha errada seguido de um correto, **When** o usuário abre "Segurança",
   **Then** vê a tentativa falha e a entrada, com data e hora.
2. **Given** um administrador que redefiniu a senha do usuário A, **When** A abre "Segurança",
   **Then** vê "administrador redefiniu sua senha" (com o nome do admin e a data).
3. **Given** a geração de ata pelo OpenRouter, **When** o dono abre "Segurança", **Then** vê o envio
   externo (provedor, finalidade, data), sem o conteúdo e sem o título da reunião.
4. **Given** o usuário B, **When** abre "Segurança", **Then** não vê eventos de A.
5. **Given** o admin, **When** abre "Auditoria", **Then** vê eventos de todos, filtráveis por tipo,
   período e usuário, sem títulos nem ids de reunião.
6. **Given** um tipo de evento novo ainda sem regra de exibição, **When** listado, **Then** aparece
   só tipo e data (campos desconhecidos nunca são exibidos).

---

### User Story 6 - Retenção e continuidade do histórico (Priority: P3)

Os registros de uso e a auditoria têm prazo de guarda e são podados automaticamente. O histórico
de consumo já gravado no `audit_log` (chamadas externas) é incorporado ao novo registro uma única
vez, para o painel não "zerar" na virada.

**Why this priority**: higiene e privacidade a longo prazo; não bloqueia o valor dos painéis.

**Independent Test**: com prazos curtos de teste, linhas antigas somem e as recentes ficam; rodar a
incorporação duas vezes não duplica nada.

**Acceptance Scenarios**:

1. **Given** registros mais antigos que o prazo de uso, **When** a poda diária roda, **Then** só eles
   são removidos e a poda é auditada com contagens (sem conteúdo).
2. **Given** prazo configurado como 0, **When** a poda roda, **Then** nada é apagado naquela tabela.
3. **Given** chamadas externas antigas no `audit_log`, **When** a incorporação roda duas vezes,
   **Then** o painel mostra cada chamada uma vez.
4. **Given** a exclusão de uma reunião ou de um usuário, **When** acontece, **Then** o consumo
   histórico permanece nos totais (sem o vínculo com a reunião/usuário removidos).

---

### Edge Cases

- Provedor sem custo ou sem tokens na resposta: o campo fica nulo e a tela mostra "—"; nunca se
  inventa valor nem se estima preço de assinatura.
- Geração com nova tentativa por JSON inválido: as tentativas somam num único registro com o
  número de tentativas; tokens e custo são a soma.
- Chamada cancelada ou por timeout: registrada como erro com código `timeout`/`cancelado`.
- Reunião excluída depois da geração: o registro permanece; título deixa de aparecer ("reunião
  excluída").
- Reunião transferida de dono: o consumo passado continua com o dono da época da chamada.
- Fuso: período e agrupamento por dia usam `APP_TIMEZONE`.
- Muitas chamadas (reunião longa): lista paginada; agregações feitas no banco, nunca em memória.
- Custo com BYOK (chave do próprio provedor no OpenRouter): vale o `cost` informado; a tela não
  promete que seja o valor total pago ao provedor final.
- Reinício no meio de uma geração: no máximo um registro por chamada concluída; geração
  interrompida pelo reinício não deixa registro (a retomada gera o seu).
- O painel não pode afetar a geração: sem limites, sem bloqueio por orçamento (decisão de
  2026-09-17 mantida: só visualizar).

## Requirements *(mandatory)*

### Functional Requirements

**Registro**

- **FR-001**: O sistema MUST registrar uma entrada por chamada de LLM concluída (sucesso ou erro)
  com: momento, usuário dono da reunião, reunião, finalidade (`ata`, `adr`, `itens`, `resumo`,
  `ao_vivo`), provedor (`ollama`, `openrouter`, `claude`, `codex`), modelo, tokens de entrada e
  saída, custo em USD, duração, número de tentativas, resultado e código curto de erro.
- **FR-002**: O sistema MUST registrar o consumo de ASR: provedor (Whisper local ou Deepgram),
  modelo, canal quando houver, minutos de áudio, custo em USD informado, duração e resultado,
  com finalidade `asr_final` ou `asr_ao_vivo`.
- **FR-003**: O custo MUST ser o informado pelo provedor na resposta; quando não houver, fica nulo.
  Assinatura (Claude/Codex) e modelo local MUST ser tratados como "sem custo por chamada",
  exibindo tokens e tempo.
- **FR-004**: O tempo de inferência local (modelo local e Whisper) MUST ser guardado quando
  mensurável, separado da duração total da chamada; quando não mensurável, fica nulo.
- **FR-005**: O registro MUST NOT conter conteúdo de reunião (prompts, respostas, trechos,
  transcrição) nem mensagens livres do provedor: apenas metadados, números e códigos curtos.
- **FR-006**: Falha ao gravar o registro MUST NOT interromper nem alterar o resultado da geração
  ou da transcrição; a falha é logada no console.
- **FR-007**: O ao vivo MUST ser registrado de forma agregada por reunião e canal (acumulado e
  descarregado periodicamente e no fim), para não gerar uma linha por trecho de áudio.
- **FR-008**: Cada chamada MUST carregar a finalidade explicitamente (declarada pelo chamador),
  não deduzida de texto livre.

**Painel do usuário**

- **FR-009**: Cada usuário MUST ver só os registros em que ele é o dono: totais, por finalidade,
  provedor e modelo, série diária, ASR (minutos local × externo), tempo de inferência local,
  reuniões que mais consumiram (título só de reuniões dele) e chamadas recentes paginadas.
- **FR-010**: O período MUST ser selecionável (mês corrente por padrão, mês anterior e intervalo
  livre), em `APP_TIMEZONE`.
- **FR-011**: O painel MUST mostrar custo nulo como "—"/"sem custo por chamada" e nunca somar nulo
  como zero em rótulos de preço.
- **FR-012**: O consumo de uma reunião compartilhada MUST pertencer só ao dono; quem recebeu o
  compartilhamento não o vê.

**Painel de admin**

- **FR-013**: Quem tem a permissão `ai_usage.read` (ADMIN e SUPER_ADMIN por padrão) MUST ver
  agregados da instância por usuário, provedor, modelo, finalidade e dia.
- **FR-014**: As respostas e telas de admin MUST NOT incluir título, id, participantes, transcrição
  ou contagem por reunião de outro usuário. Chamadas sem dono formam o grupo "instância".
- **FR-015**: Usuários sem a permissão MUST receber 403 na API e não ver o item de menu.

**Auditoria**

- **FR-016**: O usuário MUST ver os eventos de auditoria em que ele é o ator ou o alvo: autenticação
  (entrada, falha, saída, troca de senha), conta Teams, ações de admin sobre a conta dele e envios
  externos em nome dele.
- **FR-017**: Quem tem `audit.read` MUST ver os eventos do sistema, filtráveis por tipo, período e
  usuário, sem conteúdo de reunião.
- **FR-018**: A exibição MUST ser por lista permitida de campos por tipo de evento; tipo ou campo
  desconhecido nunca é exibido (apenas tipo e data).
- **FR-019**: Entrada, falha de entrada, saída e troca de senha MUST passar a ser auditadas;
  envios externos de LLM e ASR MUST passar a gravar o usuário dono. (Decisão Q5-A: IP só nas falhas.)

**Retenção e continuidade**

- **FR-020**: O sistema MUST podar `ai_usage_logs` e `audit_log` por prazo configurável (valor 0 =
  guardar sempre), diariamente, e auditar a poda só com contagens. (Decisão Q2-A: uso 24 meses, auditoria 12 meses.)
- **FR-021**: O histórico de chamadas externas já gravado no `audit_log` MUST ser incorporado uma
  única vez ao novo registro, de forma idempotente.
- **FR-022**: Excluir reunião ou usuário MUST preservar o consumo histórico (vínculos viram nulos).

**Privacidade e escopo**

- **FR-023**: Nenhum dado desta feature MUST sair da máquina: sem chamadas novas a serviços
  externos (inclusive consulta de custo ao provedor); o custo vem só da resposta da própria
  geração.
- **FR-024**: A feature MUST NOT bloquear nem limitar geração por consumo ou orçamento.
- **FR-025**: O registro de uso MUST ficar em tabela dedicada (`ai_usage_logs`), deixando o
  `audit_log` para eventos de segurança. (Decisão Q1-A: tabela dedicada.)
- **FR-026**: O painel de admin MUST identificar o consumo por usuário (nome de usuário e totais),
  sem dado de reunião. (Decisão Q3-A: agregado por usuário.)
- **FR-027**: O custo MUST ser exibido em USD, como informado pelo provedor. (Decisão Q4-A: só USD.)

### Key Entities *(include if feature involves data)*

- **Registro de uso de IA**: uma chamada de LLM ou um trecho de ASR. Atributos: momento, dono,
  reunião (opcional), categoria (LLM/ASR), finalidade, provedor, modelo, tokens de entrada/saída,
  minutos de áudio, custo USD (opcional), duração, tempo de inferência local (opcional),
  tentativas, sucesso, código de erro, origem (ao vivo ou incorporado do histórico).
- **Evento de auditoria**: fato de segurança com tipo, momento, ator, alvo e detalhes de
  metadados; só é exibido por uma projeção permitida por tipo.
- **Política de retenção**: prazos em dias para uso e auditoria; 0 = indefinido.
- **Período de consulta**: mês ou intervalo, interpretado em `APP_TIMEZONE`.

## Open Questions (5, decididas pelo dono em 2026-11-15: opção A em todas)

**Q1 — Tabela dedicada ou continuar no `audit_log`?**
- Contexto: em 2026-09-17 o usuário decidiu "só visualizar, sem tabela nova". O plano F6
  (`plataforma-multiusuario.md` §5) prevê `ai_usage_logs`. O `audit_log` não guarda sucesso/erro,
  não guarda chamadas locais nem ASR com usuário, não tem `user_id` nas chamadas externas e obriga
  agregações por `detail->>` (cast de JSONB) que não têm índice.
- Opções: **A)** tabela `ai_usage_logs` (aditiva), `audit_log` volta a ser só segurança, histórico
  incorporado uma vez. **B)** continuar no `audit_log` com mais campos em `detail`. **C)** tabela
  dedicada e deixar de gravar `external_*` no `audit_log`.
- **Recomendação: A.** Dá falhas, local, ASR, índices e retenção separada (uso e auditoria têm
  prazos e sensibilidades diferentes) sem perder o `external_*` como rastro de saída (Princípio I).
  Isso revisa a decisão de 2026-09-17 apenas no "sem tabela nova"; "só visualizar" permanece.

**Q2 — Prazos de retenção**
- Opções: **A)** uso 24 meses e auditoria 12 meses, configuráveis, poda diária. **B)** uso e
  auditoria indefinidos (como o áudio). **C)** uso 12 e auditoria 6 meses.
- **Recomendação: A.** Uso não tem conteúdo e serve a comparativos anuais; auditoria tem IP em
  falhas de login e pede prazo menor. Se aprovada, vira linha nova em "Regras Operacionais" da
  constituição (emenda MINOR, hoje a retenção só trata do áudio).

**Q3 — O que o admin vê sobre cada usuário**
- Opções: **A)** agregado por usuário (nome de usuário e totais), sem qualquer dado de reunião.
  **B)** só totais da instância, sem identificar usuários. **C)** A + contagem de reuniões por
  usuário.
- **Recomendação: A.** Permite repartir custo do OpenRouter sem expor conteúdo; B esconde quem
  gasta; C revela volume de reuniões (metadado sensível).

**Q4 — Moeda e custo de assinatura/local**
- Opções: **A)** só USD como o OpenRouter informa; assinatura e local mostram tokens e tempo
  ("sem custo por chamada"). **B)** A + conversão para BRL com cotação fixa configurável
  (`USD_BRL_RATE`). **C)** A + custo "equivalente de API" estimado para a assinatura.
- **Recomendação: A**, deixando B como melhoria futura; C contraria "custo zero monetário" e
  inventaria preço que ninguém cobrou.

**Q5 — Eventos de autenticação na auditoria e IP**
- Contexto: login, falha, logout e troca de senha hoje não são auditados.
- Opções: **A)** auditar os quatro eventos, com IP só nas falhas (como `agent_auth_failed`).
  **B)** auditar sem IP em nenhum. **C)** IP em todos.
- **Recomendação: A.** Detecta tentativas de invasão sem acumular IP de uso normal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das gerações de LLM e passes de ASR concluídos (sucesso ou erro) geram
  exatamente um registro, verificado por teste que cobre cada provedor.
- **SC-002**: O total do painel do usuário é igual à soma dos registros do período (diferença zero
  em teste com dados conhecidos).
- **SC-003**: Em teste de isolamento com 2 usuários e 1 admin, 0 linhas, totais, títulos ou ids de
  reuniões de um usuário aparecem para outro usuário; a resposta de admin contém 0 campos de
  reunião.
- **SC-004**: O painel do usuário e o de admin respondem em menos de 1 segundo para 100 mil
  registros (agregação no banco, com índices).
- **SC-005**: O usuário encontra "quanto gastei este mês e com o quê" em no máximo 2 cliques a
  partir das Configurações, e o admin em 1 clique pelo menu.
- **SC-006**: O registro de uso adiciona menos de 5 ms por chamada de LLM e não altera o resultado
  de nenhuma geração quando a gravação falha.
- **SC-007**: Nenhum registro de uso ou evento exibido contém texto de reunião (verificado por
  teste que varre as colunas e a projeção de auditoria).
- **SC-008**: A poda remove só registros além do prazo e a incorporação do histórico é idempotente
  (duas execuções = mesmo resultado).

## Assumptions

- Usuários e permissões seguem o RBAC existente (F2); o dono de uma reunião é `meetings.created_by`.
- OpenRouter informa tokens e custo (USD) na resposta de geração e minutos/custo na resposta de
  transcrição (verificado na documentação oficial; ver `research.md`); nenhuma chamada extra é feita.
- Ollama informa contagem de tokens e durações na resposta (`prompt_eval_count`, `eval_count`,
  `*_duration`); a assinatura informa tokens pelo host-agent.
- A moeda é USD; valores pequenos exigem 4 a 6 casas decimais na exibição.
- "Tempo de GPU" é o tempo de inferência local medido (Ollama e Whisper), não a ocupação da GPU.
- Uma instância tem poucos usuários e dezenas a centenas de chamadas por dia; ainda assim os
  registros ao vivo são agregados.
- Esta fase é só de especificação; a implementação (`/speckit-implement`) começa depois da
  aprovação das Open Questions.
- Fora de escopo: orçamento/teto com bloqueio, alertas de gasto, exportação CSV, conversão de
  moeda, preço estimado de assinatura, cobrança, host-agent por usuário.
