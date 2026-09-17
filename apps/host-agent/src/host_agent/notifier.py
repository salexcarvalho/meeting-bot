"""Alertas no desktop: notify-send (T-15/T-5), zenity modal + som em loop (T-1)."""

from __future__ import annotations

import asyncio
import logging
import shutil

from .alerts import Alert

log = logging.getLogger("host_agent.notifier")

APP_NAME = "Agente de Reuniões"
ICON = "x-office-calendar"


def _has(cmd: str) -> bool:
    return shutil.which(cmd) is not None


async def play_sound(event_id: str = "message-new-instant") -> None:
    if not _has("canberra-gtk-play"):
        return
    proc = await asyncio.create_subprocess_exec(
        "canberra-gtk-play", "-i", event_id, "-d", APP_NAME,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


class SoundLoop:
    """Toca o som repetidamente até ser parado (alerta difícil de ignorar)."""

    def __init__(self, event_id: str = "alarm-clock-elapsed", every: float = 3.0):
        self.event_id = event_id
        self.every = every
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            await play_sound(self.event_id)
            await asyncio.sleep(self.every)

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None


def _when(alert: Alert) -> str:
    return alert.meeting.start.astimezone().strftime("%H:%M")


class Notifier:
    def __init__(self) -> None:
        self._open: dict[str, asyncio.subprocess.Process] = {}
        self._ids: dict[str, str] = {}

    async def info(self, title: str, body: str = "", urgency: str = "normal") -> None:
        if not _has("notify-send"):
            log.info("%s — %s", title, body)
            return
        proc = await asyncio.create_subprocess_exec(
            "notify-send", "--app-name", APP_NAME, "--icon", ICON, "--urgency", urgency, title, body,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()

    async def notify(self, alert: Alert) -> str | None:
        """Notificação persistente com ações. Retorna 'entrar', 'nao_gravar' ou None."""
        m = alert.meeting
        if not _has("notify-send"):
            log.warning("notify-send não encontrado; alerta: %s em %s min", m.title, alert.minutes)
            return None
        args = [
            "notify-send", "--app-name", APP_NAME, "--icon", ICON, "--urgency", "critical",
            "--print-id", "--hint", "string:sound-name:message-new-instant",
        ]
        previous = self._ids.get(m.id)
        if previous:
            args += ["--replace-id", previous]
            old = self._open.pop(m.id, None)
            if old and old.returncode is None:
                old.kill()
        if alert.offer_join:
            args += ["--action", "entrar=Entrar"]
        if alert.offer_skip:
            args += ["--action", "nao_gravar=Não gravar"]
        if not (alert.offer_join or alert.offer_skip):
            args += ["--wait"]
        body = f"Começa às {_when(alert)}."
        if not alert.meeting.url:
            body += " Sem link de reunião online."
        if alert.meeting.skip_recording:
            body += " Não será gravada."
        args += [f"Reunião em {alert.minutes} min: {m.title}", body]

        asyncio.create_task(play_sound())
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        self._open[m.id] = proc
        action = None
        assert proc.stdout is not None
        first = await proc.stdout.readline()
        if first.strip().isdigit():
            self._ids[m.id] = first.strip().decode()
        else:
            action = first.strip().decode() or None
        if action is None:
            rest = await proc.stdout.read()
            action = rest.decode().strip().splitlines()[-1] if rest.strip() else None
        await proc.wait()
        if self._open.get(m.id) is proc:
            self._open.pop(m.id, None)
        return action if action in ("entrar", "nao_gravar") else None

    async def modal(self, alert: Alert) -> str | None:
        """Diálogo modal com som em loop até a resposta (alerta final)."""
        m = alert.meeting
        # Fecha a notificação anterior dessa reunião, se ainda aberta.
        old = self._open.pop(m.id, None)
        if old and old.returncode is None:
            old.kill()
        if not _has("zenity"):
            return await self.notify(alert)
        text = f"<b>{_escape(m.title)}</b>\nComeça às {_when(alert)}."
        if not m.url:
            text += "\nSem link de reunião online."
        args = [
            "zenity", "--question", "--modal", "--width=440", "--timeout=180",
            f"--title=Reunião em {alert.minutes} minuto{'s' if alert.minutes != 1 else ''}",
            f"--text={text}", "--icon=x-office-calendar",
            f"--ok-label={'Entrar' if alert.offer_join else 'Ok'}",
            "--cancel-label=Fechar",
        ]
        if alert.offer_skip:
            args.append("--extra-button=Não gravar")
        sound = SoundLoop()
        sound.start()
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
            out, _ = await proc.communicate()
        finally:
            sound.stop()
        answer = out.decode().strip()
        if proc.returncode == 0 and alert.offer_join:
            return "entrar"
        if answer == "Não gravar":
            return "nao_gravar"
        return None


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
