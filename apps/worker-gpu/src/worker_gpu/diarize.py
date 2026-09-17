"""Separação de falantes com pyannote (speaker-diarization-community-1), só no passe final."""

from __future__ import annotations

import gc
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .asr import SegmentOut, Word
from .audio import SAMPLE_RATE

log = logging.getLogger("worker.diarize")

PIPELINE_ID = "pyannote/speaker-diarization-community-1"


@dataclass
class Turn:
    start: float
    end: float
    speaker: str


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _best_speaker(start: float, end: float, turns: list[Turn]) -> str | None:
    scores: dict[str, float] = {}
    for t in turns:
        if t.end <= start or t.start >= end:
            continue
        scores[t.speaker] = scores.get(t.speaker, 0.0) + _overlap(start, end, t.start, t.end)
    if scores:
        return max(scores.items(), key=lambda kv: kv[1])[0]
    # Sem sobreposição (ex.: palavra curta entre turnos): turno mais próximo em até 1 s.
    mid = (start + end) / 2
    nearest = min(turns, key=lambda t: min(abs(t.start - mid), abs(t.end - mid)), default=None)
    if nearest and min(abs(nearest.start - mid), abs(nearest.end - mid)) <= 1.0:
        return nearest.speaker
    return None


def assign_speakers(segments: list[SegmentOut], turns: list[Turn]) -> list[SegmentOut]:
    """Rotula os segmentos pelos turnos da diarização.

    Com timestamps por palavra, um segmento é quebrado onde o falante muda.
    Os rótulos viram "Speaker N" na ordem da primeira fala.
    """
    if not turns:
        return segments
    out: list[SegmentOut] = []
    for seg in segments:
        if not seg.words:
            out.append(SegmentOut(seg.start, seg.end, seg.text, _best_speaker(seg.start, seg.end, turns)))
            continue
        current: SegmentOut | None = None
        for w in seg.words:
            spk = _best_speaker(w.start, w.end, turns)
            if current is not None and (spk == current.speaker or spk is None):
                current.end = w.end
                current.words.append(w)
                continue
            if current is not None:
                out.append(current)
            current = SegmentOut(w.start, w.end, "", spk, [w])
        if current is not None:
            out.append(current)
    for s in out:
        if s.words:
            s.text = "".join(w.text for w in s.words).strip()
    out = [s for s in out if s.text]

    names: dict[str, str] = {}
    for s in out:
        if s.speaker is None:
            continue
        if s.speaker not in names:
            names[s.speaker] = f"Speaker {len(names) + 1}"
        s.speaker = names[s.speaker]
    return out


def _cached(hf_home: Path) -> bool:
    repo = hf_home / "hub" / f"models--{PIPELINE_ID.replace('/', '--')}" / "snapshots"
    return repo.is_dir() and any(repo.iterdir())


class Diarizer:
    def __init__(self, token: str | None, hf_home: str, device: str):
        self.token = token or None
        self.hf_home = Path(hf_home)
        self.device = device
        self.last_error: str | None = None
        self._lock = threading.Lock()

    def status(self) -> tuple[str, str | None]:
        if not self.token and not _cached(self.hf_home):
            return "unavailable", "sem HF_TOKEN (aceite os termos do modelo no Hugging Face)"
        # Com token/cache, cada job tenta de novo; o último erro fica visível.
        return "enabled", self.last_error

    def available(self) -> bool:
        return self.status()[0] == "enabled"

    def _load(self):
        if _cached(self.hf_home):
            # Modelo já baixado: nada de rede daqui pra frente (LOCAL_ONLY).
            os.environ["HF_HUB_OFFLINE"] = "1"
            try:
                from huggingface_hub import constants

                constants.HF_HUB_OFFLINE = True
            except Exception:  # noqa: BLE001
                pass
        import torch
        from pyannote.audio import Pipeline

        pipeline = Pipeline.from_pretrained(PIPELINE_ID, token=self.token)
        if pipeline is None:
            raise RuntimeError("não foi possível carregar o pipeline (termos aceitos no Hugging Face?)")
        pipeline.to(torch.device(self.device))
        return pipeline

    def run(self, audio: np.ndarray) -> list[Turn]:
        """Carrega o pipeline, processa e libera a VRAM."""
        import torch

        with self._lock:
            pipeline = None
            try:
                pipeline = self._load()
                self.last_error = None
                waveform = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).unsqueeze(0)
                output = pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE})
                annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(
                    output, "speaker_diarization", output
                )
                turns = [
                    Turn(float(seg.start), float(seg.end), str(label))
                    for seg, _track, label in annotation.itertracks(yield_label=True)
                ]
                log.info("diarização: %d turnos, %d falantes", len(turns), len({t.speaker for t in turns}))
                return turns
            except Exception as err:
                self.last_error = f"falha na diarização: {err}"
                raise
            finally:
                del pipeline
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()


def diarizer_from_env() -> Diarizer:
    return Diarizer(
        token=os.environ.get("HF_TOKEN"),
        hf_home=os.environ.get("HF_HOME", "/models/hf"),
        device=os.environ.get("ASR_DEVICE", "cuda"),
    )


__all__ = ["Diarizer", "Turn", "Word", "assign_speakers", "diarizer_from_env"]
