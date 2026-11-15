# Contrato — API de uso e custo de IA

Base: `/api`. Autenticação: cookie `mb_session`; `requireSameOrigin` só nas mutações (aqui tudo
é `GET`). Erros: `{ "error": "mensagem em pt-BR" }`. Tipos em `packages/contracts/src/usage.ts`
(zod). Fuso de período e de agrupamento por dia: `APP_TIMEZONE`.

## Parâmetros de período (comuns)

| Query | Regra |
|---|---|
| `month=AAAA-MM` | mês no fuso da aplicação (padrão: mês corrente) |
| `from`, `to` | ISO 8601; alternativa a `month`; `to > from`; janela máxima 24 meses; 400 se inválido |

Dar `month` junto com `from`/`to` é 400.

## Tipos

```ts
UsagePurpose  = "ata" | "adr" | "itens" | "resumo" | "ao_vivo" | "asr_final" | "asr_ao_vivo" | "outro"
UsageProvider = "ollama" | "openrouter" | "claude" | "codex" | "whisper" | "deepgram"

UsageTotals = {
  calls: number, failedCalls: number,
  inputTokens: number, outputTokens: number,
  costUsd: number | null,          // soma só das linhas com custo informado; null se nenhuma tiver
  pricedCalls: number,             // quantas linhas entraram em costUsd
  audioSeconds: number,            // ASR
  durationMs: number,
  computeMs: number | null         // tempo de inferência local; null se nenhuma linha mensurou
}
UsageGroup = UsageTotals & { key: string, label: string }   // key = purpose|provider|model|user|YYYY-MM-DD
```

## `GET /api/usage/me`

Painel do próprio usuário. Só linhas com `user_id = eu`. Autenticado; sem permissão extra
(VIEWER recebe tudo zerado).

Resposta 200:

```json
{
  "period": { "from": "2026-11-01T03:00:00.000Z", "to": "2026-12-01T03:00:00.000Z", "month": "2026-11" },
  "totals": { "...": "UsageTotals" },
  "byPurpose": [ { "key": "ata", "label": "Ata", "...": "UsageTotals" } ],
  "byProvider": [ { "key": "openrouter", "label": "OpenRouter", "...": "UsageTotals" } ],
  "byModel": [ { "key": "anthropic/claude-sonnet-5", "label": "anthropic/claude-sonnet-5", "...": "UsageTotals" } ],
  "byDay": [ { "key": "2026-11-14", "label": "14/11", "...": "UsageTotals" } ],
  "asr": {
    "local": { "audioSeconds": 5400, "computeMs": 612000, "calls": 4 },
    "external": { "audioSeconds": 1800, "costUsd": 0.0123, "calls": 2 }
  },
  "topMeetings": [
    { "meetingId": "uuid", "title": "Planejamento", "...": "UsageTotals" }
  ],
  "retention": { "usageDays": 730, "auditDays": 365 }
}
```

`retention` (0 = guardar sempre) alimenta o texto de política na tela. Também presente em
`/api/admin/usage`.

Regras:

- `topMeetings`: até 20, ordenado por tokens + minutos; **só reuniões com `created_by = eu`**
  (o título é do próprio usuário). Linhas cuja reunião foi excluída entram em `totals` e nos
  grupos, não em `topMeetings`.
- `costUsd` nulo é mostrado como "—"; o cliente nunca converte nulo em 0 para rotular preço.
- `byDay` contém todos os dias do período com consumo (dias sem consumo podem ser omitidos).

## `GET /api/usage/me/calls`

Lista paginada das chamadas do usuário (mais recentes primeiro).

| Query | Regra |
|---|---|
| período | como acima |
| `status` | `all` (padrão), `ok`, `error` |
| `purpose`, `provider` | filtros opcionais (enum) |
| `cursor`, `limit` | cursor opaco `(at,id)`; `limit` 1–100 (padrão 30) |

```json
{
  "items": [
    {
      "id": 123, "at": "2026-11-14T15:02:11.000Z",
      "purpose": "ata", "provider": "openrouter", "model": "anthropic/claude-sonnet-5",
      "category": "llm", "inputTokens": 18231, "outputTokens": 2104, "audioSeconds": null,
      "costUsd": 0.0421, "durationMs": 41230, "computeMs": null, "attempts": 1,
      "success": true, "errorCode": null,
      "meetingId": "uuid-ou-null", "meetingTitle": "Planejamento"
    }
  ],
  "nextCursor": "opaco-ou-null"
}
```

`meetingTitle` só vem para reuniões do próprio usuário; reunião excluída vem `null`.

## `GET /api/admin/usage`

Permissão: `ai_usage.read` (403 caso contrário). Agregados da instância, **sem nenhum campo de
reunião**.

```json
{
  "period": { "from": "...", "to": "...", "month": "2026-11" },
  "totals": { "...": "UsageTotals" },
  "byUser": [ { "key": "uuid-ou-instance-ou-removed", "label": "sergio", "...": "UsageTotals" } ],
  "byPurpose": [ "..." ],
  "byProvider": [ "..." ],
  "byModel": [ "..." ],
  "byDay": [ "..." ],
  "asr": { "local": { "...": "..." }, "external": { "...": "..." } }
}
```

Invariantes (testados):

- Nenhuma chave `meetingId`, `meeting`, `title`, `label` de reunião nem lista por reunião.
- `byUser.key`: `uuid` do usuário existente; `"instance"` para linhas sem `user_id` e sem
  reunião de origem (testes/utilitários); `"removed"` para usuários excluídos. `label` = nome
  de usuário (ou "Instância" / "Usuário removido"). [Q3-A: identificar por usuário.]
- Mesmo cálculo de totais do `/usage/me` (função única), para que a soma dos `byUser` seja igual
  a `totals`.

## Compatibilidade

- `GET /api/llm/usage` (existente, lê `audit_log`) foi **removido** nesta entrega (T058), junto com
  `llm/usage.ts` e a `ConsumoTab` antiga; os tipos `LlmUsage*` saíram de `contracts/domain.ts`. Decisão da
  revisão: sem alias, porque o frontend e o backend saem juntos no mesmo compose e nenhum outro consumidor
  (host-agent, agent-cli, VPS, testes) chama a rota; quem chamar recebe 404.

## Códigos de resposta

| Código | Quando |
|---|---|
| 200 | sucesso |
| 400 | período inválido, `month` com `from/to`, filtro fora do enum |
| 401 | sem sessão |
| 403 | `/admin/usage` sem `ai_usage.read` |
