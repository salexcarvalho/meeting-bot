"""Conversão e validação de áudio."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
MAX_CHUNK_SECONDS = 35


def audio_root() -> Path:
    return Path(os.environ.get("AUDIO_ROOT", "/data/audio")).resolve()


def pcm_to_float32(data: bytes) -> np.ndarray:
    """PCM s16le mono 16 kHz → float32 em [-1, 1]."""
    if not data:
        raise ValueError("corpo vazio")
    if len(data) % 2:
        raise ValueError("PCM com número ímpar de bytes")
    if len(data) > MAX_CHUNK_SECONDS * BYTES_PER_SECOND:
        raise ValueError(f"trecho maior que {MAX_CHUNK_SECONDS} s")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def validate_path(raw: str) -> Path:
    """Só aceita arquivos existentes dentro de AUDIO_ROOT (sem path traversal)."""
    root = audio_root()
    path = Path(raw).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"caminho fora de {root}")
    if not path.is_file():
        raise ValueError(f"arquivo não encontrado: {path.name}")
    return path


def load_file(path: Path) -> np.ndarray:
    from faster_whisper import decode_audio

    return decode_audio(str(path), sampling_rate=SAMPLE_RATE)
