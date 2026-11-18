"""Agenda dos alertas (T-15, T-5, T-1 e aviso de reunião sem link) — lógica pura, sem efeitos de desktop."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("host_agent.alerts")

# Alerta atrasado mais que isso (ex.: máquina suspensa) não é mais emitido.
LATE_TOLERANCE = timedelta(seconds=60)


@dataclass(frozen=True)
class Meeting:
    id: str
    title: str
    start: datetime
    end: datetime
    url: str | None
    skip_recording: bool
    status: str
    # Dia sem agenda (WORKING_DAYS no backend) e sem pedido do usuário: nenhum lembrete.
    no_alerts: bool = False

    @classmethod
    def from_api(cls, data: dict) -> "Meeting":
        return cls(
            id=data["id"],
            title=data["title"],
            start=datetime.fromisoformat(data["start"].replace("Z", "+00:00")),
            end=datetime.fromisoformat(data["end"].replace("Z", "+00:00")),
            url=data.get("url"),
            skip_recording=bool(data.get("skipRecording")),
            status=data.get("status", "scheduled"),
            no_alerts=bool(data.get("noAlerts")),
        )


@dataclass(frozen=True)
class Alert:
    meeting: Meeting
    minutes: int
    key: str
    final: bool
    # Aviso de reunião sem link (não é o lembrete de horário): só informa, sem ações.
    no_link: bool = False

    @property
    def offer_join(self) -> bool:
        return bool(self.meeting.url)

    @property
    def offer_skip(self) -> bool:
        return not self.meeting.skip_recording and self.meeting.status == "scheduled"


class AlertScheduler:
    def __init__(self, state_file: Path, minutes_before: list[int], no_link_minutes: int = 0):
        self.state_file = Path(state_file)
        self.minutes_before = sorted(set(minutes_before), reverse=True)
        # Minutos antes do início em que a reunião sem link é avisada; 0 desliga.
        self.no_link_minutes = no_link_minutes
        self.fired: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        try:
            data = json.loads(self.state_file.read_text())
            return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.fired))
        os.replace(tmp, self.state_file)

    @staticmethod
    def key(meeting: Meeting, minutes: int) -> str:
        # O horário entra na chave: reunião remarcada volta a alertar.
        return f"{meeting.id}:{minutes}:{meeting.start.isoformat()}"

    def due(self, now: datetime, meetings: list[Meeting]) -> list[Alert]:
        alerts: list[Alert] = []
        smallest = min(self.minutes_before) if self.minutes_before else 0
        for m in meetings:
            if m.status not in ("scheduled", "skipped") or m.no_alerts:
                continue
            # Só o alerta mais recente cujo horário já chegou; os anteriores ficam para trás.
            for minutes in sorted(self.minutes_before):
                at = m.start - timedelta(minutes=minutes)
                if now < at:
                    continue
                key = self.key(m, minutes)
                if key not in self.fired and now - at <= LATE_TOLERANCE:
                    alerts.append(Alert(m, minutes, key, final=minutes == smallest))
                break
        return alerts

    @staticmethod
    def no_link_key(meeting: Meeting) -> str:
        # O horário entra na chave: reunião remarcada sem link volta a avisar.
        return f"nolink:{meeting.id}:{meeting.start.isoformat()}"

    def due_no_link(self, now: datetime, meetings: list[Meeting]) -> list[Alert]:
        """Reuniões a gravar, sem link, que começam em até `no_link_minutes`: um aviso por reunião e horário.

        Vale até o início (não só no instante exato): reunião que chega sem link já perto do horário também avisa.
        """
        if self.no_link_minutes <= 0:
            return []
        window = timedelta(minutes=self.no_link_minutes)
        alerts: list[Alert] = []
        for m in meetings:
            if m.status != "scheduled" or m.skip_recording or m.no_alerts or m.url:
                continue
            key = self.no_link_key(m)
            if key not in self.fired and m.start - window <= now < m.start:
                alerts.append(Alert(m, self.no_link_minutes, key, final=False, no_link=True))
        return alerts

    def mark(self, alert: Alert) -> None:
        self.fired[alert.key] = alert.meeting.end.isoformat()
        self._save()

    def prune(self, now: datetime) -> None:
        cutoff = now - timedelta(days=1)
        kept = {}
        for k, end in self.fired.items():
            try:
                if datetime.fromisoformat(end) >= cutoff:
                    kept[k] = end
            except ValueError:
                continue
        if kept != self.fired:
            self.fired = kept
            self._save()
