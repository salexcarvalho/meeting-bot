"""Cliente HTTP do backend (rotas /api/agent/*)."""

from __future__ import annotations

import logging

import httpx

from . import __version__

log = logging.getLogger("host_agent.api")


class BackendApi:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url
        self.token = token
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}", "User-Agent": f"agente-host/{__version__}"},
            timeout=httpx.Timeout(5.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def heartbeat(self, capture: dict | None) -> dict | None:
        try:
            res = await self._client.post("/api/agent/heartbeat", json={"version": __version__, "capture": capture})
        except httpx.HTTPError as err:
            log.debug("backend indisponível: %s", err)
            return None
        if res.status_code == 401:
            log.error("AGENT_TOKEN recusado pelo backend (confira o .env)")
            return None
        if res.status_code != 200:
            log.warning("heartbeat respondeu %s: %s", res.status_code, res.text[:200])
            return None
        return res.json()

    async def skip(self, meeting_id: str) -> bool:
        try:
            res = await self._client.post(f"/api/agent/meetings/{meeting_id}/skip")
        except httpx.HTTPError as err:
            log.warning("não foi possível marcar 'não gravar': %s", err)
            return False
        if res.status_code != 200:
            log.warning("'não gravar' respondeu %s: %s", res.status_code, res.text[:200])
        return res.status_code == 200
