"""Envio do spool ao backend por WebSocket, retomando do offset confirmado (contracts/ws-audio.md)."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Callable

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

log = logging.getLogger("host_agent.uploader")

MAX_FRAME = 64 * 1024
BACKOFF = [1, 2, 5, 10]

CLOSE_REPLACED = 4001
CLOSE_NOT_FOUND = 4404
CLOSE_NOT_RECORDING = 4409
FATAL_CLOSES = {CLOSE_REPLACED, CLOSE_NOT_FOUND, CLOSE_NOT_RECORDING}


class UploadRejected(Exception):
    """O backend não aceita mais áudio desta reunião/canal."""


class ChannelUploader:
    def __init__(
        self,
        ws_base: str,
        token: str,
        meeting_id: str,
        channel: str,
        spool_path: Path,
        capture_done: Callable[[], bool],
        poll_interval: float = 0.1,
    ):
        self.url = f"{ws_base}/api/agent/audio?meeting={meeting_id}&channel={channel}"
        self.token = token
        self.meeting_id = meeting_id
        self.channel = channel
        self.spool_path = spool_path
        self.capture_done = capture_done
        self.poll_interval = poll_interval
        self.acked = 0
        self.sent = 0
        self.completed = False
        self.rejected = False

    async def run(self) -> bool:
        """Envia até o fim. True = backend confirmou tudo; False = recusado."""
        attempt = 0
        while True:
            try:
                await self._session()
                self.completed = True
                return True
            except UploadRejected as err:
                log.info("[%s/%s] envio encerrado: %s", self.meeting_id[:8], self.channel, err)
                self.rejected = True
                return False
            except (OSError, ConnectionClosed, InvalidStatus, asyncio.TimeoutError, ValueError) as err:
                code = getattr(getattr(err, "rcvd", None), "code", None)
                if code in FATAL_CLOSES:
                    self.rejected = True
                    log.info("[%s/%s] backend encerrou o envio (%s)", self.meeting_id[:8], self.channel, code)
                    return False
                status = getattr(getattr(err, "response", None), "status_code", None)
                if status == 401:
                    log.error("[%s] AGENT_TOKEN recusado no envio de áudio", self.channel)
                delay = BACKOFF[min(attempt, len(BACKOFF) - 1)]
                attempt += 1
                log.warning("[%s/%s] conexão perdida (%s); nova tentativa em %ss",
                            self.meeting_id[:8], self.channel, err, delay)
                await asyncio.sleep(delay)

    async def _session(self) -> None:
        async with connect(
            self.url,
            additional_headers={"Authorization": f"Bearer {self.token}"},
            max_size=64 * 1024,
            open_timeout=10,
            ping_interval=20,
        ) as ws:
            ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if ready.get("type") != "ready":
                raise ValueError(f"resposta inesperada: {ready}")
            offset = int(ready["offset"])
            self.acked = offset
            ended = asyncio.get_running_loop().create_future()

            async def reader() -> None:
                try:
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            continue
                        msg = json.loads(raw)
                        if msg.get("type") == "ack":
                            self.acked = int(msg["offset"])
                        elif msg.get("type") == "ended" and not ended.done():
                            ended.set_result(int(msg["offset"]))
                        elif msg.get("type") == "error" and not ended.done():
                            ended.set_exception(ValueError(f"backend: {msg.get('message')} (offset {msg.get('offset')})"))
                except ConnectionClosed as err:
                    if not ended.done():
                        ended.set_exception(err)

            reader_task = asyncio.create_task(reader())
            try:
                await self._send_from(ws, offset, ended)
                await asyncio.wait_for(ended, timeout=30)
            finally:
                reader_task.cancel()
            rcvd = ws.close_code
            if rcvd in FATAL_CLOSES:
                raise UploadRejected(f"código {rcvd}")

    async def _send_from(self, ws, offset: int, ended: asyncio.Future) -> None:
        with open(self.spool_path, "rb") as fh:
            fh.seek(offset)
            position = offset
            while True:
                if ended.done():
                    ended.result()  # propaga erro/fechamento
                    return
                data = fh.read(MAX_FRAME)
                usable = len(data) & ~1
                if usable < len(data):
                    fh.seek(position + usable)
                if usable:
                    await ws.send(data[:usable])
                    position += usable
                    self.sent = position
                    continue
                if self.capture_done():
                    size = self.spool_path.stat().st_size & ~1
                    if position >= size:
                        await ws.send(json.dumps({"type": "end", "total": position}))
                        return
                    continue
                await asyncio.sleep(self.poll_interval)


def ws_base_from(http_base: str) -> str:
    if http_base.startswith("https://"):
        return "wss://" + http_base[len("https://"):]
    if http_base.startswith("http://"):
        return "ws://" + http_base[len("http://"):]
    return http_base
