"""Captura do microfone e do áudio remoto (PipeWire via parec) para o spool local.

Cada canal grava PCM s16le 16 kHz mono. O byte k do arquivo corresponde a k/32000 s
depois do início da gravação (relógio de parede): lacunas (troca de dispositivo,
parec reiniciando, fonte suspensa) viram zeros, e os dois canais ficam alinhados.
"""

from __future__ import annotations

import logging
import os
import select
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

log = logging.getLogger("host_agent.capture")

BYTES_PER_SECOND = 32000
# Atraso maior que isso sem dados = lacuna; preenche com silêncio.
GAP_THRESHOLD_BYTES = BYTES_PER_SECOND
MAX_PAD_BYTES = BYTES_PER_SECOND * 3600 * 5
DEVICE_CHECK_SECONDS = 3.0
MAX_FAILURES = 5

DEVICE_ALIAS = {"mic": "@DEFAULT_SOURCE@", "remote": "@DEFAULT_MONITOR@"}


class Process(Protocol):
    stdout: object

    def poll(self) -> int | None: ...
    def kill(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...


def spawn_parec(channel: str) -> subprocess.Popen:
    return subprocess.Popen(
        [
            "parec", "--raw", "--format=s16le", "--rate=16000", "--channels=1",
            "--latency-msec=100", f"--device={DEVICE_ALIAS[channel]}",
            "--client-name=agente-reunioes", f"--stream-name={channel}",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )


def default_device(channel: str) -> str | None:
    cmd = ["pactl", "get-default-source"] if channel == "mic" else ["pactl", "get-default-sink"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not out:
        return None
    return out if channel == "mic" else f"{out}.monitor"


@dataclass
class ChannelCapture:
    channel: str
    spool_path: Path
    origin: float
    spawn: Callable[[str], Process] = spawn_parec
    device_fn: Callable[[str], str | None] = default_device
    clock: Callable[[], float] = time.time

    state: str = "restarting"
    device: str | None = None
    written: int = 0
    failures: int = 0
    finished: bool = False
    _file: object = field(default=None, repr=False)
    _proc: Process | None = field(default=None, repr=False)
    _next_try: float = 0.0
    _last_device_check: float = 0.0
    _started_at: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ---------- arquivo ----------

    def open(self) -> None:
        self.spool_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.spool_path, "ab")
        size = self._file.tell()
        if size % 2:
            self._file.write(b"\x00")
            size += 1
        self.written = size

    def write(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._file.write(data)
            self._file.flush()
            self.written += len(data)

    def pad_to(self, now: float, threshold: int = GAP_THRESHOLD_BYTES) -> int:
        expected = int(max(0.0, now - self.origin) * BYTES_PER_SECOND) & ~1
        gap = min(expected - self.written, MAX_PAD_BYTES)
        if gap < threshold:
            return 0
        remaining = gap
        block = b"\x00" * (BYTES_PER_SECOND * 10)
        while remaining > 0:
            n = min(remaining, len(block))
            self.write(block[:n])
            remaining -= n
        return gap

    def close(self) -> None:
        with self._lock:
            if self._file:
                self._file.flush()
                os.fsync(self._file.fileno())
                self._file.close()
                self._file = None

    # ---------- processo ----------

    def _start_process(self, now: float) -> None:
        self.device = self.device_fn(self.channel)
        self._last_device_check = now
        try:
            self._proc = self.spawn(self.channel)
            self._started_at = now
            self.state = "recording"
            log.info("[%s] capturando de %s", self.channel, self.device or DEVICE_ALIAS[self.channel])
        except OSError as err:
            self._proc = None
            self._register_failure(now, f"não foi possível iniciar o parec: {err}")

    def _register_failure(self, now: float, reason: str) -> None:
        self.failures += 1
        self.state = "unavailable" if self.failures >= MAX_FAILURES else "restarting"
        delay = min(15.0, 2 ** min(self.failures - 1, 4))
        self._next_try = now + delay
        log.warning("[%s] %s (falha %d, nova tentativa em %.0fs)", self.channel, reason, self.failures, delay)

    def _stop_process(self) -> None:
        proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                pass

    def tick(self, now: float) -> None:
        """Supervisiona o processo: reinicia se morreu ou se o dispositivo padrão mudou."""
        if self._proc is not None and self._proc.poll() is not None:
            ran = now - self._started_at
            self._proc = None
            if ran > 10:
                self.failures = 0
            self._register_failure(now, "parec encerrou")
        if self._proc is None:
            self.pad_to(now)
            if now >= self._next_try:
                self._start_process(now)
            return
        if now - self._last_device_check >= DEVICE_CHECK_SECONDS:
            self._last_device_check = now
            current = self.device_fn(self.channel)
            if current and current != self.device:
                log.info("[%s] dispositivo mudou: %s → %s", self.channel, self.device, current)
                self._stop_process()
                self.state = "restarting"
                self._next_try = now
                self.pad_to(now, threshold=2)
                self._start_process(now)
        # Fonte que para de entregar dados (suspensa) não pode atrasar a linha do tempo.
        self.pad_to(now)

    def read_available(self, timeout: float = 0.2) -> bytes:
        proc = self._proc
        if proc is None or proc.stdout is None:
            time.sleep(timeout)
            return b""
        fd = proc.stdout.fileno()
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            return b""
        try:
            return os.read(fd, 16000)
        except OSError:
            return b""

    # ---------- laço ----------

    def run(self, stop: threading.Event) -> None:
        self.open()
        pending = b""
        try:
            while not stop.is_set():
                self.tick(self.clock())
                data = pending + self.read_available()
                usable = len(data) & ~1
                pending = data[usable:]
                if usable:
                    self.write(data[:usable])
                    if self.failures and self.clock() - self._started_at > 10:
                        self.failures = 0
            self._stop_process()
            self.pad_to(self.clock(), threshold=2)
        finally:
            self.close()
            self.finished = True

    def status(self) -> dict:
        return {"state": self.state, "device": self.device, "bytes": self.written}


class Recorder:
    """Grava os dois canais de uma reunião em threads separadas."""

    def __init__(self, meeting_id: str, spool_dir: Path, origin: float, **capture_kwargs):
        self.meeting_id = meeting_id
        self.dir = spool_dir / meeting_id
        self.captures = {
            ch: ChannelCapture(ch, self.dir / f"{ch}.pcm", origin, **capture_kwargs) for ch in ("mic", "remote")
        }
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "meeting").write_text(self.meeting_id)
        for ch, cap in self.captures.items():
            t = threading.Thread(target=cap.run, args=(self._stop,), name=f"capture-{ch}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout)

    @property
    def stopped(self) -> bool:
        return self._stop.is_set() and all(c.finished for c in self.captures.values())

    def status(self) -> dict:
        return {"meetingId": self.meeting_id, "channels": {ch: c.status() for ch, c in self.captures.items()}}
