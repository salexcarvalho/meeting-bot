#!/usr/bin/env bash
# Gera um convite .ics no estilo Outlook/Teams começando daqui a N minutos.
# Uso: scripts/fixture-ics.sh <minutos> [duração-em-minutos] [arquivo-de-saída]
set -euo pipefail

minutes="${1:?informe em quantos minutos a reunião começa}"
duration="${2:-30}"
out="${3:-specs/001-agente-reunioes-mvp/fixtures/convite-teams.ics}"

if ! [[ "$minutes" =~ ^[0-9]+$ && "$duration" =~ ^[0-9]+$ ]]; then
  echo "minutos e duração devem ser inteiros" >&2
  exit 1
fi

fmt() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }
now=$(date -u +%s)
start=$(( (now / 60 + minutes) * 60 ))
end=$(( start + duration * 60 ))
uid="fixture-$(date -u -d "@$start" +%Y%m%d%H%M)@agente-reunioes.local"
meeting_id=$(( start % 1000000000 ))

mkdir -p "$(dirname "$out")"
{
  printf 'BEGIN:VCALENDAR\r\n'
  printf 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN\r\n'
  printf 'VERSION:2.0\r\n'
  printf 'METHOD:REQUEST\r\n'
  printf 'BEGIN:VEVENT\r\n'
  printf 'UID:%s\r\n' "$uid"
  printf 'SEQUENCE:0\r\n'
  printf 'DTSTAMP:%s\r\n' "$(fmt "$now")"
  printf 'DTSTART:%s\r\n' "$(fmt "$start")"
  printf 'DTEND:%s\r\n' "$(fmt "$end")"
  printf 'SUMMARY:Portal SES - Alinhamento de arquitetura (teste)\r\n'
  printf 'ORGANIZER;CN="Organizador Teste":mailto:organizador@example.com\r\n'
  printf 'ATTENDEE;CN="Pessoa Um";ROLE=REQ-PARTICIPANT:mailto:pessoa.um@example.com\r\n'
  printf 'ATTENDEE;CN="Pessoa Dois";ROLE=OPT-PARTICIPANT:mailto:pessoa.dois@example.com\r\n'
  printf 'LOCATION:Reunião do Microsoft Teams\r\n'
  printf 'DESCRIPTION:Convite gerado para teste local.\\n\\nReunião do Microsoft Teams\\nIngressar: https://teams.microsoft.com/l/meetup-join/19%%3ameeting_fixture%s%%40thread.v2/0\r\n' "$meeting_id"
  printf 'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%%3ameeting_fixture%s%%40thread.v2/0\r\n' "$meeting_id"
  printf 'STATUS:CONFIRMED\r\n'
  printf 'END:VEVENT\r\n'
  printf 'END:VCALENDAR\r\n'
} > "$out"

echo "Convite gerado: $out (início $(date -d "@$start" '+%H:%M'), ${duration} min)"
