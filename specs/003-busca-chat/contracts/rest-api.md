# Contrato — API REST da busca e do chat

Base: `http://127.0.0.1:3000/api` (mesmas convenções de `specs/001-agente-reunioes-mvp/contracts/rest-api.md`:
JSON, erros `{ "error": "mensagem em pt-BR" }`, cookie `mb_session`, `requireSameOrigin` nas mutações).
Só rotas de UI (cookie); o host-agent não usa estas rotas. Os tipos viram schemas zod em
`packages/contracts/src/search.ts`.

**Autorização** (sem permissões novas, FR-031):

- Toda rota: `meetings.read`.
- Resultados `transcript`: exigem também `transcripts.read`; `analysis`, `item`, `adr`, `meeting`: `documents.read`.
  Tipos que o papel não pode ler são removidos silenciosamente do filtro `kind`.
- Conteúdo: só reuniões de `visibleMeetingsSql` (dono ou `meeting_shares`). Reunião fora do alcance nunca é
  distinguida de inexistente.
- `POST /search/reindex`: `meetings.manage`, só reuniões do próprio usuário.
- Com `SEARCH_ENABLED=false`: as rotas respondem `404`.

Tipos:

```ts
SearchKind = "transcript" | "analysis" | "item" | "adr" | "meeting"

SearchTarget = {
  meetingId: string,
  kind: SearchKind,
  segmentId: number | null,      // transcript: primeiro segmento (ou o do destaque) ainda existente
  start: number | null,          // transcript: segundos desde o início da gravação
  end: number | null,
  itemId: string | null,         // kind = item
  adrId: string | null,          // kind = adr
}

SnippetPart = { text: string, match: boolean }

SearchHit = {
  id: number,                    // search_chunks.id (estável só até a próxima reindexação)
  kind: SearchKind,
  meeting: { id, title, date: string /* ISO */, project: { id, name } | null },
  snippet: SnippetPart[],        // ≤ ~320 caracteres, sem HTML
  speaker: string | null,        // transcript: nome exibido do falante predominante
  matchedBy: ("text" | "semantic")[],
  reviewStatus: "proposto" | "aprovado" | "rejeitado" | null,   // item/adr; estado atual
  target: SearchTarget,
}
```

## Busca

| Método | Rota | Query | Resposta |
|---|---|---|---|
| GET | `/search` | `q` (1–500 caracteres, obrigatório); `mode=hybrid\|text\|semantic` (padrão `hybrid`); `kind=transcript,item,…` (lista, padrão todos os permitidos); `projectId`; `from`, `to` (ISO date, sobre a data da reunião); `meetingId` (repetível, ≤ 20); `limit` (1–50, padrão 20); `offset` (0–100) | `{ query, mode, modeUsed, semantic: { available, reason: string \| null }, hits: SearchHit[], total, tookMs }` |

Regras:

- `modeUsed` informa o que realmente rodou (`text` quando a semântica está indisponível; `reason` explica:
  `ollama_indisponivel`, `modelo_ausente`, `sem_pgvector`, `desligada`, `indexando`).
- `total` é o número de hits após fusão limitado a 100 (a paginação vai até aí).
- `hybrid`: léxica top 50 + vetorial top 50 → RRF (k = 60) → agrupamento de trechos vizinhos → fatia
  `offset/limit`. `text`: só léxica. `semantic`: só vetorial (400 com `modeUsed` impossível → resposta
  `200` com `hits: []` e `semantic.available=false`).
- Erros: `400` (`q` vazio, só pontuação, > 500 caracteres, `kind`/data inválidos); `429` (limite de taxa).
- Registro (FR-033): log só com `userId`, `modeUsed`, contagem e tempo.

## Chat

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | `/search/chat` | `ChatRequest` | `ChatResponse`; `400`; `429`; `503 { error }` se o LLM local estiver indisponível |

```ts
ChatRequest = {
  question: string,                                   // 1–500 caracteres
  history?: { role: "user" | "assistant", content: string /* ≤ 1000 */ }[],   // ≤ 6, mais antigo primeiro
  scope?: { projectId?: string, from?: string, to?: string, meetingIds?: string[] /* ≤ 20 */ },
}

ChatResponse = {
  answered: boolean,                       // false = "não encontrei registro"
  answer: string,                          // pt-BR; marcadores [1], [2]… só para citações válidas
  citations: {
    ref: number,                           // o n de [n] no texto
    quote: string | null,                  // trecho literal validado (transcrição) ou null
    exact: boolean,                        // true = quote conferida no trecho
    label: string,                         // "Reunião X · 12/11 · 00:14:32" ou "Item (decisão, proposto)"
    proposed: boolean,                     // fonte é item/ADR ainda não aprovado
    target: SearchTarget,
  }[],
  sources: SearchHit[],                    // trechos entregues ao LLM, na ordem de [n]
  retrieval: { modeUsed: "hybrid" | "text", chunks: number, belowThreshold: boolean },
  model: string,                           // "local:qwen3.5:4b"
  liveBusy: boolean,                       // havia reunião ao vivo: contexto reduzido, fila atrás do ao vivo
  tookMs: number,
}
```

Regras:

- `answered=false` quando: sem trechos acima do limiar (o LLM nem é chamado, `belowThreshold=true`), o LLM
  respondeu `answered=false`, ou nenhuma citação sobreviveu à validação. `answer` traz a mensagem fixa
  "Não encontrei registro sobre isso nas reuniões que você pode ler." e `citations=[]`.
- A resposta só usa trechos `sources` (já filtrados por permissão e escopo).
- Sempre LLM **local** (Q1-A): o corpo não aceita `llm`/`provider`; qualquer campo desconhecido é rejeitado
  (`400`).
- `liveBusy`: ver Q5-A; o front exibe aviso de demora.
- Erros de geração do Ollama → `503` sem conteúdo de reunião na mensagem.

## Estado do índice

| Método | Rota | Query | Resposta |
|---|---|---|---|
| GET | `/search/status` | `meetingId?` | `{ enabled, semantic: { available, model, dim, reason \| null }, paused: "reuniao_ao_vivo" \| null, totals: { meetings, indexed, textReady, pending, failed, chunks }, failures: { meetingId, title, error, attempts }[] }` (só reuniões visíveis); com `meetingId`: `{ meetingId, status, chunkCount, embeddedCount, indexedAt \| null }` (404 se não visível) |
| POST | `/search/reindex` | `{ meetingId?: string }` | `202 { queued: number }`; sem `meetingId`, todas as reuniões do próprio usuário com conteúdo concluído; `404` se a reunião não for do usuário; `403` sem `meetings.manage` |

## Navegação (frontend)

Sem rota de API: o `target` vira URL da UI.

| Alvo | URL |
|---|---|
| Transcrição | `/reunioes/:id?seg=<segmentId>&t=<start>` |
| Item | `/reunioes/:id?item=<itemId>` |
| ADR | `/reunioes/:id?adr=<adrId>` |
| Ata/metadados | `/reunioes/:id` |
| Busca | `/busca?q=…&kind=…&projectId=…&from=…&to=…` e `/busca?tab=perguntar` |

`segmentId` ausente (retranscrição) → a página usa `t` para rolar e posicionar o áudio.

## Limites de taxa

`GET /search`: 60/min por usuário. `POST /search/chat`: 12/min por usuário. `POST /search/reindex`: 6/hora.
Excedeu → `429 { error }`.

## Eventos WebSocket (opcional, T-US5)

`{ type: "search_index", meetingId, status }` publicado à audiência da reunião (`meetingAudience`) ao mudar o
estado; a página da reunião e a tela de status atualizam sem recarregar. Sem conteúdo de trecho.
