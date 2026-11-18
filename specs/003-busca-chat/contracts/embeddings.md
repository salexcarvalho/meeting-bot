# Contrato — Embeddings locais (backend → Ollama)

Cliente: `apps/backend/src/search/embedder.ts`. Destino: `OLLAMA_URL` (host `ollama`, já no
`EGRESS_ALLOWLIST`); passa pelo egress guard como qualquer `fetch`. Nenhuma saída nova de rede.

## Requisição

`POST {OLLAMA_URL}/api/embed`

```json
{
  "model": "bge-m3",
  "input": ["texto 1", "texto 2"],
  "truncate": true,
  "keep_alive": "10m",
  "options": { "num_gpu": 0 }
}
```

- `input`: lote de até `EMBED_BATCH` (padrão 16) textos; cada texto ≤ ~1200 caracteres (trecho + prefixo de
  contexto). `bge-m3` não precisa de prefixo de tarefa; para outros modelos, `EMBED_DOC_PREFIX` e
  `EMBED_QUERY_PREFIX` (vazios por padrão).
- `options.num_gpu: 0`: **sempre**, em toda chamada (CPU; 0 MiB de VRAM). As opções são constantes para que o
  Ollama não recarregue o runner (research R3).
- `keep_alive`: `EMBED_KEEP_ALIVE` (padrão `10m`).
- `truncate: true`: um texto maior que o contexto é cortado (melhor que erro); o chunker já evita isso.
- Timeout por lote: 120 s; 3 tentativas com espera crescente dentro do lote; falha final → erro tipado
  `EmbedUnavailableError`/`EmbedModelMissingError`/`EmbedDimensionError` (o worker traduz em estado).

## Resposta (200)

```json
{ "model": "bge-m3", "embeddings": [[0.01, -0.02, "…1024 números"], [ … ]], "total_duration": 123456789 }
```

Validações no cliente:

- `embeddings.length === input.length`;
- cada vetor tem exatamente `EMBED_DIM` (1024) números finitos; senão `EmbedDimensionError` (nunca grava vetor
  com dimensão errada);
- normalização L2 conferida/aplicada se a norma divergir de 1 (cosseno funciona sem, mas mantém consistência
  entre modelos).

## Consulta

- Mesma chamada com 1 texto (`EMBED_QUERY_PREFIX` + pergunta/busca).
- Vetor passado ao SQL como parâmetro de texto `'[0.1,0.2,…]'::vector` (só números formatados por
  `Number.prototype.toString`; nunca interpolação de string do usuário).
- Timeout 8 s; falha → a busca cai para texto (`modeUsed="text"`).

## Saúde

`GET {OLLAMA_URL}/api/tags` (já usado por `OllamaProvider.health`): confere se `EMBED_MODEL` está baixado. Sem
ele: `reason = "modelo_ausente"` e a mensagem de status traz o comando de download
(`docker compose exec ollama ollama pull bge-m3`). **O download inicial é a saída de rede permitida pelo
Princípio I**; o backend nunca baixa modelos sozinho.

## Variáveis de configuração (`config.ts`, `.env.example`)

| Variável | Padrão | Uso |
|---|---|---|
| `SEARCH_ENABLED` | `true` | liga rotas, worker e hooks |
| `SEARCH_SEMANTIC` | `auto` | `auto` (liga se pgvector e modelo existirem), `off`, `on` (erro claro se faltar) |
| `EMBED_MODEL` | `bge-m3` | modelo no Ollama |
| `EMBED_DIM` | `1024` | dimensão da coluna `vector` (mudar exige migração) |
| `EMBED_KEEP_ALIVE` | `10m` | permanência do modelo em RAM |
| `EMBED_BATCH` | `16` | textos por requisição |
| `EMBED_DOC_PREFIX`, `EMBED_QUERY_PREFIX` | vazio | para modelos que pedem instrução |
| `SEARCH_INDEX_DEBOUNCE_SECONDS` | `20` | agrupar edições antes de reindexar |
| `CHAT_MIN_SIMILARITY` | `0.45` (a calibrar em T006) | limiar de relevância do chat |
| `CHAT_MAX_CONTEXT_TOKENS` | `3500` (8192) / `2000` (4096) | orçamento de contexto |
