"""Abre o link da reunião no navegador padrão."""

from __future__ import annotations

import logging
import subprocess
from urllib.parse import urlparse

log = logging.getLogger("host_agent.opener")


def open_url(url: str) -> bool:
    if urlparse(url).scheme != "https":
        log.warning("link recusado (não é https): %s", url[:80])
        return False
    try:
        subprocess.Popen(
            ["xdg-open", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as err:
        log.error("falha ao abrir o navegador: %s", err)
        return False
    return True
