# Data Model — Busca e chat (V1)

Postgres 16 (imagem própria com pgvector, research R4). As migrações ficam em `apps/backend/src/schema.ts`:
**idempotentes e apenas aditivas**, no fim da lista `statements`, sob o mesmo advisory lock já usado
(`727001`). Nenhuma tabela ou coluna existente muda. Antes da primeira execução em dados reais: `pg_dump`.

## Diagrama

```text
meetings 1─* search_chunks            (ON DELETE CASCADE)
meetings 1─0..1 search_index_state    (ON DELETE CASCADE)
search_chunks *─0..1 meeting_items    (source_id = item.id, sem FK: o item pode ser mesclado/removido)
search_chunks *─0..1 adrs             (source_id = adr.id, sem FK)
search_chunks ·· transcript_segments  (first/last_segment_id e tempos, sem FK: os segmentos são trocados no passe final)
```

Sem tabelas de conversa (Q2-A): o chat é efêmero.

## Extensões e configuração de texto

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
-- só se disponível (pg_available_extensions); caso contrário, a parte vetorial é pulada
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
    ALTER TEXT SEARCH CONFIGURATION pt_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
  END IF;
END $$;
```

`unaccent` dentro da configuração evita o problema de `unaccent()` ser `STABLE` (não serve em coluna gerada).

## Tabelas novas

### search_chunks

Unidade pesquisável. Uma linha por trecho; reconstruída por diferença de hash.

| Coluna | Tipo | Regra |
|---|---|---|
| id | BIGSERIAL PK | |
| meeting_id | UUID NOT NULL FK meetings ON DELETE CASCADE | |
| kind | TEXT NOT NULL | `transcript` \| `analysis` \| `item` \| `adr` \| `meeting` (CHECK) |
| source_id | TEXT NOT NULL DEFAULT `''` | `item.id`, `adr.id`, nome da seção da narrativa (`resumo_executivo`, `assunto:2`…) ou `''` |
| seq | INT NOT NULL DEFAULT 0 | ordem dentro de `(meeting_id, kind, source_id)`; janelas da transcrição = 0..n |
| content | TEXT NOT NULL | texto exibido e pesquisado (≤ 4000 caracteres) |
| start_seconds, end_seconds | NUMERIC | só `transcript`: faixa do trecho (relativa ao início da gravação) |
| first_segment_id, last_segment_id | BIGINT | só `transcript`; sem FK (o passe final troca os segmentos) |
| speakers | TEXT[] NOT NULL DEFAULT `'{}'` | nomes exibidos dos falantes do trecho (`transcript`) |
| content_hash | TEXT NOT NULL | sha-256 de `embed_text` + `embed_model`; decide re-embedding |
| tsv | TSVECTOR GENERATED ALWAYS AS (`to_tsvector('pt_unaccent', content)`) STORED | |
| embedding | VECTOR(1024) | `NULL` até ser calculado (ou se a semântica estiver indisponível) |
| embed_model | TEXT | modelo que gerou o vetor (ex.: `bge-m3`) |
| embedded_at | TIMESTAMPTZ | |
| created_at, updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Restrições e índices:

- `UNIQUE (meeting_id, kind, source_id, seq)`: chave do upsert incremental.
- `GIN (tsv)`: busca textual.
- `HNSW (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`: busca vetorial (só se a extensão
  existir; índice parcial `WHERE embedding IS NOT NULL` evita indexar pendentes).
- `(meeting_id, kind)`: remoção/invalidação por reunião e por tipo.
- `(embed_model)` parcial `WHERE embedding IS NOT NULL`: contagem de "indexados com o modelo atual".

Regras:

- O texto de embedding **não é guardado**: é `"<título> — <data>\n" + content` calculado na indexação; o hash o
  cobre. Mudou título → muda hash de todos os trechos → re-embedding (barato; só acontece em edição de título).
- `kind='item'`: **rejeitados não geram trecho**; quando um item passa a `rejeitado`, o trecho é removido; ao
  reabrir (`proposto`), volta. O selo `proposto`/`aprovado` **não é guardado**: a consulta junta
  `meeting_items.review_status` na hora (research R6/FR-006). Mesmo para `adrs.status`.
- `kind='transcript'` só nasce de segmentos `pass='final'`. No passe final, a mesma transação que insere os
  `final` e apaga os `live` também apaga `search_chunks WHERE kind='transcript' AND meeting_id = $1` e marca a
  reunião como suja (FR-014).
- Segmentos de `mic` e `remote` entram na mesma sequência temporal, ordenados por `start_seconds`.
- `source_id` de item/ADR não tem FK de propósito: itens mesclados (`merged`) somem sem deixar trecho órfão
  porque a reindexação remove o que não existe mais; a consulta ainda confere `EXISTS` na junção para nunca
  devolver trecho cujo item não existe.

### search_index_state

Fila durável e estado por reunião.

| Coluna | Tipo | Regra |
|---|---|---|
| meeting_id | UUID PK FK meetings ON DELETE CASCADE | |
| status | TEXT NOT NULL | `pending` \| `indexing` \| `text_ready` \| `indexed` \| `failed` (CHECK) |
| dirty_at | TIMESTAMPTZ NOT NULL DEFAULT now() | último pedido de reindexação; debounce usa `now() - dirty_at ≥ 20 s` |
| text_indexed_at | TIMESTAMPTZ | fim da fase de texto |
| indexed_at | TIMESTAMPTZ | fim da fase de vetores |
| chunk_count | INT NOT NULL DEFAULT 0 | |
| embedded_count | INT NOT NULL DEFAULT 0 | |
| attempts | INT NOT NULL DEFAULT 0 | zera quando conclui |
| next_attempt_at | TIMESTAMPTZ | espera exponencial após falha |
| last_error | TEXT | motivo curto (sem conteúdo de reunião), ≤ 300 caracteres |
| embed_model | TEXT | modelo da última indexação completa |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Índice: `(status, dirty_at)` para o worker (`WHERE status IN ('pending','text_ready')`).

#### Máquina de estados

```text
(nova/alterada) ─markDirty──► pending
pending ──worker pega──► indexing ──fase de texto ok──► text_ready
text_ready ──gate aberto + Ollama ok──► indexing ──vetores ok──► indexed
indexing ──erro──► pending (attempts+1, next_attempt_at) ──5 falhas──► failed
failed|indexed ──"Reindexar"/markDirty──► pending
boot: indexing ──► pending (recuperação)
```

`text_ready` significa "pesquisável por texto; vetores pendentes" (gate fechado, Ollama fora ou modelo ausente).
Com a semântica desligada de propósito (Q3-A no VPS) o estado final é `text_ready` e a tela mostra
"somente texto" em vez de pendência.

## Seeds / backfill (no boot, idempotente)

```sql
INSERT INTO search_index_state (meeting_id, status)
SELECT m.id, 'pending' FROM meetings m
 WHERE m.status = 'done'
ON CONFLICT (meeting_id) DO NOTHING;
```

Reuniões que concluem depois entram pelo gatilho. Reuniões não concluídas (`error`, `recording`, `scheduled`…)
não têm linha; ao concluir, ganham uma.

## Consultas de leitura (referência para a implementação)

Permissão e kinds permitidos (sempre parametrizados; `$1` = id do usuário):

```sql
FROM search_chunks c
JOIN meetings m ON m.id = c.meeting_id
LEFT JOIN meeting_items it ON c.kind = 'item' AND it.id::text = c.source_id
LEFT JOIN adrs a            ON c.kind = 'adr'  AND a.id::text  = c.source_id
WHERE <visibleMeetingsSql(user, 'm', 1)>
  AND c.kind = ANY($kinds)                          -- por permissão do papel e filtro do usuário
  AND (c.kind <> 'item' OR (it.id IS NOT NULL AND it.review_status <> 'rejeitado'))
  AND (c.kind <> 'adr'  OR (a.id  IS NOT NULL AND a.status <> 'rejeitado'))
  AND ($project::uuid IS NULL OR m.project_id = $project)
  AND ($from::timestamptz IS NULL OR m.scheduled_start >= $from)   -- ou COALESCE(started_at, created_at)
  AND ($to::timestamptz   IS NULL OR m.scheduled_start <  $to)
```

Léxica: `c.tsv @@ websearch_to_tsquery('pt_unaccent', $q)` ordenada por `ts_rank_cd(c.tsv, q, 32)`.
Vetorial: `c.embedding IS NOT NULL AND c.embed_model = $model` ordenada por `c.embedding <=> $qvec::vector`
(com `SET LOCAL hnsw.iterative_scan = relaxed_order; hnsw.ef_search = 80; hnsw.max_scan_tuples = 20000`).

Data de referência da reunião para filtro/ordenação: `COALESCE(m.started_at, m.scheduled_start, m.created_at)`.

## Estado em memória (não persistido)

- **Debounce** de `markDirty` (mapa `meetingId → timer`); se o processo reinicia, vale `dirty_at` no banco.
- **Cache de saúde do embedder** (modelo presente, dimensão conferida): TTL de 30 s.
- **Gate:** derivado do banco (`SELECT 1 FROM meetings WHERE status IN (…) LIMIT 1`) a cada tick; sem estado.
- **Histórico do chat:** no cliente (FR-028).

## Impacto na exclusão e retenção

- Excluir reunião → cascata em `search_chunks` e `search_index_state`.
- `transcripts.delete` (excluir transcrição e áudio) → além do que já ocorre, apagar `search_chunks` de
  `kind='transcript'` da reunião (a rota existente passa a chamar `invalidateTranscript(meetingId)`).
- Vetores e tsvector são dados derivados do conteúdo e não podem sobreviver a ele.
