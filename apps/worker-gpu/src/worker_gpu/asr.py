"""Transcrição com faster-whisper (ao vivo por trecho e passe final por arquivo)."""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .audio import SAMPLE_RATE

log = logging.getLogger("worker.asr")

# Frases que o Whisper costuma "alucinar" em trechos de silêncio ou ruído.
HALLUCINATIONS = [
    re.compile(r"legendas? pela comunidade amara\.org", re.I),
    re.compile(r"^\s*(obrigad[oa] por assistir|inscreva-se no canal)[.!]?\s*$", re.I),
    re.compile(r"^\s*(legenda|legendas) (por|de)\b", re.I),
    re.compile(r"^\s*[.…]+\s*$"),
]


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class SegmentOut:
    start: float
    end: float
    text: str
    speaker: str | None = None
    words: list[Word] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"start": round(self.start, 3), "end": round(self.end, 3), "text": self.text, "speaker": self.speaker}


@dataclass
class ChunkResult:
    duration: float
    speech_seconds: float
    elapsed: float
    segments: list[SegmentOut]


def is_hallucination(text: str) -> bool:
    return not text or any(p.search(text) for p in HALLUCINATIONS)


def _clean(segments) -> list[SegmentOut]:
    out: list[SegmentOut] = []
    for s in segments:
        text = s.text.strip()
        if is_hallucination(text):
            continue
        # Trecho que o próprio modelo considera silêncio e com baixa confiança.
        if getattr(s, "no_speech_prob", 0) > 0.6 and getattr(s, "avg_logprob", 0) < -1.0:
            continue
        words = [Word(w.start, w.end, w.word) for w in (getattr(s, "words", None) or [])]
        out.append(SegmentOut(float(s.start), float(s.end), text, None, words))
    return out


class AsrEngine:
    """Um modelo carregado atende o ao vivo e o passe final.

    Inferências são serializadas; trechos ao vivo passam na frente dos jobs
    (o job cede entre lotes enquanto houver trecho esperando).
    """

    def __init__(self, model_name: str, device: str, compute_type: str, download_root: str | None):
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.download_root = download_root
        self.model = None
        self.batched = None
        self.error: str | None = None
        self._lock = threading.Lock()
        self._live_waiting = 0
        self._counter_lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        kwargs = dict(device=self.device, compute_type=self.compute_type, download_root=self.download_root)
        started = time.monotonic()
        try:
            # Depois do primeiro download, carrega sem acessar a rede (LOCAL_ONLY).
            model = WhisperModel(self.model_name, local_files_only=True, **kwargs)
        except Exception:  # noqa: BLE001
            log.info("modelo %s não está no cache; baixando", self.model_name)
            model = WhisperModel(self.model_name, **kwargs)
        self.batched = BatchedInferencePipeline(model=model)
        self.model = model
        log.info("modelo %s (%s/%s) pronto em %.1fs", self.model_name, self.device, self.compute_type,
                 time.monotonic() - started)

    def load_in_background(self) -> threading.Thread:
        def run():
            try:
                self.load()
            except Exception as err:  # noqa: BLE001
                self.error = str(err)
                log.exception("falha ao carregar o modelo")

        thread = threading.Thread(target=run, name="asr-load", daemon=True)
        thread.start()
        return thread

    # ---------- ao vivo ----------

    def speech_seconds(self, audio: np.ndarray) -> float:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        stamps = get_speech_timestamps(
            audio, VadOptions(min_silence_duration_ms=300, speech_pad_ms=100), sampling_rate=SAMPLE_RATE
        )
        return sum(s["end"] - s["start"] for s in stamps) / SAMPLE_RATE

    def transcribe_chunk(self, audio: np.ndarray, language: str, prompt: str | None) -> ChunkResult:
        from faster_whisper.vad import VadOptions

        started = time.monotonic()
        duration = len(audio) / SAMPLE_RATE
        with self._counter_lock:
            self._live_waiting += 1
        try:
            self._lock.acquire()
        finally:
            with self._counter_lock:
                self._live_waiting -= 1
        try:
            speech = self.speech_seconds(audio)
            if speech <= 0:
                return ChunkResult(duration, 0.0, time.monotonic() - started, [])
            segments, _info = self.model.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=True,
                vad_parameters=VadOptions(min_silence_duration_ms=500, speech_pad_ms=200),
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                initial_prompt=prompt or None,
            )
            result = _clean(list(segments))
        finally:
            self._lock.release()
        return ChunkResult(duration, speech, time.monotonic() - started, result)

    # ---------- passe final ----------

    def _yield_to_live(self) -> None:
        while self._live_waiting > 0:
            time.sleep(0.02)

    def transcribe_file(
        self,
        audio: np.ndarray,
        language: str,
        prompt: str | None,
        word_timestamps: bool,
        progress: Callable[[float], None] | None = None,
    ) -> list[SegmentOut]:
        duration = max(len(audio) / SAMPLE_RATE, 0.001)
        self._yield_to_live()
        with self._lock:
            segments, _info = self.batched.transcribe(
                audio,
                language=language,
                batch_size=8,
                beam_size=5,
                vad_filter=True,
                without_timestamps=False,
                word_timestamps=word_timestamps,
                initial_prompt=prompt or None,
            )
        iterator = iter(segments)
        raw = []
        while True:
            self._yield_to_live()
            with self._lock:
                try:
                    seg = next(iterator)
                except StopIteration:
                    break
            raw.append(seg)
            if progress:
                progress(min(seg.end / duration, 1.0))
        return _clean(raw)


def engine_from_env() -> AsrEngine:
    return AsrEngine(
        model_name=os.environ.get("ASR_MODEL", "large-v3-turbo"),
        device=os.environ.get("ASR_DEVICE", "cuda"),
        compute_type=os.environ.get("ASR_COMPUTE_TYPE", "int8_float16"),
        download_root=os.environ.get("WHISPER_CACHE") or None,
    )
