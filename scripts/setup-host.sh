#!/usr/bin/env bash
# Prepara o host Ubuntu para o agente: GPU NVIDIA em containers do Docker
# Engine nativo e utilitários de áudio. Idempotente.
# Uso: sudo bash scripts/setup-host.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Rode com sudo: sudo bash $0" >&2
  exit 1
fi

KEYRING=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
LIST=/etc/apt/sources.list.d/nvidia-container-toolkit.list

echo "==> Pré-requisitos e utilitários de áudio"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg2 pulseaudio-utils

echo "==> Repositório do NVIDIA Container Toolkit"
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o "$KEYRING"
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed "s#deb https://#deb [signed-by=${KEYRING}] https://#g" > "$LIST"

echo "==> Instalando o toolkit"
apt-get update
apt-get install -y nvidia-container-toolkit

echo "==> Registrando o runtime NVIDIA no Docker Engine nativo"
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "==> Pronto. Versões:"
nvidia-ctk --version | head -1
docker --context default info --format 'runtimes: {{range $k, $v := .Runtimes}}{{$k}} {{end}}'
