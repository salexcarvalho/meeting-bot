# Agente em modo "llm" (AGENTE_MODE=llm): sem desktop, só executa as gerações com o CLI da
# assinatura. Usado no servidor (Dokploy); no computador do dono o agente roda nativo (systemd).
FROM node:24-bookworm-slim AS node

FROM python:3.12-slim-bookworm
# Node só para o CLI do Claude Code.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# O login do CLI fica no volume montado em /home/agente (HOME).
RUN useradd --create-home --home-dir /home/agente --uid 10001 agente
USER agente
ENV HOME=/home/agente \
    AGENTE_MODE=llm \
    AGENTE_LLM_ENABLED=claude \
    PYTHONUNBUFFERED=1
CMD ["agente-host"]
