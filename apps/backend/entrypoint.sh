#!/bin/bash
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# `docker restart` mantém o /tmp: o pid e o socket antigos fazem o PulseAudio
# achar que já está rodando e recusar a subida (loop de reinício).
rm -rf "$XDG_RUNTIME_DIR/pulse"

# PulseAudio mínimo (sem detecção de hardware): só o socket local. Os
# sinks de cada reunião são criados pelo Node (src/bot/audio.ts).
pulseaudio --daemonize=yes -n \
  --load="module-native-protocol-unix" \
  --exit-idle-time=-1 --disallow-exit --log-target=stderr

for _ in $(seq 1 20); do
  pactl info >/dev/null 2>&1 && break
  sleep 0.5
done

# Fonte padrão silenciosa: o "microfone" do bot nunca devolve o áudio da
# reunião pra call, mesmo que o botão de mudo falhe.
pactl load-module module-null-sink sink_name=silence sink_properties=device.description=Silence >/dev/null
pactl set-default-sink silence
pactl set-default-source silence.monitor

# Display virtual pro Chromium headed.
export DISPLAY="${DISPLAY:-:99}"
rm -f "/tmp/.X${DISPLAY#:}-lock"
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &

exec node dist/index.js
