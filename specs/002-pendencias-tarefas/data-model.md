# Data Model — Minhas pendências e tarefas

Postgres 16. As mudanças entram em `apps/backend/src/schema.ts` como o resto: idempotentes e **apenas aditivas**
(`CREATE ... IF NOT EXISTS`). Nenhuma coluna ou tabela existente muda; nenhuma tarefa é criada retroativamente.
Aplicar no banco real só com confirmação e com o backend ocioso (sem reunião em processamento).

Marcadores `[Q1]`…`[Q4]` indicam o que depende das questões em aberto do `spec.md`; o modelo abaixo segue a
recomendação (Q3 = tarefa pessoal), e a seção "Impacto das alternativas" diz o que muda se a resposta for outra.

## Diagrama

```text
users 1─* tasks (owner_id)                       -- a tarefa é pessoal: só o dono vê
projects 1─* tasks (project_id, SET NULL)
meetings 1─* tasks (meeting_id, SET NULL)        -- reunião excluída: a tarefa sobrevive
meeting_items 1─* tasks (source_item_id, SET NULL), no máximo 1 por (item, dono)
tasks 1─* task_history
meeting_shares ··· (não referenciada por FK; só decide, na leitura, se a ligação com a reunião é mostrada)
```

## Tabelas existentes (sem alteração)

`meeting_items`, `item_evidence`, `item_history`, `meetings`, `projects`, `meeting_shares`, `users`, `roles`,
`permissions`. As permissões novas entram pelo seed idempotente de `authz/matrix.ts` (ver "Permissões").

## Tabelas novas

### tasks

| Coluna | Tipo | Regra |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| owner_id | UUID NOT NULL FK users ON DELETE CASCADE | dono da tarefa; único que a vê e altera `[Q3]` |
| title | TEXT NOT NULL | 3–200 caracteres após `trim` |
| description | TEXT NOT NULL DEFAULT `''` | até 4000 caracteres |
| status | TEXT NOT NULL DEFAULT `'a_fazer'` | CHECK `a_fazer`, `em_andamento`, `bloqueada`, `concluida`, `cancelada` |
| priority | TEXT NOT NULL DEFAULT `'media'` | CHECK `baixa`, `media`, `alta`, `urgente` |
| due_date | DATE | prazo civil, sem hora; fuso do usuário para "hoje" e "atrasada" |
| due_hint | TEXT | prazo dito no item ("sexta-feira"), ≤ 120 caracteres; mantido quando não vira data |
| assignee_kind | TEXT NOT NULL DEFAULT `'self'` | CHECK `self`, `other`, `none` |
| assignee_name | TEXT | ≤ 120; obrigatório se `other`; nulo se `self`; opcional se `none` (dito na reunião) `[Q2]` |
| project_id | UUID FK projects ON DELETE SET NULL | herdado da reunião ao criar, editável |
| meeting_id | UUID FK meetings ON DELETE SET NULL | |
| source_item_id | UUID FK meeting_items ON DELETE SET NULL | |
| source_snapshot | JSONB | instantâneo da origem (abaixo); nulo em tarefa manual sem reunião |
| origin | TEXT NOT NULL | CHECK `item_auto` (aprovação `[Q1]`), `item_manual` (Virar tarefa), `manual` |
| external_ref | JSONB | gancho de integração externa; nulo; somente leitura nesta feature |
| completed_at | TIMESTAMPTZ | preenchido ao entrar em `concluida`, limpo ao sair |
| created_at, updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Restrições e índices:

- `CHECK (assignee_kind <> 'other' OR assignee_name IS NOT NULL)` e `CHECK (assignee_kind <> 'self' OR
  assignee_name IS NULL)`: `other` exige nome; `self` não tem nome.
- `CHECK (status <> 'concluida' OR completed_at IS NOT NULL)`.
- `UNIQUE (source_item_id, owner_id) WHERE source_item_id IS NOT NULL`: **uma tarefa por item e por usuário**
  (idempotência de aprovar duas vezes, reabrir e aprovar, reprocessar).
- `(owner_id, status, due_date)`: lista padrão e filtro de abertas por prazo.
- `(owner_id, project_id)` e `(owner_id, meeting_id)`.
- `(owner_id, updated_at DESC)`.
- Busca por texto: `ILIKE` em `title`/`description` filtrado por `owner_id`; sem índice de texto (volume pequeno,
  ver R10).

`source_snapshot` (JSON validado por zod, tudo opcional):

```json
{
  "meetingTitle": "Alinhamento Farmácia Digital",
  "meetingDate": "2026-11-12T13:00:00Z",
  "itemType": "pendencia",
  "itemDescription": "Enviar o desenho da integração até 30/11",
  "itemOwner": "Sérgio",
  "itemDue": "30/11",
  "quote": "eu mando o desenho até o dia trinta",
  "quoteStart": 1234.5,
  "channel": "remote"
}
```

O instantâneo é gravado **uma vez**, na criação, a partir do que o usuário já podia ver. Não acompanha edições do
item.

### task_history

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| task_id | UUID NOT NULL FK tasks ON DELETE CASCADE | excluir a tarefa apaga o histórico |
| action | TEXT NOT NULL | `created`, `edited`, `status_changed` |
| before | JSONB | só os campos alterados, valor anterior |
| after | JSONB | só os campos alterados, valor novo |
| actor_id | UUID FK users ON DELETE SET NULL | quem fez (aprovador, no caso automático) |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Índice `(task_id, id)`. `before`/`after` seguem o padrão de `item_history`.

## Regras

### Criação a partir de item

Entrada: `itemId`, usuário, sobrescritas opcionais (`title`, `dueDate`, `priority`, `assignee`, `force`).

1. Item existe, `review_status = 'aprovado'`; senão 409 `item_not_approved`.
2. Usuário tem acesso de leitura à reunião do item (`meetingAccess`), `meetings.read` e `tasks.manage`; senão 404.
3. Já existe linha `(source_item_id, owner_id)`: devolve-a (`200`, `created: false`).
4. Existe tarefa parecida do mesmo dono na mesma reunião (Jaccard ≥ 0,55 sobre o texto normalizado, a mesma regra de
   `agent/dedup.ts`) e não vem `force`: automático não cria (`taskNotice.possibleDuplicate`); explícito responde 409
   `possible_duplicate` com a tarefa parecida.
5. Insere com `INSERT ... ON CONFLICT (source_item_id, owner_id) WHERE source_item_id IS NOT NULL DO NOTHING
   RETURNING`; se nada voltou, relê e devolve a existente (corrida entre dois cliques).

Derivações:

| Campo da tarefa | Origem |
|---|---|
| title | primeira frase da descrição do item, até 120 caracteres, cortada em palavra, com `…` se cortou |
| description | descrição integral do item (vazia se igual ao título) |
| due_date | `parseDueText(item.due, dataDaReunião)`; nulo se ambíguo |
| due_hint | `item.due` quando não virou data |
| assignee | `item.owner` vazio → `none`; é o próprio usuário → `self`; outro nome → `other` + nome (só por Virar tarefa `[Q2]`) |
| priority | `media` (a IA não define prioridade) |
| project_id | `meetings.project_id` |
| source_snapshot | ver acima; a citação vem da primeira linha de `item_evidence` |
| origin | `item_auto` na aprovação, `item_manual` em **Virar tarefa** |

### Estados da tarefa

```text
a_fazer ⇄ em_andamento ⇄ bloqueada
   └────────── qualquer ──────────► concluida   (completed_at = now())
   └────────── qualquer ──────────► cancelada
concluida / cancelada ──reabrir──► a_fazer      (completed_at = NULL)
```

Qualquer transição entre os 5 valores é aceita; cada uma grava `task_history` (`status_changed`). "Aberta" =
`a_fazer`, `em_andamento` ou `bloqueada`.

### Atrasada

`due_date < (now() AT TIME ZONE <fuso>)::date AND status IN (abertas)`. O fuso é o do usuário
(`users.timezone`) ou `APP_TIMEZONE`.

### Efeito de mudanças no item de origem

| Evento no item | Efeito na tarefa |
|---|---|
| editado | nenhum (a tarefa tem o texto do momento da criação) |
| reaberto (`proposto`) ou rejeitado | nenhum; a API devolve `sourceItemState` para a interface avisar |
| excluído (reunião excluída, `ON DELETE SET NULL`) | `source_item_id` e `meeting_id` viram nulos; o instantâneo permanece |
| aprovado de novo | nada novo (a unicidade devolve a mesma tarefa) |

O reprocessamento (`clearUnreviewedAiItems`) só apaga itens `proposto` sem ação humana. Como a tarefa só nasce de
item `aprovado`, o reprocessamento nunca apaga item com tarefa; as propostas novas parecidas caem na regra 4.

### Visibilidade (resumo)

| Quem | Vê a tarefa? |
|---|---|
| o dono | sim |
| dono da reunião, destinatário de `meeting_shares` | **não** (a menos que seja o dono da tarefa) `[Q3]` |
| ADMIN, SUPER_ADMIN | **não**; `meetings.read_all` não vale para tarefas |
| VIEWER | sem `tasks.*` |

Os dados da reunião dentro da tarefa (título atual, projeto, links, trecho ao vivo) só saem se o dono da tarefa ainda
tiver acesso (`meetingAccess`); do contrário, só o instantâneo `[Q4]`.

### Permissões (RBAC)

| Permissão | Descrição | USER | ADMIN | SUPER_ADMIN | VIEWER |
|---|---|---|---|---|---|
| `tasks.read` | Ver as próprias tarefas | sim | sim | sim | não |
| `tasks.manage` | Criar, editar e excluir as próprias tarefas | sim | sim | sim | não |

Entram em `PERMISSIONS` (`packages/contracts/src/platform.ts`) e em `OWN_CONTENT` (`authz/matrix.ts`); o seed já
sincroniza `permissions`, `role_permissions` e remove o que não está no código.

## Impacto das alternativas (se a resposta às questões mudar)

| Questão | Escolha | Mudança no modelo |
|---|---|---|
| Q1 | B (só explícito) | remove o gancho de aprovação; `origin = 'item_auto'` deixa de existir |
| Q1 | C (diálogo) | nenhuma no banco; muda a interface de revisão |
| Q2 | A (todas viram tarefa) | nenhuma no banco; só a regra de elegibilidade |
| Q3 | B (delegável) | `assignee_id UUID FK users`; consultas passam a `owner_id = $u OR assignee_id = $u`; papéis de edição por campo |
| Q3 | C (compartilhada) | tabela `task_shares` ou visibilidade por `meeting_id` via `visibleMeetingsSql` |
| Q4 | B (ocultar cópia) | nenhuma no banco; o serializador omite `description` e `quote` sem acesso |
| Q4 | C (apagar) | gatilho ao revogar `meeting_shares` e ao excluir a reunião |

## Fora do modelo (decidido)

- **`documents` e `generation_jobs`** não entram (ver `spec.md`).
- **Lembretes**, **recorrência**, **comentários**, **anexos**: sem estrutura.
- **`ai_usage_logs`** não muda: a feature não chama IA.
- `external_ref` é só um campo JSONB reservado (ver `contracts/azure-devops-hook.md`); sem tabela de integração.
