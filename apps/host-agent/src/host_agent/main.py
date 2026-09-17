"""Laço principal do host-agent: heartbeat, alertas e captura dirigida pelo backend."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import __version__
from .alerts import Alert, AlertScheduler, Meeting
from .api import BackendApi
from .capture import Recorder
from .config import Config, load_config
from .notifier import Notifier
from .opener import open_url
from .uploader import ChannelUploader, ws_base_from

log = logging.getLogger("host_agent")

HEARTBEAT_SECONDS = 5
SPOOL_MAX_AGE = timedelta(days=7)


class ActiveRecording:
    def __init__(self, cfg: Config, meeting_id: str, title: str, origin: float):
        self.meeting_id = meeting_id
        self.title = title
        self.recorder = Recorder(meeting_id, cfg.spool_dir, origin)
        ws = ws_base_from(cfg.backend_url)
        self.uploaders = [
            ChannelUploader(
                ws, cfg.agent_token, meeting_id, ch, self.recorder.dir / f"{ch}.pcm",
                capture_done=lambda c=cap: c.finished,
            )
            for ch, cap in self.recorder.captures.items()
        ]
        self.tasks: list[asyncio.Task] = []

    def start(self) -> None:
        self.recorder.start()
        self.tasks = [asyncio.create_task(u.run()) for u in self.uploaders]

    async def stop(self) -> None:
        await asyncio.to_thread(self.recorder.stop)
        results = await asyncio.gather(*self.tasks, return_exceptions=True)
        if all(r is True for r in results):
            shutil.rmtree(self.recorder.dir, ignore_errors=True)
            log.info("gravação %s enviada por completo; spool removido", self.meeting_id[:8])
        else:
            log.warning("gravação %s: envio incompleto (%s); spool mantido", self.meeting_id[:8], results)


class HostAgent:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.api = BackendApi(cfg.backend_url, cfg.agent_token)
        self.notifier = Notifier()
        self.scheduler = AlertScheduler(cfg.state_dir / "alerts.json", [15, 5, 1])
        self.meetings: list[Meeting] = self._load_cached_meetings()
        self.recording: ActiveRecording | None = None
        self._converging = asyncio.Lock()
        self._stopping = asyncio.Event()
        self._conflict_notified: set[str] = set()
        self._background: set[asyncio.Task] = set()

    # ---------- cache da agenda (alertas funcionam com o backend fora) ----------

    @property
    def _cache_file(self) -> Path:
        return self.cfg.state_dir / "meetings.json"

    def _load_cached_meetings(self) -> list[Meeting]:
        try:
            return [Meeting.from_api(m) for m in json.loads(self._cache_file.read_text())]
        except (OSError, ValueError, KeyError):
            return []

    def _save_cached_meetings(self, raw: list[dict]) -> None:
        self.cfg.state_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file.write_text(json.dumps(raw))

    # ---------- laços ----------

    async def heartbeat_loop(self) -> None:
        while not self._stopping.is_set():
            capture = self.recording.recorder.status() if self.recording else None
            resp = await self.api.heartbeat(capture)
            if resp is not None:
                raw = resp.get("meetings", [])
                self.meetings = [Meeting.from_api(m) for m in raw]
                self._save_cached_meetings(raw)
                if resp.get("alerts", {}).get("minutesBefore"):
                    self.scheduler.minutes_before = sorted(set(resp["alerts"]["minutesBefore"]), reverse=True)
                await self.converge(resp.get("recording"))
                self._check_conflicts()
            try:
                await asyncio.wait_for(self._stopping.wait(), HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def alert_loop(self) -> None:
        last_prune = 0.0
        while not self._stopping.is_set():
            now = datetime.now(timezone.utc)
            for alert in self.scheduler.due(now, self.meetings):
                self.scheduler.mark(alert)
                asyncio.create_task(self.handle_alert(alert))
            if time.monotonic() - last_prune > 3600:
                self.scheduler.prune(now)
                last_prune = time.monotonic()
            try:
                await asyncio.wait_for(self._stopping.wait(), 1)
            except asyncio.TimeoutError:
                pass

    async def handle_alert(self, alert: Alert) -> None:
        log.info("alerta T-%d: %s", alert.minutes, alert.meeting.title)
        try:
            action = await (self.notifier.modal(alert) if alert.final else self.notifier.notify(alert))
        except Exception:  # noqa: BLE001
            log.exception("falha ao exibir alerta")
            return
        if action == "entrar" and alert.meeting.url:
            open_url(alert.meeting.url)
        elif action == "nao_gravar":
            if await self.api.skip(alert.meeting.id):
                await self.notifier.info("Reunião não será gravada", alert.meeting.title)
            else:
                await self.notifier.info("Não foi possível marcar 'Não gravar'", "Use a tela Hoje.", "critical")

    # ---------- gravação ----------

    async def converge(self, desired: dict | None) -> None:
        async with self._converging:
            current = self.recording
            wanted_id = desired["meetingId"] if desired else None
            if current and current.meeting_id != wanted_id:
                log.info("parando gravação %s", current.meeting_id[:8])
                self.recording = None
                # Em segundo plano: o envio do restante não pode travar o heartbeat.
                self._background.add(asyncio.create_task(self._finish(current)))
            if desired and self.recording is None:
                started = desired.get("startedAt")
                origin = (
                    datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp() if started else time.time()
                )
                rec = ActiveRecording(self.cfg, desired["meetingId"], desired.get("title", ""), origin)
                log.info("iniciando gravação %s (%s)", rec.meeting_id[:8], rec.title)
                self.recording = rec
                rec.start()
                await self.notifier.info("Gravando reunião", f"{rec.title}\nMicrofone e áudio da reunião.")

    async def _finish(self, rec: ActiveRecording) -> None:
        try:
            await rec.stop()
            await self.notifier.info("Gravação encerrada", rec.title)
        finally:
            self._background.discard(asyncio.current_task())

    def _check_conflicts(self) -> None:
        now = datetime.now(timezone.utc)
        if not self.recording:
            return
        for m in self.meetings:
            if (
                m.id != self.recording.meeting_id
                and m.status == "scheduled"
                and m.start <= now < m.end
                and m.id not in self._conflict_notified
            ):
                self._conflict_notified.add(m.id)
                asyncio.create_task(
                    self.notifier.info(
                        "Conflito de reuniões",
                        f"“{m.title}” começou, mas “{self.recording.title}” ainda está sendo gravada.",
                        "critical",
                    )
                )

    async def resume_pending_spools(self) -> None:
        """Reenvia spools que ficaram de uma execução anterior."""
        if not self.cfg.spool_dir.exists():
            return
        ws = ws_base_from(self.cfg.backend_url)
        for folder in self.cfg.spool_dir.iterdir():
            if not folder.is_dir():
                continue
            age = datetime.now(timezone.utc) - datetime.fromtimestamp(folder.stat().st_mtime, timezone.utc)
            if age > SPOOL_MAX_AGE:
                shutil.rmtree(folder, ignore_errors=True)
                continue
            meeting_id = folder.name
            if self.recording and self.recording.meeting_id == meeting_id:
                continue
            results = []
            for pcm in folder.glob("*.pcm"):
                u = ChannelUploader(ws, self.cfg.agent_token, meeting_id, pcm.stem, pcm, capture_done=lambda: True)
                results.append(await u.run())
            if results and all(results):
                shutil.rmtree(folder, ignore_errors=True)
                log.info("spool pendente de %s reenviado", meeting_id[:8])

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._stopping.set)
        log.info("host-agent %s iniciado (backend %s)", __version__, self.cfg.backend_url)
        # A gravação desejada vem no primeiro heartbeat; só depois retoma spools antigos.
        tasks = [asyncio.create_task(self.heartbeat_loop()), asyncio.create_task(self.alert_loop())]
        await asyncio.sleep(HEARTBEAT_SECONDS + 1)
        asyncio.create_task(self.resume_pending_spools())
        await self._stopping.wait()
        log.info("encerrando host-agent")
        for t in tasks:
            t.cancel()
        if self.recording:
            # Mantém o spool: ao voltar, o envio é retomado.
            await asyncio.to_thread(self.recording.recorder.stop)
        await self.api.close()


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    asyncio.run(HostAgent(cfg).run())


if __name__ == "__main__":
    run()
