"""Laço principal do host-agent: heartbeat, alertas e captura dirigida pelo backend."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import signal
import sys
import time
from collections.abc import Awaitable, Callable, Coroutine
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TypeVar

from . import __version__
from .alerts import Alert, AlertScheduler, Meeting
from .api import BackendApi
from .capture import Recorder
from .config import Config, load_config
from .llm_runner import LlmRunner
from .notifier import Notifier
from .opener import open_url
from .uploader import ChannelUploader, ws_base_from

log = logging.getLogger("host_agent")
T = TypeVar("T")

HEARTBEAT_SECONDS = 5
LLM_POLL_SECONDS = 25
LLM_STATUS_SECONDS = 60
SPOOL_MAX_AGE = timedelta(days=7)
# Tetos de tempo: nada no ciclo do heartbeat pode travar o laço indefinidamente.
HEARTBEAT_CALL_TIMEOUT = 15
CONVERGE_TIMEOUT = 30
HEARTBEAT_STALE_FACTOR = 3
STALE_WARNING_EVERY = 60


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
        self.llm = LlmRunner(cfg.llm)
        self.exit_code = 0
        self._last_heartbeat_ok = time.monotonic()
        self._last_stale_warning = 0.0
        self._last_prune = 0.0

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

    async def _sleep(self, seconds: float) -> None:
        """Espera interrompível pelo encerramento."""
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stopping.wait(), seconds)

    async def _run_loop(self, name: str, step: Callable[[], Awaitable[None]], interval: float) -> None:
        """Repete `step`; falha de uma iteração é logada e o laço segue no próximo ciclo.

        Sem isto, uma exceção encerrava a task em silêncio (as tasks nunca são awaited,
        então o asyncio nem chegava a logar) e o laço morria com o processo vivo.
        CancelledError é BaseException: passa direto pelo `except Exception`.
        """
        while not self._stopping.is_set():
            try:
                await step()
                delay = interval
            except Exception:  # noqa: BLE001
                log.exception("falha numa iteração do laço %s; seguindo no próximo ciclo", name)
                delay = max(interval, HEARTBEAT_SECONDS)
            if delay > 0:
                await self._sleep(delay)

    async def _bounded(self, label: str, awaitable: Awaitable[T], timeout: float) -> T | None:
        """Await com teto de tempo: estourou, loga e devolve None em vez de travar o laço."""
        try:
            return await asyncio.wait_for(awaitable, timeout)
        except asyncio.TimeoutError:
            log.error("%s excedeu %.0f s e foi abandonado", label, timeout)
            return None

    def _spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> None:
        """Task avulsa: mantém referência e loga a exceção (antes ela se perdia)."""
        task = asyncio.create_task(coro, name=name)
        self._background.add(task)
        task.add_done_callback(self._on_background_done)

    def _on_background_done(self, task: asyncio.Task) -> None:
        self._background.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("tarefa %s falhou", task.get_name(), exc_info=task.exception())

    def _warn_if_heartbeat_stale(self) -> None:
        now = time.monotonic()
        age = now - self._last_heartbeat_ok
        if age <= HEARTBEAT_STALE_FACTOR * HEARTBEAT_SECONDS or now - self._last_stale_warning <= STALE_WARNING_EVERY:
            return
        self._last_stale_warning = now
        log.warning("último heartbeat bem-sucedido há %.0f s (backend fora ou laço travado)", age)

    async def heartbeat_loop(self) -> None:
        await self._run_loop("heartbeat", self._heartbeat_step, HEARTBEAT_SECONDS)

    async def _heartbeat_step(self) -> None:
        self._warn_if_heartbeat_stale()
        capture = self.recording.recorder.status() if self.recording else None
        resp = await self._bounded(
            "heartbeat", self.api.heartbeat(capture, self.llm.statuses(), self.cfg.mode), HEARTBEAT_CALL_TIMEOUT
        )
        if resp is None:
            return
        self._last_heartbeat_ok = time.monotonic()
        # No modo "llm" não há desktop: nada de alertas nem captura.
        if self.cfg.mode != "full":
            return
        raw = resp.get("meetings", [])
        self.meetings = [Meeting.from_api(m) for m in raw]
        self._save_cached_meetings(raw)
        alerts_cfg = resp.get("alerts", {})
        if alerts_cfg.get("minutesBefore"):
            self.scheduler.minutes_before = sorted(set(alerts_cfg["minutesBefore"]), reverse=True)
        if isinstance(alerts_cfg.get("noLinkMinutes"), int):
            self.scheduler.no_link_minutes = max(0, alerts_cfg["noLinkMinutes"])
        await self._bounded("converge", self.converge(resp.get("recording")), CONVERGE_TIMEOUT)
        self._check_conflicts()

    async def llm_status_loop(self) -> None:
        await self._run_loop("llm-status", self.llm.refresh, LLM_STATUS_SECONDS)

    async def llm_loop(self) -> None:
        """Executa, um por vez, os pedidos de geração com a assinatura (claude/codex)."""
        await self._run_loop("llm", self._llm_step, 0)

    async def _llm_step(self) -> None:
        try:
            job = await self.api.next_llm_job(LLM_POLL_SECONDS)
        except ConnectionError:
            await self._sleep(HEARTBEAT_SECONDS)
            return
        if not job:
            return
        try:
            log.info("gerando com %s (%s)", job.get("provider"), str(job.get("id", ""))[:8])
            result = await self.llm.run(job)
            await self.api.post_llm_result(str(job["id"]), result)
        except Exception:  # noqa: BLE001
            log.exception("falha ao atender pedido de geração")
            await self._sleep(HEARTBEAT_SECONDS)

    async def alert_loop(self) -> None:
        await self._run_loop("alertas", self._alert_step, 1)

    async def _alert_step(self) -> None:
        now = datetime.now(timezone.utc)
        due = [*self.scheduler.due(now, self.meetings), *self.scheduler.due_no_link(now, self.meetings)]
        for alert in due:
            self.scheduler.mark(alert)
            self._spawn(self.handle_alert(alert), "alerta")
        if time.monotonic() - self._last_prune > 3600:
            self.scheduler.prune(now)
            self._last_prune = time.monotonic()

    async def handle_alert(self, alert: Alert) -> None:
        if alert.no_link:
            log.info("aviso de reunião sem link (%d min): %s", alert.minutes, alert.meeting.title)
            try:
                await self.notifier.no_link(alert)
            except Exception:  # noqa: BLE001
                log.exception("falha ao exibir aviso de reunião sem link")
            return
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
                self._spawn(self._finish(current), "fim-gravacao")
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

    def _on_loop_done(self, task: asyncio.Task) -> None:
        """Supervisão: laço que termina fora do encerramento é falha grave.

        Em vez de recriar a task (o que esconderia um bug e manteria estado possivelmente
        corrompido), encerra com código != 0: o systemd (Restart=on-failure) reinicia limpo.
        """
        if task.cancelled() or (self._stopping.is_set() and task.exception() is None):
            return
        log.critical(
            "laço %s terminou inesperadamente; encerrando para o systemd reiniciar",
            task.get_name(), exc_info=task.exception(),
        )
        self.exit_code = 1
        self._stopping.set()

    async def _finish(self, rec: ActiveRecording) -> None:
        await rec.stop()
        await self.notifier.info("Gravação encerrada", rec.title)

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
                self._spawn(
                    self.notifier.info(
                        "Conflito de reuniões",
                        f"“{m.title}” começou, mas “{self.recording.title}” ainda está sendo gravada.",
                        "critical",
                    ),
                    "conflito",
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
        log.info("host-agent %s iniciado em modo %s (backend %s)", __version__, self.cfg.mode, self.cfg.backend_url)
        # A gravação desejada vem no primeiro heartbeat; só depois retoma spools antigos.
        loops = [("heartbeat", self.heartbeat_loop), ("llm-status", self.llm_status_loop), ("llm", self.llm_loop)]
        if self.cfg.mode == "full":
            loops.append(("alertas", self.alert_loop))
        tasks = [asyncio.create_task(fn(), name=name) for name, fn in loops]
        for t in tasks:
            t.add_done_callback(self._on_loop_done)
        if self.cfg.mode == "full":
            await self._sleep(HEARTBEAT_SECONDS + 1)
            if not self._stopping.is_set():
                self._spawn(self.resume_pending_spools(), "spools-pendentes")
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
    agent = HostAgent(cfg)
    asyncio.run(agent.run())
    if agent.exit_code:
        sys.exit(agent.exit_code)


if __name__ == "__main__":
    run()
