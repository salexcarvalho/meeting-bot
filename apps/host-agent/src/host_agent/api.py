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

    async def heartbeat(self, capture: dict | None, llm: dict | None = None) -> dict | None:
        body: dict = {"version": __version__, "capture": capture}
        if llm:
            body["llm"] = llm
        try:
            res = await self._client.post("/api/agent/heartbeat", json=body)
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

    async def next_llm_job(self, wait_seconds: int) -> dict | None:
        """Long-poll do próximo pedido de geração (None = nada ou backend fora)."""
        try:
            res = await self._client.get(
                "/api/agent/llm/next",
                params={"wait": wait_seconds},
                timeout=httpx.Timeout(5.0, read=wait_seconds + 10),
            )
        except httpx.HTTPError as err:
            log.debug("fila de geração indisponível: %s", err)
            raise ConnectionError(str(err)) from err
        if res.status_code == 204:
            return None
        if res.status_code != 200:
            raise ConnectionError(f"fila de geração respondeu {res.status_code}")
        return res.json()

    async def post_llm_result(self, job_id: str, result: dict) -> bool:
        try:
            res = await self._client.post(f"/api/agent/llm/{job_id}/result", json=result, timeout=30.0)
        except httpx.HTTPError as err:
            log.warning("não foi possível devolver a geração %s: %s", job_id[:8], err)
            return False
        if res.status_code != 200:
            log.warning("resultado da geração %s recusado (%s): %s", job_id[:8], res.status_code, res.text[:200])
        return res.status_code == 200

    async def skip(self, meeting_id: str) -> bool:
        try:
            res = await self._client.post(f"/api/agent/meetings/{meeting_id}/skip")
        except httpx.HTTPError as err:
            log.warning("não foi possível marcar 'não gravar': %s", err)
            return False
        if res.status_code != 200:
            log.warning("'não gravar' respondeu %s: %s", res.status_code, res.text[:200])
        return res.status_code == 200
