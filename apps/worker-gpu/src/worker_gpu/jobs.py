"""Fila serial de jobs de transcrição (passe final, uploads e Modo Agente)."""

from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import SAMPLE_RATE, load_file, validate_path

log = logging.getLogger("worker.jobs")

MAX_JOBS = 20


@dataclass
class JobFile:
    path: Path
    channel: str
    diarize: bool


@dataclass
class Job:
    id: str
    files: list[JobFile]
    language: str
    prompt: str | None
    status: str = "queued"
    step: str | None = None
    progress: float = 0.0
    error: str | None = None
    result: dict | None = None
    created_at: float = field(default_factory=time.time)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "step": self.step,
            "progress": round(self.progress, 3),
            "error": self.error,
            "result": self.result,
        }


class JobManager:
    def __init__(self, engine, diarizer, loader: Callable[[Path], np.ndarray] = load_file):
        self.engine = engine
        self.diarizer = diarizer
        self.loader = loader
        self.jobs: dict[str, Job] = {}
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="jobs", daemon=True)
            self._thread.start()

    def submit(self, files: list[dict], language: str, prompt: str | None) -> Job:
        if not files:
            raise ValueError("nenhum arquivo informado")
        parsed = [
            JobFile(validate_path(f["path"]), str(f.get("channel") or "mixed"), bool(f.get("diarize")))
            for f in files
        ]
        job = Job(id=uuid.uuid4().hex, files=parsed, language=language, prompt=prompt)
        with self._lock:
            self.jobs[job.id] = job
            self._evict()
        self._queue.put(job.id)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self.jobs.get(job_id)

    def _evict(self) -> None:
        finished = sorted(
            (j for j in self.jobs.values() if j.status in ("done", "error")), key=lambda j: j.created_at
        )
        while len(self.jobs) > MAX_JOBS and finished:
            self.jobs.pop(finished.pop(0).id, None)

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if job is None:
                continue
            try:
                self.run(job)
            except Exception as err:  # noqa: BLE001
                log.exception("job %s falhou", job.id)
                job.status = "error"
                job.error = str(err)

    def run(self, job: Job) -> None:
        job.status = "running"
        started = time.monotonic()
        total = len(job.files)
        channels = []
        for index, f in enumerate(job.files):
            def progress(p: float, base=index):
                job.progress = (base + p * 0.9) / total

            job.step = "transcrevendo"
            audio = self.loader(f.path)
            duration = len(audio) / SAMPLE_RATE
            want_diarize = f.diarize and self.diarizer.available()
            segments = self.engine.transcribe_file(
                audio, job.language, job.prompt, word_timestamps=want_diarize, progress=progress
            )
            diarized = False
            if want_diarize and segments:
                job.step = "diarizando"
                from .diarize import assign_speakers

                try:
                    turns = self.diarizer.run(audio)
                    segments = assign_speakers(segments, turns)
                    diarized = True
                except Exception as err:  # noqa: BLE001 — sem diarização, mantém a transcrição
                    log.warning("diarização falhou (%s); seguindo sem falantes", err)
            channels.append(
                {
                    "channel": f.channel,
                    "duration": round(duration, 3),
                    "diarized": diarized,
                    "segments": [s.to_json() for s in segments],
                }
            )
            job.progress = (index + 1) / total
            del audio
        job.result = {"channels": channels}
        job.status = "done"
        job.step = None
        job.progress = 1.0
        log.info("job %s concluído em %.1fs", job.id, time.monotonic() - started)
