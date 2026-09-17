# Contexto de build = raiz do monorepo (docker-compose.yml).
# A versão da imagem precisa bater exatamente com a do pacote playwright
# em apps/backend/package.json, senão o Chromium instalado não é o esperado.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/frontend/package.json apps/frontend/
COPY apps/backend/package.json apps/backend/
RUN npm ci --no-audit --no-fund
COPY packages/contracts packages/contracts
COPY apps/frontend apps/frontend
COPY apps/backend apps/backend
RUN npm run build -w @meeting-bot/contracts \
    && npm run build -w @meeting-bot/frontend \
    && npm run build -w @meeting-bot/backend \
    && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
    && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils ffmpeg xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/assets \
    && ffmpeg -loglevel error -f lavfi -i anullsrc=r=48000:cl=mono -t 10 -c:a pcm_s16le /app/assets/silence.wav

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DATA_DIR=/data \
    XDG_RUNTIME_DIR=/tmp/runtime-pwuser \
    DISPLAY=:99 \
    PORT=3000

# node_modules da raiz (hoisted) + workspaces necessários em runtime.
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /repo/apps/backend/dist ./apps/backend/dist
COPY --from=build /repo/apps/frontend/dist ./apps/backend/public
COPY apps/backend/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && mkdir -p /data && chown pwuser:pwuser /data

WORKDIR /repo/apps/backend
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
