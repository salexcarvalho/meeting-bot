#!/usr/bin/env bash
# Instala o host-agent para o usuário atual (sem sudo):
#   - ambiente Python 3.12 em ~/.local/share/agente-reunioes/venv (uv)
#   - config em ~/.config/agente-reunioes/config.toml
#   - unit systemd --user ligada à sessão gráfica
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/agente-reunioes"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/agente-reunioes"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

for cmd in uv parec pactl notify-send zenity canberra-gtk-play xdg-open; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "aviso: '$cmd' não encontrado — instale antes de usar (ver scripts/setup-host.sh)" >&2
  fi
done

if [ ! -f "$REPO/.env" ]; then
  echo "erro: $REPO/.env não existe (copie .env.example e defina AGENT_TOKEN)" >&2
  exit 1
fi
if ! grep -qE '^AGENT_TOKEN=.{32,}' "$REPO/.env"; then
  echo "erro: defina AGENT_TOKEN no $REPO/.env (openssl rand -hex 32)" >&2
  exit 1
fi

mkdir -p "$DATA" "$CONF" "$UNIT_DIR"
echo "==> criando ambiente Python em $DATA/venv"
uv venv --quiet --allow-existing --python 3.12 "$DATA/venv"
VIRTUAL_ENV="$DATA/venv" uv pip install --quiet --python "$DATA/venv/bin/python" "$HERE"

if [ ! -f "$CONF/config.toml" ]; then
  cat > "$CONF/config.toml" <<TOML
# Configuração do host-agent do Agente de Reuniões.
# O AGENT_TOKEN, BIND_ADDRESS e HOST_PORT são lidos deste .env:
env_file = "$REPO/.env"
# backend_url = "http://127.0.0.1:3000"
TOML
  chmod 600 "$CONF/config.toml"
  echo "==> config criada em $CONF/config.toml"
fi

install -m 644 "$HERE/systemd/agente-host.service" "$UNIT_DIR/agente-host.service"
systemctl --user daemon-reload
systemctl --user enable agente-host.service >/dev/null
systemctl --user restart agente-host.service
echo "==> serviço ativo:"
systemctl --user --no-pager --lines=5 status agente-host.service || true
