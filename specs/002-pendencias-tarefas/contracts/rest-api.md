# Contrato — API REST de tarefas

Base: `http://127.0.0.1:3000/api` (a mesma de `specs/001-agente-reunioes-mvp/contracts/rest-api.md`). Respostas em
JSON; erros no formato `{ "error": "mensagem em pt-BR" }`, com `code` quando o cliente precisa decidir.

**Autenticação:** cookie `mb_session`, `requireSameOrigin` nas mutações (como todas as rotas de UI). O host-agent não
usa estas rotas.

**Autorização:**

- `GET` exige `tasks.read`; `POST`/`PATCH`/`DELETE` exigem `tasks.manage`. Sem a permissão: `403`.
- **Todas** as rotas filtram por `owner_id = usuário da sessão`. Tarefa de outro dono, inexistente ou id inválido:
  `404 {"error":"Tarefa não encontrada."}`, nunca `403` (não revela existência), inclusive para ADMIN e SUPER_ADMIN.
  `meetings.read_all` não vale aqui.
- Dados da reunião dentro da tarefa só saem se o usuário ainda tiver acesso a ela (`meetingAccess`).

Tipos (zod em `packages/contracts/src/tasks.ts`):

```ts
TaskStatus   = "a_fazer" | "em_andamento" | "bloqueada" | "concluida" | "cancelada"
TaskPriority = "baixa" | "media" | "alta" | "urgente"
AssigneeKind = "self" | "other" | "none"
TaskOrigin   = "item_auto" | "item_manual" | "manual"

TaskSourceSnapshot = {
  meetingTitle?, meetingDate?: ISO, itemType?: ItemType, itemDescription?, itemOwner?, itemDue?,
  quote?, quoteStart?: number, channel?: "mic"|"remote"|"mixed"
}

Task = {
  id, title, description,
  status, priority,
  dueDate: "AAAA-MM-DD"|null, dueHint: string|null, overdue: boolean,
  assignee: { kind: AssigneeKind, name: string|null },        // kind "none" → selo "Responsável não confirmado"
  project: { id, name }|null,
  meeting: { id, title, scheduledStart|null }|null,           // null sem acesso atual ou reunião excluída
  sourceItem: { id, type, reviewStatus }|null,                // null sem acesso atual ou item excluído
  source: TaskSourceSnapshot|null,                            // instantâneo gravado na criação
  origin: TaskOrigin,
  externalRef: { system: string, id: string, url: string|null, syncedAt: ISO|null }|null,   // só leitura
  completedAt: ISO|null, createdAt: ISO, updatedAt: ISO
}

TaskCounts = {
  byStatus: Record<TaskStatus, number>,
  open: number, overdue: number, dueToday: number, unconfirmedAssignee: number
}

TaskHistoryEntry = {
  id, action: "created"|"edited"|"status_changed",
  before: Record<string, unknown>|null, after: Record<string, unknown>|null,
  actor: { id, name }|null, createdAt: ISO
}

TaskInput = {                                   // POST /tasks
  title: string (3–200), description?: string (≤4000), priority?: TaskPriority,
  dueDate?: "AAAA-MM-DD"|null, projectId?: uuid|null, meetingId?: uuid|null,
  assignee?: { kind: "self" } | { kind: "other", name: string (1–120) } | { kind: "none" },
  status?: TaskStatus
}
TaskPatch = Partial<Omit<TaskInput, "meetingId">> & { dueHint?: null }   // PATCH /tasks/:id (≥ 1 campo)
```

`dueHint` só pode ser limpo (`null`); o texto original vem do item e não é editável. `externalRef`, `origin`,
`source`, `completedAt` e `overdue` nunca aceitam escrita (campo desconhecido no corpo → `400`).

## Tarefas

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/tasks` | filtros abaixo | `{ tasks: Task[], total: number, counts: TaskCounts }` |
| POST | `/tasks` | `TaskInput` | `201 Task`; `400`; `404` se `meetingId`/`projectId` não existe ou sem acesso |
| GET | `/tasks/:id` | — | `Task`; `404` |
| PATCH | `/tasks/:id` | `TaskPatch` | `Task`; `400`; `404` |
| POST | `/tasks/:id/status` | `{ status: TaskStatus }` | `Task`; `404`; mesma regra de histórico e `completedAt` do PATCH |
| DELETE | `/tasks/:id` | — | `204`; `404` |
| GET | `/tasks/:id/history` | — | `{ history: TaskHistoryEntry[] }` (mais antigo primeiro); `404` |
| GET | `/tasks/summary` | — | `{ counts: TaskCounts, proposalsToReview: number }` (cartão da tela Hoje) |

### Filtros de `GET /tasks`

| Parâmetro | Valores | Padrão |
|---|---|---|
| `status` | lista separada por vírgula de `TaskStatus`, ou `open` (as três abertas), ou `all` | `open` |
| `projectId` | uuid, ou `none` (sem projeto) | todos |
| `due` | `overdue`, `today`, `week`, `month`, `none` (sem prazo), `range` | todos |
| `dueFrom`, `dueTo` | `AAAA-MM-DD`; valem com `due=range` | — |
| `assignee` | `me` (`self`), `none` (não confirmado), `other` | todos |
| `assigneeName` | texto (parte do nome); só com `assignee=other` | — |
| `priority` | lista de `TaskPriority` | todas |
| `meetingId` | uuid | todas |
| `q` | texto (1–100) em título e descrição, sem acento e sem maiúsculas | — |
| `sort` | `due` (prazo ↑, sem prazo no fim, depois prioridade ↓), `priority`, `updated`, `created` | `due` |
| `limit`, `offset` | 1–200 (padrão 100), ≥ 0 | 100, 0 |

- `week` = de hoje até o domingo seguinte; `month` = até o último dia do mês; todos no fuso do usuário.
- `counts` ignora os filtros (conta todas as tarefas do usuário); `total` conta o resultado filtrado, sem paginação.
- Valor inválido → `400 {"error":"Filtro inválido: <parâmetro>."}`.

### Regras de PATCH e status

- Mudar `status` grava `task_history.status_changed`; os demais campos gravam `edited` (um registro por requisição
  com `before`/`after` só dos campos alterados). Corpo sem mudança real → `200` sem histórico.
- `concluida` define `completedAt`; qualquer outro status o limpa.
- `projectId` aceita só projetos existentes; `meetingId` não muda depois de criada (para religar, criar outra).
- `assignee.kind = "other"` exige `name`; `self`/`none` descartam `name`.

## Criação a partir de itens

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/tasks/from-item` | `{ itemId: uuid, title?, dueDate?, priority?, assignee?, force?: boolean }` | `201 { task, created: true }`; `200 { task, created: false }` se já existia |
| POST | `/items/:itemId/approve` | (existente, sem corpo) | **estendida:** `Item & { task: TaskRef\|null, taskNotice?: TaskNotice }` `[Q1][Q2]` |
| GET | `/meetings/:id/tasks` | — | `{ tasks: Task[] }` (só do usuário e só dessa reunião); acesso de leitura à reunião |

```ts
TaskRef    = { id: uuid, status: TaskStatus }
TaskNotice = { kind: "possible_duplicate", taskId: uuid }      // não criou: já existe tarefa parecida
           | { kind: "assignee_other", name: string }          // não criou: responsável é outra pessoa [Q2]
```

Erros de `POST /tasks/from-item`:

| Status | `code` | Quando |
|---|---|---|
| 404 | — | item inexistente ou reunião sem acesso de leitura (também para `read` de `meeting_shares` sem `meetings.read`) |
| 409 | `item_not_approved` | item `proposto` ou `rejeitado` |
| 409 | `possible_duplicate` | tarefa parecida do mesmo usuário na mesma reunião; corpo traz `{ taskId }`; reenviar com `force: true` cria |
| 400 | — | sobrescrita inválida |

Notas:

- `POST /tasks/from-item` **não** exige escrita na reunião: exige leitura (`meetingAccess` ≠ nulo), `meetings.read` e
  `tasks.manage`. Por isso é uma rota própria e não `POST /items/:itemId/...`, cuja guarda trata `POST` como escrita.
- A extensão de `/items/:itemId/approve` só devolve `task`/`taskNotice` quando o usuário tem `tasks.manage`; para
  quem não tem, a resposta é a de hoje. A aprovação nunca falha por causa da tarefa (falha de tarefa → log e `task:
  null`; a aprovação já foi confirmada).
- Dois cliques simultâneos devolvem a mesma tarefa (índice único + `ON CONFLICT DO NOTHING`).

## Mudanças em contratos existentes

| Contrato | Mudança |
|---|---|
| `PERMISSIONS` (`packages/contracts/src/platform.ts`) | + `tasks.read`, `tasks.manage` |
| `Session.permissions` | passa a incluir as duas (o frontend usa em `can("tasks.read")`) |
| `POST /items/:itemId/approve` | resposta ganha `task` e `taskNotice` (campos novos, opcionais) |
| Eventos WebSocket (`ws-live.md`) | **nenhuma mudança**: tarefas não usam tempo real nesta feature (ver research R9) |

## Não existe (decidido)

`GET /admin/tasks`, `GET /users/:id/tasks`, qualquer rota que liste tarefas de outro usuário; atribuição a outro
usuário; compartilhamento de tarefa; rota de exportação; qualquer chamada à API externa (Azure DevOps).
