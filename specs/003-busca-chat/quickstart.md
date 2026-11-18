# Quickstart — validação da busca e do chat (V1)

Guia para provar, de ponta a ponta, que a funcionalidade funciona. Detalhes de API em
[contracts/](contracts/) e de dados em [data-model.md](data-model.md). **Nada aqui deve ser executado no
ambiente do usuário sem a confirmação dele e com o backend ocioso** (sem reunião gravando ou processando).

## Pré-requisitos

- MVP da spec 001 rodando e ao menos uma reunião concluída (de preferência 3 ou mais, de assuntos diferentes).
- Docker Engine nativo (`docker --context default`); `nvidia-smi` funcionando.
- Branch `feat/003-busca-chat` implementada e mesclada (tarefas T001–T061).

## 1. Migração da infraestrutura (uma vez)

```bash
# 0. confirmar que não há reunião gravando/processando (UI ou GET /api/system/status)
mkdir -p ~/backups
docker --context default compose exec postgres pg_dump -U meetingbot -Fc meetingbot > ~/backups/meetingbot-$(date +%F).dump
docker --context default compose build postgres
docker --context default compose up -d postgres ollama        # recria com o volume pgdata existente
docker --context default compose exec postgres psql -U meetingbot -d meetingbot -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','unaccent');"
docker --context default compose exec ollama ollama pull bge-m3   # download inicial (permitido)
docker --context default compose up -d --build backend
```

Esperado: `vector` e `unaccent` listadas; backend sobe sem erro (se o Postgres ainda for a imagem antiga, o boot falha com a
mensagem "A extensão pgvector não está disponível…"); o backfill roda em segundo plano (Configurações > Busca).
A migração é idempotente (`CREATE EXTENSION IF NOT EXISTS vector`) e o `pg_dump` do passo 0 tem que ser da mesma major (16) para
restaurar.

Rollback: `SEARCH_ENABLED=false` no `.env` e `docker compose up -d backend`. Para voltar a imagem do Postgres:
`DROP EXTENSION vector CASCADE;` e voltar `image: postgres:16-alpine`.

## 2. Conferir o consumo de recursos (Princípio V)

```bash
nvidia-smi --query-gpu=memory.used --format=csv   # anotar ANTES
# aguardar a indexação das reuniões (Configurações > Busca) e fazer 5 buscas
nvidia-smi --query-gpu=memory.used --format=csv   # DEPOIS: diferença esperada = 0 MiB
docker --context default stats --no-stream ollama # RAM do Ollama com o bge-m3 carregado (≤ ~2,5 GB a mais)
```

## 3. Busca (US1)

1. Abrir `http://127.0.0.1:3000/busca` (ou `Ctrl+K`).
2. Buscar uma palavra literal de uma fala → resultado com trecho destacado e selo "texto".
3. Buscar um sinônimo (ex.: "autenticação" quando a fala diz "login") → resultado com selo "semântica".
4. Aplicar filtros de projeto, período e tipo → só entram resultados compatíveis.
5. Clicar num resultado de transcrição → a reunião abre rolada no segmento, em destaque, com o áudio
   posicionado sem tocar; clicar num item e num ADR → abrem o item/ADR em destaque.
6. Rejeitar um item na reunião e buscar o texto dele → não aparece; aprovar outro → selo muda na busca.
7. Parar o Ollama (`docker compose stop ollama`) → busca continua, com aviso "modo texto"; religar.

## 4. Índice sempre atual (US2)

1. Concluir uma reunião (ou reprocessar) e cronometrar até ela ser achada por texto (≤ 1 min) e por semântica
   (≤ 5 min, reunião de 1 h).
2. Renomear um falante, editar um item, mudar o título → a busca reflete em até ~1 min.
3. Iniciar uma gravação (Gravar agora) com reuniões pendentes: em Configurações > Busca o status mostra
   "em pausa: reunião ao vivo"; nos logs do backend/Ollama não há chamadas `/api/embed` até a gravação parar.
4. Reiniciar o backend no meio de uma indexação → ao voltar, retoma sem duplicar.

## 5. Chat (US3)

1. Aba **Perguntar**: "O que ficou decidido sobre <assunto de uma reunião real>?" → resposta em pt-BR com
   marcadores [1], [2]; clicar em cada chip abre a reunião no horário citado e a fala confere.
2. Pergunta sobre algo que nunca foi discutido → "Não encontrei registro…", sem citações.
3. Seguimento ("e quem ficou responsável?") → usa a conversa anterior.
4. Escopo: limitar a um projeto e a um período → fontes só desse recorte.
5. Com uma gravação em andamento: o chat avisa que pode demorar e a gravação segue normal (latência do texto
   ao vivo sem piora perceptível).
6. Tempo da primeira resposta com a GPU livre: ≤ 30 s (anotar).

## 6. Isolamento (US4)

1. Criar o usuário B (`docker compose exec backend npm run user:create -- <usuario>`).
2. Logado como B: buscar e perguntar sobre um assunto exclusivo das reuniões de A → nada de A (nem título,
   nem contagem em Configurações > Busca).
3. A compartilha uma reunião com B (leitura) → B passa a achá-la; A revoga → some na próxima busca.
4. Logado como ADMIN/SUPER_ADMIN sem relação com A → também não vê.

## 7. Testes automatizados

```bash
npm run typecheck
npm test                                      # vitest (chunker, rrf, snippet, embedder, chat)
npm run test:db -w @meeting-bot/backend       # Postgres descartável com a imagem própria (pgvector)
npm run build -w @meeting-bot/frontend
```

## Critérios de aceite (resumo)

| Critério | Como verificar |
|---|---|
| SC-001 recall@5 ≥ 85 % | script do golden set (T006/T055) |
| SC-002 busca ≤ 1,5 s p95 com 100 mil trechos | teste de carga (T068) |
| SC-003 pesquisável ≤ 1 min (texto) / ≤ 5 min (semântica) | passo 4.1 |
| SC-004 VRAM +0, RAM ≤ 2,5 GB | passo 2 |
| SC-005 sem embedding durante a gravação | passo 4.3 |
| SC-006 chat: citações válidas, "não encontrei" correto, ≤ 30 s | passo 5 + T055 |
| SC-007 zero vazamento | passo 6 + `busca-isolamento.test.ts` |
| SC-008 backfill sem intervenção | primeira subida com reuniões antigas |
