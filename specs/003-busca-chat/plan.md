# Implementation Plan: Busca e chat sobre as reuniões (V1)

**Branch**: `003-busca-chat` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-busca-chat/spec.md`

## Summary

O backend ganha um módulo `search/` que transforma cada reunião concluída em trechos pesquisáveis
(`search_chunks`) no mesmo Postgres, com texto (`tsvector` português sem acento) e vetor (pgvector `vector(1024)`,
HNSW). Os vetores vêm do **`bge-m3` via Ollama, em CPU** (0 MiB de VRAM). Um worker em segundo plano, guiado pela
tabela `search_index_state`, indexa de forma incremental depois do pós-reunião e de cada edição relevante, faz o
backfill das reuniões antigas e **pausa os embeddings enquanto houver gravação ou chamada**. A API serve busca
híbrida (RRF) e um chat RAG local (`qwen3.5:4b`, JSON por schema, citações validadas), sempre com a permissão
aplicada **na consulta** por `visibleMeetingsSql`, sem guardar dono no índice. O frontend ganha a página `/busca`
(busca + aba "Perguntar") e o deep link por trecho em `/reunioes/:id`.

Mudanças de infraestrutura (a confirmar com o usuário antes de aplicar): imagem própria do Postgres
(`postgres:16-alpine` + pgvector compilado, sem migração de dados) e `OLLAMA_MAX_LOADED_MODELS` de 1 para 2.

## Technical Context

**Language/Version**: Node 24 + TypeScript 5.9 (backend, CommonJS), React 19 + Vite (frontend). Sem código Python novo.

**Primary Dependencies**:
- Backend: `pg` (já existe), `zod` 4, `express-rate-limit` (já existe); **nenhuma dependência npm nova** (vetor é
  passado como texto ao SQL; o cliente do Ollama é `fetch`).
- Banco: Postgres 16 + extensões `vector` (pgvector ≥ 0.8.0, tag fixa v0.8.7, a verificar nas notas) e `unaccent`.
- Ollama 0.32.14: `bge-m3` (embedding, CPU) e `qwen3.5:4b` (chat, já existente).

**Storage**: tabelas novas `search_chunks` e `search_index_state` (data-model.md); `pgdata` existente.

**Testing**: Vitest (unitários sem banco); `npm run test:db -w @meeting-bot/backend` (Postgres descartável,
agora com a imagem própria), com vetores sintéticos determinísticos; spike de medição com Ollama real (T006);
golden set de 20 consultas em fixtures sintéticas; validação manual com reunião real (quickstart).

**Target Platform**: Ubuntu 26.04, Docker Engine nativo, RTX 4050 6 GB (a funcionalidade não usa VRAM). VPS de teste:
só texto (Q3-A).

**Project Type**: aplicação web local (backend + frontend); nenhum serviço novo.

**Performance Goals**: SC-002 (busca ≤ 1,5 s p95 com 100 k trechos), SC-003 (1 h de reunião pesquisável por texto
≤ 1 min e por semântica ≤ 5 min), SC-006 (chat ≤ 30 s p90 com GPU livre).

**Constraints**:
- LOCAL_ONLY: embedding e chat só no Ollama; egress guard inalterado; nenhum texto em log.
- VRAM +0; RAM do embedding ≤ 2,5 GB; embeddings pausados com reunião ao vivo.
- Migração aditiva/idempotente, com `pg_dump` e confirmação do usuário.
- Permissão sempre na consulta (nada de dono no índice).

**Scale/Scope**: 1–2 usuários, ~5 reuniões/dia → 10^4–10^5 trechos; ~80 trechos por reunião de 1 h.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| I. Local-first | Embeddings (`bge-m3`) e chat (`qwen3.5:4b`) só no Ollama local; mesmo host já permitido no egress guard; sem saída de rede nova (o download inicial do modelo é a exceção já prevista). A exceção de LLM externo (1.4.0) **não** é estendida ao chat (FR-021, Q1). Sem texto em log/auditoria. UI continua em `127.0.0.1`. O Princípio I já exige que embedding rode localmente. | ✅ (Q1/Q3 marcadas) |
| II. Políticas da org. | Sem integração externa; só dados que o sistema já guarda. | ✅ |
| III. Humano no controle | Itens/ADRs `propostos` aparecem sinalizados na busca e rotulados no chat; `rejeitados` nunca aparecem; o selo é lido na consulta (estado atual). O chat só propõe texto; nada vira definitivo (Q4). | ✅ |
| IV. Rastreabilidade | Toda resposta do chat exige citação válida (reunião + horário/segmento, ou item/ADR) e quote literal conferida; sem evidência, sem afirmação (FR-022/FR-023). Trechos guardam segmentos e tempos; retranscrição invalida e reconstrói. "Embeddings armazenados em entidades separadas e ligadas por chave" — `search_chunks` com `meeting_id`. | ✅ |
| V. GPU | Embeddings em CPU (`num_gpu: 0`), como já prevê o princípio ("Embeddings rodam em CPU"). **Medição obrigatória antes da adoção** (T006: VRAM +0, RAM, tempo, qualidade pt-BR). Pausa durante a reunião; falta de recurso degrada para texto/fila. Chat usa o LLM já carregado e o `num_ctx` do momento. Ajuste `OLLAMA_MAX_LOADED_MODELS=2` justificado em R3. | ✅ (T006 gate) |
| VI. Desktop nativo/serviços em container | Tudo no backend/Postgres/Ollama em container; nenhuma mudança no host-agent. | ✅ |
| VII. Incremental e verificável | É item da V1; o MVP (spec 001) está entregue. Critérios SC-001..008 mensuráveis; testes Vitest/db; validação com reunião real no quickstart antes de declarar pronto. Dúvidas de comportamento (Q1–Q5) perguntadas antes de implementar. | ✅ |
| VIII. Stack | Já prevê "Postgres + pgvector" — esta feature cumpre o desvio justificado em 001 (Complexity Tracking). **Redis continua adiado**: a fila durável é `search_index_state` no próprio Postgres. Sem emenda necessária. | ✅ |
| Regras operacionais | Acesso: RBAC e isolamento por dono respeitados; admin não lê conteúdo alheio. Retenção: vetores seguem o conteúdo (cascata). | ✅ |

Reavaliação pós-design (Phase 1): sem violações novas. Nenhuma emenda constitucional é necessária **com as
recomendações A** de Q1–Q5; as opções B/C de Q1 e Q3-C exigiriam emenda MINOR.

## Project Structure

### Documentation (this feature)

```text
specs/003-busca-chat/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.md          # /api/search, /api/search/chat, /api/search/status, /api/search/reindex
│   ├── chat-llm.md          # schema de saída do LLM, prompt, validação de citações
│   └── embeddings.md        # cliente do Ollama /api/embed e variáveis de configuração
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
docker/postgres/Dockerfile           # NOVO: postgres:16-alpine + pgvector compilado (R4)
docker-compose.yml                   # postgres: build; ollama: OLLAMA_MAX_LOADED_MODELS=2
docker-compose.vps.yml               # postgres: build (mesma imagem; semântica desligada, Q3-A)
.env.example  .env.vps.example       # SEARCH_*, EMBED_*, CHAT_*
packages/contracts/src/search.ts     # NOVO: zod de consulta, hit, chat, status
apps/backend/
├── scripts/test-db.mjs  e2e.mjs     # usar a imagem própria
├── src/
│   ├── schema.ts                    # + extensões, pt_unaccent, search_chunks, search_index_state, seed
│   ├── config.ts                    # + search/embed/chat
│   ├── modules.ts                   # + import "./search/module"
│   ├── search/                      # NOVO
│   │   ├── module.ts                # registra rotas (features.authedRouters), worker (starters/stoppers)
│   │   ├── config.ts                # leitura/validação das variáveis SEARCH_*/EMBED_*/CHAT_*
│   │   ├── chunker.ts               # puro: segmentos/itens/ADR/narrativa → trechos
│   │   ├── embedder.ts              # cliente /api/embed (CPU, lote, validação de dimensão)
│   │   ├── gate.ts                  # "há reunião ao vivo?" + estado de saúde do embedder
│   │   ├── indexer.ts               # monta trechos do banco, upsert por hash, embeda pendentes
│   │   ├── worker.ts                # loop, fila (SKIP LOCKED), backoff, recuperação no boot
│   │   ├── dirty.ts                 # markDirty (debounce) usado pelos hooks
│   │   ├── query.ts                 # léxica + vetorial + permissão + filtros
│   │   ├── rrf.ts                   # puro: fusão e agrupamento
│   │   ├── snippet.ts               # puro: ts_headline → SnippetPart[]
│   │   ├── routes.ts                # GET /search, GET /search/status, POST /search/reindex
│   │   └── chat/
│   │       ├── prompt.ts            # SYSTEM_CHAT, montagem do contexto e do orçamento de tokens
│   │       ├── service.ts           # recuperação → LLM local → validação → resposta
│   │       ├── validate.ts          # puro: citações (ref, quote), marcadores [n]
│   │       └── routes.ts            # POST /search/chat
│   ├── repo/transcripts.ts          # replaceWithFinal: invalida trechos de transcrição na mesma transação
│   ├── pipeline.ts                  # após markDone → markDirty(meetingId)
│   ├── items/service.ts             # criar/editar/aprovar/rejeitar/reabrir/mesclar, ADR → markDirty
│   ├── ata/routes.ts  routes.ts     # retranscrição, renomear falante, PATCH reunião, excluir transcrição → markDirty/invalidate
│   └── cli/reindex.ts               # NOVO: npm run search:reindex
└── test/
    ├── search-chunker.test.ts  search-rrf.test.ts  search-snippet.test.ts
    ├── chat-validate.test.ts  chat-prompt.test.ts  search-embedder.test.ts
    ├── fixtures/search/golden.json
    └── db/busca.test.ts  db/busca-isolamento.test.ts  db/busca-indexacao.test.ts
apps/frontend/src/
├── api.ts                           # + search/chat/status
├── pages/Busca.tsx                  # NOVO: busca + aba Perguntar
├── components/{SearchBox,SearchResult,SearchFilters,ChatPanel,CitationChip,SearchStatusCard}.tsx
├── pages/Reuniao.tsx                # deep link ?seg=&t=&item=&adr=; selo "indexada"
├── pages/Configuracoes.tsx (ou settings/)  # cartão de status e Reindexar
└── App.tsx                          # rota /busca, atalho Ctrl+K
docs/ARCHITECTURE.md  docs/vps-dokploy.md  docs/analise/agente-local.md (§15 medições)
README.md README.en.md README.es.md CHANGELOG.md CLAUDE.md
```

**Structure Decision**: módulo `search/` autônomo no backend existente, registrado pelo mesmo mecanismo
`features` (rotas, starters, stoppers) usado pelos demais módulos; os pontos de contato com o código atual são
poucos e pequenos (hooks `markDirty` e uma invalidação em `replaceWithFinal`). Nenhum container novo; a única
mudança de infraestrutura é a imagem do Postgres e um parâmetro do Ollama.

## Decisões do dono (registro da T066)

Em 2026-11-15 o dono aceitou a **opção A** de Q1–Q5: chat só local (Q1), conversa efêmera no navegador (Q2), VPS só com busca de texto (Q3), itens propostos servem de fonte rotulados (Q4) e chat permitido com reunião ao vivo, atrás da análise ao vivo (Q5). Com isso **nenhuma emenda constitucional é necessária** (a exceção da 1.4.0 não se estende ao chat). Também autorizou: trocar a imagem do Postgres pela própria com pgvector (`docker/postgres`) mantendo a major 16 e a base Alpine, `OLLAMA_MAX_LOADED_MODELS=2` e a migração com `CREATE EXTENSION vector` que falha com mensagem clara se a extensão não existir (`SEARCH_SEMANTIC=off` ou `SEARCH_ENABLED=false` para rodar só com texto).

Desvios do plano original registrados na implementação:

- **Extensão ausente:** o `data-model.md` previa pular a parte vetorial; a decisão do dono é falhar com mensagem clara (evita subir o backend novo sobre a imagem antiga sem perceber). Quem quer só texto usa `SEARCH_SEMANTIC=off` (FR-036 continua valendo nesse modo).
- **Fila:** o debounce usa `dirty_at` no banco (sem mapa de timers em memória), o que sobrevive a reinício.
- **Uso de IA:** as finalidades `busca` (embeddings) e `chat` entram em `ai_usage_logs` (a restrição `ai_usage_logs_purpose_check` é recriada, idempotente) e no painel da 004.
- **T006, T045, T055, T069** (medições com o Ollama real e reunião real) dependem de `ollama pull bge-m3` e de uma reunião real, que ficam para o dono; os valores sintéticos e de carga estão em `docs/analise/agente-local.md` §15.

## Migração e plano de rollout

1. Implementar e testar tudo com o Postgres descartável (imagem própria). Nada toca o ambiente do usuário.
2. **Com confirmação explícita do usuário**, e só com o backend ocioso (nenhuma reunião gravando ou
   processando — memória "deploy só com backend ocioso"):
   1. `pg_dump` do banco para `~/backups/` (fora do repositório);
   2. `docker --context default compose build postgres`;
   3. `docker --context default compose up -d postgres ollama` (recria com o volume `pgdata` existente; a
      major é a mesma, sem `pg_upgrade`);
   4. `docker --context default compose exec ollama ollama pull bge-m3` (download inicial permitido);
   5. subir o backend novo: a migração cria extensões, tabelas e o seed de backfill.
3. O backfill roda em segundo plano; acompanhar em Configurações > Busca.
4. **Rollback:** `SEARCH_ENABLED=false` desliga a funcionalidade sem desfazer nada. Voltar a imagem para
   `postgres:16-alpine` é seguro se for feito `DROP EXTENSION vector CASCADE` antes (as tabelas `search_*` são
   descartáveis e reconstruíveis); o restante do schema não depende da extensão.

## Complexity Tracking

| Violation / ponto de atenção | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Imagem própria do Postgres (Dockerfile novo) | pgvector não vem na `postgres:16-alpine`; a troca para a imagem Debian oficial muda a ordenação de texto (musl→glibc) e exige dump/restore ou REINDEX (risco registrado em 001) | Imagem oficial do pgvector: janela de manutenção e risco de índice inválido nos dados existentes |
| `OLLAMA_MAX_LOADED_MODELS` 1 → 2 | O embedding (CPU) e o `qwen3.5:4b` (GPU) precisam coexistir sem se descarregarem mutuamente | Manter 1: cada busca/indexação recarregaria o LLM (~10 s) e vice-versa; segundo container Ollama só se a medição mostrar interferência |
| Tabela `search_index_state` como fila | Fila durável sem Redis (adiado em 001); sobrevive a reinício | Fila em memória: perde o backfill e as reindexações pendentes no reinício |
| Duas fases de indexação (texto/vetores) | O texto não depende de Ollama nem de GPU/CPU pesada e deve ficar disponível mesmo com a reunião ao vivo e com o Ollama fora | Fase única: a busca de texto ficaria bloqueada pelo gate dos embeddings |
