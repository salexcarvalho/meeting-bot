# Contrato: API REST de compartilhamento

Base `/api`, cookie de sessão, `requireSameOrigin` nas mutações, erros `{ "error": "mensagem em pt-BR" }`.
Tipos em `data-model.md` (zod em `packages/contracts`). Todas as rotas exigem `meetings.read` além do que consta.

## Regras de acesso (resumo)

| Quem chama | `/meetings/:id/shares*` | `/users/lookup` | `/shared-with-me/*` |
|---|---|---|---|
| Dono com `meetings.manage` | permitido | permitido | n/a (404) |
| Destinatário `edit` ou `read` | 403 (inclusive GET) | só se tiver `meetings.manage` | só a própria linha |
| ADMIN/SUPER_ADMIN sem relação | 404 | permitido (se `meetings.manage`) | 404 |
| VIEWER | 403 ou 404 | 403 | só a própria linha |
| Sem acesso à reunião | 404 | n/a | 404 |

`/meetings/:id/shares` e `/meetings/:id/shares/:userId` entram no guard como "dono para qualquer método"
(inclusive `GET`). O padrão vem de `req.route.path`, nunca da URL digitada.

## Busca de usuário

`GET /users/lookup?q=<texto>`

- Permissão: `meetings.manage`. Limite: 30 req/min por usuário (429 com `Retry-After`).
- `q` com 3 a 64 caracteres após `trim`; senão `400 { error: "Digite ao menos 3 caracteres." }`.
- Casa por prefixo de `username` ou de qualquer palavra de `real_name`/`display_name`, sem acento e sem diferenciar
  maiúsculas; `%`, `_` e `\` são literais. Só `active = true`, exclui o próprio usuário, máximo 8, ordenado por nome.

```json
200 { "users": [ { "id": "uuid", "username": "bia", "name": "Bia Souza", "canEdit": true } ] }
```

`canEdit` = o usuário tem `meetings.manage` (pode receber `edit`). Nenhum outro campo.

## Listar acessos (só dono)

`GET /meetings/:id/shares`

```json
200 {
  "shares": [ ShareEntry ],
  "series": { "following": 3 } | null   // ocorrências futuras da série com início >= desta; null se não é série
}
```

`following` conta as ocorrências que o lote atingiria (inclui esta). 403 para destinatário, 404 sem acesso.

## Conceder

`POST /meetings/:id/shares` (só dono)

```json
{ "userId": "uuid", "access": "read" | "edit", "scope": "occurrence" | "following" }   // scope padrão: occurrence
```

- `201 { "share": ShareEntry, "affected": 1 }` (`affected` = linhas criadas ou atualizadas pelo lote).
- `400` corpo inválido; `409` já compartilhado nesta reunião (no lote, as ocorrências já compartilhadas com o mesmo
  nível são ignoradas e contadas fora de `affected`); `422` alvo inexistente, desativado ou o próprio dono
  ("Não foi possível compartilhar com este usuário."); `422` `edit` para quem não tem `meetings.manage`
  ("Este usuário só pode receber leitura."); `422` `following` em reunião sem série.
- Efeitos: auditoria `meeting_share_granted`; `meeting_access` ao alvo; `invalidateAudience`.

## Alterar nível

`PUT /meetings/:id/shares/:userId` (só dono)

```json
{ "access": "read" | "edit", "scope": "occurrence" | "following" }
```

- `200 { "share": ShareEntry, "affected": n }`; `404` se o usuário não tem acesso a esta reunião; mesmos `422`.
- Subir para `edit` zera `seen_at`. Efeitos: `meeting_share_changed`, `meeting_access` com o novo nível.

## Revogar

`DELETE /meetings/:id/shares/:userId?scope=occurrence|following` (só dono)

- `204`. `404` se o usuário não tem acesso a esta reunião.
- Efeitos (nesta ordem): remoção no banco, `invalidateAudience`, remoção da assinatura WS do usuário,
  `meeting_access` com `access: null`, auditoria `meeting_share_revoked`.

## Destinatário

| Rota | Efeito | Respostas |
|---|---|---|
| `POST /shared-with-me/:meetingId/seen` | `seen_at = now()` na própria linha | `204`; `404` se não há acesso compartilhado |
| `DELETE /shared-with-me/:meetingId` | remove a própria linha ("Sair desta reunião"); auditoria `meeting_share_left`; `meeting_access` null só para si | `204`; `404` se o usuário é o dono ou não tem linha |

Sem `:id` no caminho de propósito (não passam pelo `router.param("id")`); o handler filtra por `user_id` da sessão.

## Mudanças em rotas existentes

| Rota | Mudança |
|---|---|
| `GET /meetings` | Novo `scope=all\|mine\|shared\|shared_by_me` (padrão `all`; valor inválido = 400). Resposta `{ meetings: MeetingListItem[] }`. |
| `GET /agenda?date=` | Itens passam a `MeetingListItem` (selo em Hoje). |
| `GET /meetings/:id` | `MeetingDetail` ganha `ownerName`. `access` já existe. |
| `GET /llm/usage` | Considera só reuniões em que `created_by` é o usuário (FR-015). |
| `GET /projects` | Sem mudança de contrato (a contagem continua com `visibleMeetingsSql`). |

## Códigos e mensagens

| Situação | Código | Mensagem |
|---|---|---|
| Não é dono (tem acesso) | 403 | "Você não tem permissão para esta ação." (existente) |
| Sem acesso à reunião | 404 | "Reunião não encontrada." (existente) |
| Alvo inválido (inexistente, desativado, próprio dono) | 422 | "Não foi possível compartilhar com este usuário." |
| Edição para quem só lê | 422 | "Este usuário só pode receber leitura." |
| Já compartilhado | 409 | "Esta reunião já está compartilhada com este usuário." |
| Série sem recorrência | 422 | "Esta reunião não pertence a uma série." |
| Busca curta | 400 | "Digite ao menos 3 caracteres." |
| Taxa excedida | 429 | "Muitas buscas. Tente de novo em instantes." |
