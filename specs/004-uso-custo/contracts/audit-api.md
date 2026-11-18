# Contrato — API de auditoria visível

Base: `/api`. Somente leitura (`GET`). Tipos em `packages/contracts/src/usage.ts`
(`AuditEventView`, `AuditPage`). A resposta nunca é o `detail` cru: passa pela projeção por lista
permitida (`data-model.md`, "Projeção de exibição").

## Tipos

```ts
AuditEventView = {
  id: number,
  at: string,                       // ISO
  kind: string,                     // tipo técnico, estável
  title: string,                    // rótulo pt-BR já montado no servidor
  actor: { id: string | null, username: string | null } | null,
  target: { id: string | null, username: string | null } | null,
  fields: Record<string, string | number | boolean | string[]>  // só chaves da lista permitida do kind
}
AuditPage = { items: AuditEventView[], nextCursor: string | null }
```

## `GET /api/audit/me`

Eventos de segurança do próprio usuário. Autenticado; sem permissão extra.

- Linhas com `user_id = eu` (ator) **ou** `detail->>'target' = eu` (alvo de ação de admin).
- Tipos incluídos: autenticação, conta Teams, ações de admin sobre a conta dele, envios externos
  (`external_llm`, `external_asr`) e `generation_requested` em nome dele.
- Fora: eventos de sistema sem relação com ele (`egress_blocked`, `agent_*`, `retention_pruned`).
- Query: `from`, `to` (ISO, opcionais; padrão últimos 90 dias), `kind` (opcional), `cursor`,
  `limit` 1–100 (padrão 30).
- Campos: `ip` só em `auth_login_failed` (Q5-A). `meetingId`, título e `detail` cru nunca.

## `GET /api/admin/audit`

Permissão: `audit.read` (403 caso contrário). Eventos de todo o sistema, projetados.

- Query: `from`, `to`, `kind` (enum dos tipos conhecidos), `userId` (ator ou alvo), `cursor`,
  `limit`.
- Visível: tipo, data, ator e alvo (nome de usuário), campos permitidos por tipo
  (`provider`, `model`, `purpose`, `success`, `table`, `deleted`, `host`, `reason`, papéis).
- Nunca: `meetingId`, título, participantes, prompt, resposta, `detail` fora da lista.
- Tipo desconhecido (adicionado depois e sem regra): `title` = tipo, `fields = {}`.

## `GET /api/audit/kinds`

Lista de tipos conhecidos e seus rótulos (para os filtros da interface). Autenticado; devolve
só os tipos que o chamador pode ver (usuário: o subconjunto de `/audit/me`; admin: todos).

## Eventos novos (escritos pelo backend)

| kind | Onde | `user_id` | Notas |
|---|---|---|---|
| `auth_login` | `POST /auth/login` (sucesso) | usuário | |
| `auth_login_failed` | `POST /auth/login` (senha errada, usuário desconhecido ou desativado) | usuário se existir | `ip`; não grava o nome digitado |
| `auth_logout` | `POST /auth/logout` | usuário | |
| `auth_password_changed` | `POST /auth/password` | usuário | `sessionsRevoked` |
| `retention_pruned` | poda diária | nulo | `table`, `deleted`, `olderThanDays` |

O `loginLimiter` existente continua; bloqueio por limite de taxa também gera `auth_login_failed`
(com `rateLimited: true`) para o usuário ver tentativas contra a conta dele.

## Códigos de resposta

| Código | Quando |
|---|---|
| 200 | sucesso |
| 400 | período, `kind`, `cursor` ou `limit` inválidos |
| 401 | sem sessão |
| 403 | `/admin/audit` sem `audit.read` |
