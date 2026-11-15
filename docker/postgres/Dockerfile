# Postgres 16 (Alpine, a mesma base do banco existente) com a extensão pgvector compilada.
# Mesma major e mesma libc: o diretório de dados atual abre sem pg_upgrade, dump/restore ou REINDEX.
# Para subir a versão do pgvector, troque PGVECTOR_TAG e reconstrua (docker compose build postgres).
ARG PG_IMAGE=postgres:16-alpine

FROM ${PG_IMAGE} AS build
ARG PGVECTOR_TAG=v0.8.7
RUN apk add --no-cache --virtual .build-deps build-base git \
 && git clone --depth 1 --branch "${PGVECTOR_TAG}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector \
 && make with_llvm=no OPTFLAGS="" \
 && make with_llvm=no install \
 && apk del .build-deps \
 && rm -rf /tmp/pgvector

FROM ${PG_IMAGE}
ARG PGVECTOR_TAG=v0.8.7
LABEL org.opencontainers.image.title="meeting-bot-postgres" \
      org.opencontainers.image.description="postgres:16-alpine + pgvector" \
      io.meeting-bot.pgvector="${PGVECTOR_TAG}"
COPY --from=build /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=build /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
