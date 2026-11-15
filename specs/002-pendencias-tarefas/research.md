# Research — Minhas pendências e tarefas

Base: `docs/analise/plataforma-multiusuario.md` (§3 #19–#20, §5, §8, §9, §11), `specs/001-agente-reunioes-mvp/` e o
código atual (`apps/backend/src/items`, `authz`, `agent/dedup.ts`, `schema.ts`). Cada item traz decisão, motivo e
alternativas. Onde a decisão depende de uma questão em aberto do `spec.md`, está marcada `[Qn]` e segue a
recomendação como base de trabalho, sem tratá-la como decidida.

## R1. `documents` e `generation_jobs` ficam fora

- **Decisão:** a F4 entrega só `tasks` e `task_history`. Não cria `documents`, `generation_jobs`, hub "Gerar com IA"
  nem painel completo.
- **Motivo:**
  - Tarefa nasce de item que a IA já extraiu e o humano já aprovou, ou de cadastro manual; **não há geração nova** e
    portanto nada para enfileirar.
  - `generation_jobs` só faz sentido junto com um segundo gerador (anotações, decisões, análise); entregar a fila
    sem consumidor é código morto.
  - `documents` (versão, aprovação, referências a segmentos) é um subsistema com a mesma complexidade de ata/ADR; fica
    melhor numa spec própria.
  - O valor imediato (acompanhar o que fazer) não depende deles.
- **Alternativas:** (a) entregar a F4 inteira numa spec: grande demais, atrasa o valor e mistura risco de IA com
  risco de acesso; (b) criar `generation_jobs` só como "tabela vazia": YAGNI.

## R2. Tarefa pessoal (um dono, nenhuma visibilidade cruzada) `[Q3]`

- **Decisão (base):** `tasks.owner_id` é o único dono; toda consulta filtra por ele; outro dono, ADMIN, SUPER_ADMIN
  e `meetings.read_all` recebem 404. "Responsável" é um rótulo (`self` / `other` + nome / `none`), não uma ligação a
  usuário.
- **Motivo:**
  - Cumpre sem exceção "admin não lê conteúdo alheio" e "tarefas têm dono próprio (`owner_id`), porque podem nascer
    de uma reunião compartilhada" (§9 do plano).
  - O compartilhamento de reunião (`meeting_shares`) existe no banco, mas **não tem tela** hoje; o dono real é um só
    (`sergio`). Delegar ou compartilhar tarefas agora seria construir regras de visibilidade sem uso real.
  - Cada pessoa organiza o próprio trabalho a partir dos itens compartilhados, sem tocar na lista do outro.
- **Alternativas:**
  - Delegável (`assignee_id`): exige consultas `owner OR assignee`, regras de edição por papel e decidir se o
    delegado ganha acesso a dados da reunião.
  - Compartilhada pela reunião: reutiliza `visibleMeetingsSql`, mas faz o texto copiado de uma reunião vazar para
    quem a reunião foi compartilhada depois e abre a pergunta "o admin lê?".
  - Ambas são aditivas sobre o modelo base (ver `data-model.md`, "Impacto das alternativas").

## R3. Idempotência: índice único mais deduplicação por similaridade

- **Decisão:**
  - `UNIQUE (source_item_id, owner_id) WHERE source_item_id IS NOT NULL` e `INSERT ... ON CONFLICT DO NOTHING
    RETURNING`, relendo a existente quando nada volta.
  - Para o caso "reprocessei e a IA propôs um item quase igual a um já aprovado", comparar o texto do novo item com as
    tarefas **do mesmo dono na mesma reunião** usando `normalizeTokens`/`jaccard` de `agent/dedup.ts` (limiar
    `DUPLICATE_THRESHOLD = 0,55`).
- **Motivo:**
  - O índice garante, no banco, a regra "uma tarefa por item e por pessoa" sob concorrência (clique duplo,
    aprovar/reabrir/aprovar).
  - O reprocessamento (`clearUnreviewedAiItems`) só apaga propostas sem ação humana; itens aprovados, editados,
    reabertos e manuais ficam. Logo o item que virou tarefa nunca some no reprocessamento, e a duplicação possível é
    outra: um item **novo** equivalente. A similaridade cobre isso, com a mesma heurística que o produto já usa para
    mesclar itens.
  - O aviso fica não bloqueante: automático não cria e mostra link; manual pede "Criar mesmo assim".
- **Alternativas:**
  - Hash exato do texto normalizado como chave única: perde variações de redação do LLM ("Enviar o desenho" × "Mandar
    o desenho"); o Jaccard já foi medido para esse fim.
  - Chave pelo id do item **e** pela mesma `description`: o id muda a cada reprocessamento.
  - Embeddings: fora do orçamento e do escopo.
- **Risco aceito:** falso positivo do Jaccard em pendências curtas; mitigado por não bloquear (botão "Criar mesmo
  assim") e por comparar só dentro da mesma reunião.

## R4. Gatilho de aprovação no handler, depois do commit `[Q1][Q2]`

- **Decisão (base):** em `POST /items/:itemId/approve`, depois que `reviewItem` confirma a transação, o handler chama
  `tasks/fromItem.createFromApproval(item, user)` quando o item é `pendencia`, o usuário tem `tasks.manage` e o
  responsável é o aprovador ou está vazio. Falha na criação é registrada e vira `task: null`; **nunca** desfaz a
  aprovação.
- **Motivo:**
  - Não toca a transação de revisão nem o módulo `items/service.ts` (que não importa `tasks`): sem dependência
    circular e sem risco para o fluxo mais importante da revisão.
  - A idempotência (R3) torna seguro tentar de novo; se a criação falhar, o usuário usa **Virar tarefa**.
  - Itens aprovados ao mesmo tempo no mesmo clique da interface são raros; a transação do item já serializa por
    `FOR UPDATE`.
- **Alternativas:**
  - Dentro da transação de `reviewItem` com `SAVEPOINT`: atômico, mas acopla `items` a `tasks` e alonga o lock do
    item.
  - Registro de ganchos (`items/hooks.ts`): mais extensível, sem segundo consumidor hoje.
  - Gatilho SQL: esconde regra de negócio no banco.

## R5. Reconhecer "o responsável sou eu" `[Q2]`

- **Decisão:** função pura `isSelfOwner(ownerText, user)` com normalização (minúsculas, sem acento, sem pontuação).
  Responsável vazio é tratado à parte (`none`). O texto é "eu" quando:
  - é "eu", "eu mesmo" ou "eu mesma";
  - é igual a `username`, `display_name`, `real_name` ou ao e-mail (ou à parte local do e-mail);
  - ou é um único token igual ao **primeiro nome** (3+ letras) de `display_name` ou `real_name`.

  Qualquer coisa fora disso é "outra pessoa".
- **Motivo:** o LLM escreve o responsável como o falante disse ("Sérgio", "eu"), e o aprovador é quase sempre quem
  falou; o falso negativo só custa um clique (**Virar tarefa**), enquanto o falso positivo colocaria tarefa alheia na
  lista, então a regra é conservadora.
- **Alternativas:** casar com a lista de participantes do convite (`meetings.attendees`): ajudaria a desambiguar dois
  "Sérgio", mas o campo está incompleto em reunião sem convite; fica como melhoria. Pedir a escolha ao aprovar:
  contraria Q1 = A.

## R6. Do prazo dito à data (`parseDueText`)

- **Decisão:** função pura `parseDueText(texto, dataDaReunião, fuso)` que devolve `{ date | null, hint | null }`.
  Aceita só o que é inequívoco: `AAAA-MM-DD`, `dd/mm/aaaa`, `dd/mm` (ano da reunião; se cair antes da data da
  reunião, o ano seguinte), `hoje`, `amanhã`, com prefixos "até", "para", "no dia". Dia da semana ("sexta"),
  "semana que vem", "fim do mês", "próximo mês" ficam como `hint`.
- **Motivo:** o LLM local (qwen3.5:4b) devolve `due` como texto livre; inferir "sexta" erraria justamente na semana
  seguinte e na própria sexta. Um prazo errado é pior que nenhum: a IA só sugere e o humano define.
- **Alternativas:** resolver dias da semana pela próxima ocorrência (sujeito a erro); delegar ao LLM (nova chamada,
  contraria FR-028); biblioteca de linguagem natural (dependência nova para um caso estreito).

## R7. Título e descrição

- **Decisão:** `deriveTitle(description)`: primeira frase (até `.`, `!`, `?` ou quebra de linha), colapsando espaços,
  cortada em 120 caracteres na última palavra inteira e terminada em `…` se cortada, mínimo 3 caracteres (senão, usa o
  texto inteiro). A descrição guarda o texto integral do item; vazia se idêntica ao título.
- **Motivo:** o item tem 5–1000 caracteres e a lista precisa de uma linha curta; o texto integral não se perde.
- **Alternativas:** pedir um título ao LLM (nova geração, contraria FR-028); usar o item inteiro como título (lista
  ilegível).

## R8. Fuso e "atrasada"

- **Decisão:** `due_date` é `DATE`. "Hoje" é `(now() AT TIME ZONE $tz)::date`, com `$tz` = `users.timezone` ou
  `APP_TIMEZONE`. Atrasada = `due_date < hoje` e status aberto. `week` e `month` também no fuso do usuário.
- **Motivo:** prazo de tarefa é data civil; guardar `timestamptz` criaria "atrasada" falsa na virada do dia.
- **Alternativas:** `timestamptz` com horário (sem demanda); calcular no cliente (divergiria dos contadores).

## R9. Sem tempo real (WebSocket) nesta feature

- **Decisão:** a tela atualiza ao abrir, após cada ação do próprio usuário e ao voltar o foco da janela. Nenhum evento
  novo em `packages/contracts/src/events.ts`.
- **Motivo:**
  - As tarefas são pessoais (R2): só o próprio usuário as altera, então não há "outra pessoa mudando" para refletir.
  - O hub filtra eventos por **reunião** (`meetingAudience`); eventos por usuário exigiriam um segundo tipo de
    audiência e revalidação.
  - O caso útil (aprovar um item numa aba e ver a tarefa em outra) se resolve com refetch no foco.
- **Alternativas:** `{type:"task"}` por usuário no hub: simples de adicionar depois, sem mudar o modelo.

## R10. Busca de texto sem extensão

- **Decisão:** `q` normaliza o termo e compara com `translate(lower(title || ' ' || description), 'áàâãäéèêëíìîïóòôõöúùûüç',
  'aaaaaeeeeiiiiooooouuuuc') LIKE '%termo%'`, sempre junto de `owner_id`.
- **Motivo:** a extensão `unaccent` exige `CREATE EXTENSION` (privilégio) e o volume é pequeno (centenas de tarefas
  por dono); o índice `(owner_id, …)` já limita o varrido. Mantém `schema.ts` sem extensões.
- **Alternativas:** `pg_trgm` + `unaccent` (índice de texto): só vale com milhares de tarefas por dono; full-text
  search: excessivo.

## R11. Dados da reunião dentro da tarefa só com acesso atual `[Q4]`

- **Decisão:** o serializador carrega os `meeting_id` das tarefas da página e consulta, numa só query, quais delas o
  usuário vê hoje (`visibleMeetingsSql`); só essas devolvem `meeting`, `sourceItem` e projeto resolvido pela reunião.
  As demais devolvem `meeting: null`, `sourceItem: null` e o `source` (instantâneo).
- **Motivo:**
  - Revogar um compartilhamento (`DELETE FROM meeting_shares`) corta o acesso sem trigger e sem varrer tarefas.
  - Evita N+1 e reaproveita o filtro que já valida listas e projetos.
  - A escolha entre "instantâneo completo" (A) e "só título/prazo" (B) cabe no serializador.
- **Nota:** `visibleMeetingsSql` devolve `TRUE` para quem tem `meetings.read_all`; ninguém tem hoje, e isso só afeta o
  link para a reunião, nunca a visibilidade da tarefa (R2).

## R12. Rota própria `POST /tasks/from-item`

- **Decisão:** a criação a partir de item usa `POST /tasks/from-item` e confere o acesso no serviço
  (`meetingAccess` ≠ nulo + `meetings.read` + `tasks.manage`), em vez de `POST /items/:itemId/task`.
- **Motivo:** `childParamGuard` trata qualquer método ≠ `GET` como escrita na reunião (`modeFor`), o que bloquearia o
  destinatário com acesso de **leitura**, justamente o caso de US4. Mexer na guarda de itens para abrir uma exceção
  aumenta o risco de uma regressão de autorização; a rota própria deixa a guarda intocada.
- **Alternativas:** parâmetro `readOnlyPatterns` em `childParamGuard`: pequeno, mas toca o código de segurança
  revisado em 2026-09-16.

## R13. Excluir é definitivo; cancelar é o estado

- **Decisão:** `DELETE /tasks/:id` apaga a tarefa e o histórico. Quem quer manter o registro usa o status
  `cancelada`.
- **Motivo:** a tarefa é pessoal; o histórico existe para o dono entender mudanças, não para auditoria de terceiros.
  Excluir libera o par `(item, dono)`: aprovar o item de novo (depois de reabrir) cria nova tarefa.
- **Alternativas:** exclusão lógica (`deleted_at`): complica a unicidade e as consultas sem requisito.

## R14. Os 5 status e as 4 prioridades

- **Decisão:** status `a_fazer`, `em_andamento`, `bloqueada`, `concluida`, `cancelada`; prioridade `baixa`, `media`,
  `alta`, `urgente`. Qualquer transição é livre.
- **Motivo:** cobre o ciclo real de uma pendência de reunião (esperar alguém = `bloqueada`; "não é mais necessário" =
  `cancelada`, que não polui "abertas"). Quatro níveis de prioridade evitam o "tudo é médio" e mapeiam para o
  `Priority` 1–4 do Azure DevOps.
- **Alternativas:** `backlog`/`em_revisao` (processo de equipe que um usuário individual não tem); máquina de estados
  rígida (atrito sem ganho).

## R15. Permissões e VIEWER

- **Decisão:** `tasks.read` e `tasks.manage` em `OWN_CONTENT` (USER, ADMIN, SUPER_ADMIN herdam); VIEWER não recebe.
- **Motivo:** VIEWER é o papel de leitura de conteúdo compartilhado; criar tarefa é escrever dado próprio, mas manter o
  papel estritamente de leitura é mais simples de explicar e de testar.
- **Alternativas:** `tasks.read` para VIEWER (sem criar): inútil, pois a tarefa só nasce por ação do dono.

## R16. "Pendências a revisar" no cartão de Hoje

- **Decisão:** `GET /tasks/summary` conta itens `pendencia` com `review_status = 'proposto'` em reuniões visíveis
  (`visibleMeetingsSql`) e com `extract_items = true`, **sem filtrar por responsável**.
- **Motivo:** o item só tem texto livre no responsável (R5 é conservador) e o objetivo é lembrar de revisar; o número
  leva à lista de reuniões. Contagem por responsável exigiria o mesmo casamento de nomes sem ganho.
- **Alternativas:** contar só as "minhas": impreciso; omitir: perde o elo entre extração e tarefa.

## R17. Frontend sem dependência nova

- **Decisão:** a tela usa os primitivos CSS existentes, `react-router` (`useSearchParams` para o estado dos filtros) e
  `lucide-react` (`ListChecks`, `AlertTriangle`, `CalendarClock`). Sem biblioteca de tabela, de datas ou de estado.
- **Motivo:** o projeto não tem testes unitários de frontend; a verificação é o E2E Playwright e o navegador real.
  Menos dependências, menos superfície de atualização.
- **Alternativas:** TanStack Query/Table: ótimas, mas custo de adoção alto para uma tela.

## R18. Sem tarefas retroativas

- **Decisão:** a migração não converte pendências aprovadas anteriores.
- **Motivo:** criar dezenas de tarefas de uma vez, sem o usuário ver, contraria "humano no controle" e polui a lista
  com trabalho antigo; **Virar tarefa** resolve caso a caso. Um assistente de importação ("Trazer pendências
  aprovadas") fica como melhoria futura.

## R19. Sem emenda à constituição

- **Decisão:** nenhuma emenda. A feature não envia dados para fora, não usa IA e mantém a regra III (só vira trabalho
  o que o humano aprovou ou criou). O gancho do Azure DevOps (`contracts/azure-devops-hook.md`) deixa explícito que a
  integração real **exigirá** aval da TI (II) e, se levar conteúdo de reunião, emenda ao Princípio I.
- **Efeito documental:** atualizar `docs/analise/plataforma-multiusuario.md` (§5, §11, §13) e `docs/ARCHITECTURE.md`.

## R20. Aplicar a migração com segurança

- **Decisão:** mudanças só aditivas em `schema.ts`, validadas pelo teste de migração sobre cópia do banco real
  (`zz-migracao-legado.test.ts`) e aplicadas no banco real só com confirmação e com o backend ocioso, como na regra do
  projeto de não reiniciar com reuniões em processamento.
- **Motivo:** o `schema.ts` roda em todo boot; um erro ali impede o backend de subir.
