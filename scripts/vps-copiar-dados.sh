#!/usr/bin/env bash
# Copia banco e áudio desta máquina para o servidor de teste (docs/vps-dokploy.md).
# Uso: scripts/vps-copiar-dados.sh usuario@host /caminho/do/compose/no/servidor
set -euo pipefail

destino=${1:?uso: vps-copiar-dados.sh usuario@host /caminho/do/compose}
remoto=${2:?uso: vps-copiar-dados.sh usuario@host /caminho/do/compose}
docker_local=(docker --context default)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "→ Conteúdo real desta máquina vai para $destino. O banco de lá será SUBSTITUÍDO."
read -r -p "Digite COPIAR para seguir: " ok
[ "$ok" = "COPIAR" ] || { echo "cancelado"; exit 1; }

echo "→ dump do banco local"
"${docker_local[@]}" exec meeting-bot-postgres-1 pg_dump -U meetingbot -d meetingbot --clean --if-exists > "$tmp/banco.sql"

echo "→ áudio local"
"${docker_local[@]}" cp meeting-bot-backend-1:/data/audio "$tmp/audio"

echo "→ enviando (isto pode demorar)"
tar -C "$tmp" -czf "$tmp/pacote.tgz" banco.sql audio
scp "$tmp/pacote.tgz" "$destino:/tmp/meeting-bot-pacote.tgz"

echo "→ restaurando no servidor"
ssh "$destino" "set -e
  cd '$remoto'
  rm -rf /tmp/meeting-bot-pacote && mkdir -p /tmp/meeting-bot-pacote
  tar -C /tmp/meeting-bot-pacote -xzf /tmp/meeting-bot-pacote.tgz
  docker compose exec -T postgres psql -U meetingbot -d meetingbot < /tmp/meeting-bot-pacote/banco.sql
  docker compose cp /tmp/meeting-bot-pacote/audio backend:/data/
  docker compose restart backend
  rm -rf /tmp/meeting-bot-pacote /tmp/meeting-bot-pacote.tgz"

echo "pronto: banco e áudio copiados."
