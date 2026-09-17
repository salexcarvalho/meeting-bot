"""Telemetria da GPU via NVML (mostrada na tela da reunião em andamento)."""

from __future__ import annotations

import threading

_lock = threading.Lock()
_initialized: bool | None = None


def _init() -> bool:
    global _initialized
    with _lock:
        if _initialized is None:
            try:
                import pynvml

                pynvml.nvmlInit()
                _initialized = True
            except Exception:  # noqa: BLE001 — sem driver/GPU: telemetria indisponível
                _initialized = False
        return _initialized


def gpu_stats() -> dict | None:
    if not _init():
        return None
    import pynvml

    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
    except Exception:  # noqa: BLE001
        return None
    return {
        "name": name.decode() if isinstance(name, bytes) else name,
        "utilization": int(util.gpu),
        "memory_used_mb": int(mem.used // (1024 * 1024)),
        "memory_total_mb": int(mem.total // (1024 * 1024)),
    }
