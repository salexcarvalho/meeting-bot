# Pesquisa e decisões: Compartilhamento de reunião

**Feature**: `specs/005-compartilhamento/` | **Data**: 2026-11-14

Todas as afirmações abaixo foram conferidas no código de `origin/develop`.

## 1. O que já existe no backend

| Peça | Onde | Situação |
|---|---|---|
| Tabela `meeting_shares` (`meeting_id`, `user_id`, `access` read/edit, `granted_by`, `created_at`, PK composta, índice por `user_id`) | `apps/backend/src/schema.ts` (~l. 285) | Pronta. Só há `INSERT` direto nos testes (`test/db/multiusuario.test.ts`). **Nenhuma rota, UI ou auditoria.** |
| `meetingAccess(user, id)` devolve `owner`, `edit`, `read` ou `null` | `authz/index.ts` | Pronta; consulta o banco a cada chamada (revogação vale na próxima requisição). |
| `meetingParamGuard` (`router.param("id")`) decide pelo padrão da rota registrada (`req.route.path`) | `authz/index.ts` | Pronta; `GET` = leitura, demais = escrita, `DELETE` e `ownerOnly` = dono. |
| `OWNER_ONLY_ROUTES` (record, end, assistant, reprocess, skip, auto-off-day, cancel, extract-items, adrs/generate, `/meetings/:id`) | `routes.ts` l. 161 | Pronta. **Só vale para métodos diferentes de GET** (`ownerOnly: req.method !== "GET" && ...`). |
| `visibleMeetingsSql` (dono ou linha em `meeting_shares`, ou `read_all`) | `authz/index.ts` | Usada por lista, agenda, projetos e consumo de IA. |
| `meetingAudience` + `LiveHub.audienceOf` (cache de 5 s) + `invalidateAudience` | `authz/index.ts`, `live/hub.ts` | `invalidateAudience` **existe mas ninguém a chama**. A assinatura da reunião é revalidada só a cada 30 s (`sweep`). |
| `MeetingDetail.access` e selo "Compartilhada · somente leitura/edição" no detalhe | `contracts/domain.ts`, `frontend/src/pages/Reuniao.tsx` l. 286-394 | Pronto. |
| `audit()` com `AuditKind` fechado | `security/audit.ts` | Faltam os 4 tipos de share. |
| Host-agent, alertas, `autoJoin` e scheduler filtram por `created_by` | `calendar/routes.ts`, `bot/autoJoin.ts`, `recording/scheduler.ts` | Destinatário nunca dispara gravação nem alerta. Sem mudança. |

## 2. O que falta (lacunas confirmadas)

1. **Rotas de gestão** (listar, conceder, alterar, revogar) e as do destinatário (visto, sair).
2. **Busca de usuário para USER**: `/admin/users` exige `users.read`, que só ADMIN e SUPER_ADMIN têm. Um USER hoje
   não consegue achar ninguém.
3. **Guard de GET restrito ao dono**: `ownerOnly` ignora GET. `GET /meetings/:id/shares` passaria como "leitura" e
   um destinatário com `read` veria os outros destinatários. Precisa de um conjunto `OWNER_ONLY_READ_ROUTES`
   (ou um predicado único que cubra todos os métodos para o prefixo `/meetings/:id/shares`).
4. **Revogação imediata no WebSocket**: o hub revalida a cada 30 s; `invalidateAudience` não é chamada. Para
   cumprir "reflete ao vivo", o serviço de share deve chamar `live.revokeUser(meetingId, userId)` (remove de
   `state.meetings`) e `invalidateAudience(meetingId)`, e `live.publishToUser(userId, msg)` para avisar.
5. **Campos por espectador**: `toMeetingSummary` é difundido igual a todos (`publishBoth`). `access`, `shareCount` e
   `shareUnseen` não podem ir ali. Vão em `MeetingListItem` (resposta de `GET /meetings` e `/agenda`) e em
   `meeting_access` (evento direcionado).
6. **Consumo de IA** (`llm/usage.ts`) usa `visibleMeetingsSql`: um destinatário vê tokens e custo das reuniões do
   dono. Achado de privacidade: restringir às reuniões próprias (FR-015).
7. **Auditoria** dos quatro eventos.
8. **UI**: diálogo de compartilhar, filtros de escopo, selos, evento ao vivo, "Nova", "Sair".

## 3. Decisões

### D1. Sem permissão nova; `meetings.manage` + dono

- **Decisão**: gerir compartilhamento exige `meetings.manage` e ser o dono (modo `owner` do guard já faz as duas
  checagens).
- **Alternativas**: permissão `meetings.share` (exige seed, matriz e migração de papéis; sem ganho, pois todo
  papel que cria reunião já tem `meetings.manage`); delegar a quem tem `edit` (rejeitado: re-compartilhamento
  em cadeia quebra "o dono controla o acesso").

### D2. Rotas aninhadas em `/meetings/:id/shares` + rotas do destinatário fora do guard

- **Decisão**: `/meetings/:id/shares[/:userId]` reaproveitam o guard (404 sem acesso, 403 sem ser dono). As ações
  do destinatário usam `/shared-with-me/:meetingId/...`, porque o guard trataria `DELETE` como dono. Elas só tocam
  a **linha do próprio usuário** (`WHERE user_id = req.user.id`) e devolvem 404 se não houver, o que não revela
  nada sobre a reunião.
- **Alternativas**: um único `DELETE /meetings/:id/shares/me` com exceção no guard (rejeitado: aumenta a superfície
  do guard que acabou de ser corrigido contra bypass de maiúsculas).

### D3. Busca de usuário mínima e com limite

- **Decisão**: `GET /users/lookup?q=` (permissão `meetings.manage`): prefixo de `username` ou de qualquer palavra do
  nome, `ILIKE` com escape de `%`, `_` e `\`, mínimo de 3 caracteres, máximo de 8, só `active`, exclui o próprio,
  campos `id`, `username`, `name`, `canEdit`. Limite de 30 requisições por minuto por usuário
  (`express-rate-limit`, já usado no login). Sem avatar nesta versão (o endpoint de avatar é só do próprio usuário
  ou do admin); a UI usa iniciais.
- **Por que**: com 3 ou 4 contas na instância, prefixo é suficiente e evita pedir o login exato; o piso de 3
  caracteres e o limite de taxa tornam a enumeração cara. Decisão Q2 = A na spec.
- **Alternativas**: login exato (menos descobrível); lista completa (vaza o diretório e inclui VIEWER).

### D4. `edit` exige `meetings.manage` no destino

- `checkMeeting` em modo `write` exige `meetings.manage` do usuário. Um VIEWER com `edit` teria o selo "edição" e
  receberia 403 em tudo. A API recusa essa combinação (422) e `lookup` informa `canEdit`.
  Se o papel do destinatário mudar depois (rebaixado para VIEWER), o guard continua mandando; a UI do dono mostra
  "só leitura efetiva" (campo `effectiveAccess` em `ShareEntry`).

### D5. Série: lote único sem herança (opção B recomendada)

- **Decisão**: `scope: "occurrence" | "following"`. `following` = ocorrências do mesmo dono, da mesma série e com
  `COALESCE(scheduled_start, created_at) >= o da reunião de referência`. Série manual: `series_id`. Série `.ics`:
  `created_by` + `ical_uid` não nulo (as linhas diferem por `recurrence_key`). Reunião sem série: só `occurrence`.
- **Por que não herdar**: `seriesExtend.ts` e `calendar/upsert.ts` criam ocorrências sozinhos; herdar acesso nelas
  expõe conteúdo futuro sem o dono perceber. Fica como evolução (opção C) se o usuário pedir.
- **Registro**: um evento de auditoria por chamada com `affected`, não um por linha.

### D6. Notificação só dentro do app

- **Decisão**: evento WS direcionado `meeting_access` (toast + entrada na lista) e `seen_at` para o selo "Nova".
  Sem e-mail (nenhuma infraestrutura e abriria egress, Princípio I); sem notificação do desktop (o host-agent é
  só do `AGENT_OWNER`).
- **Alternativas**: B/C da pergunta #3 da spec.

### D7. Visibilidade da lista de acessos

- Só o dono lê `GET /meetings/:id/shares`. O destinatário recebe só o próprio nível e o nome do dono (`ownerName`
  no detalhe e na lista). Evita expor quem mais foi convidado (pergunta #4).

### D8. Admin

- Nenhuma rota `/admin/*` toca `meeting_shares`. `audit_log` guarda só ids (reunião, alvo), então quem tem
  `audit.read` não vê títulos nem conteúdo. Como a PK de `meeting_shares` é por reunião e o `POST` exige dono, um
  admin não consegue se autoconceder acesso a reunião alheia (404 no guard antes do handler).

### D9. Atomicidade e corrida

- `POST` abre transação, trava a linha da reunião (`SELECT ... FOR SHARE`), confere `created_by = req.user.id`,
  valida o alvo e faz `INSERT ... ON CONFLICT DO NOTHING RETURNING` (conflito vira 409). Evita conceder para um
  dono que acabou de mudar (não há transferência hoje, mas mantém o invariante).
- Auto-compartilhamento: checagem no handler e **constraint trigger** não é usada (a tabela não conhece o dono);
  o teste de banco cobre o caso.

### D10. Evento ao vivo direcionado, não difundido

- `LiveHub.publishToUser(userId, msg)` envia a todas as conexões do usuário (abas), inscritas ou não. O evento
  `meeting` difundido não muda. `meeting_access` carrega `MeetingListItem` (com o `access` do destinatário) só no
  grant, para a lista dele inserir a linha sem refetch.

### D11. Ordem das mudanças no revoke (corrida de eventos)

1. `DELETE` no banco (transação confirmada).
2. `invalidateAudience(meetingId)`.
3. `revokeUser(meetingId, userId)` (remove assinatura).
4. `publishToUser(userId, { type: "meeting_access", access: null })`.

Assim nenhum `publishBoth` posterior reentrega ao revogado, e o aviso chega por último.

## 4. Riscos

| Risco | Mitigação |
|---|---|
| Bypass do guard (maiúsculas, `//`, `%2e`) em `/shares` | Rotas novas entram em `OWNER_ONLY_*` pelo padrão registrado; teste de regressão com mutação, como o existente. |
| `GET /shares` vazar a lista a quem só lê | Conjunto de rotas "dono para qualquer método"; teste de matriz. |
| Enumeração do diretório | Piso de 3 caracteres, máx. 8, taxa, só ativos, sem e-mail; auditar excesso de 429 é opcional. |
| Lote de série expor passado | `following` só considera início ≥ referência; UI mostra a contagem antes. |
| Evento difundido com campos por espectador | Tipos separados em contracts; teste de que `meeting` não carrega `access`. |
| `MeetingSummary.url` e participantes para o destinatário | Mantido (já é assim); aviso no diálogo do dono. |
| Concorrência dono x revogação durante escrita do destinatário | Escritas passam pelo guard a cada requisição; a em andamento termina ou toma 403/404. |

## 5. Fora do escopo

Compartilhar por projeto ou grupo; link público; convite para quem não tem conta; transferência de propriedade;
re-compartilhamento por destinatário; host-agent do sócio gravando reunião compartilhada; e-mail; herança de
acesso em ocorrências futuras (opção C).
