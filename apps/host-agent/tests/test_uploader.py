import asyncio
import json
import os

import pytest
from websockets.asyncio.server import serve

from host_agent import uploader as up


class FakeBackend:
    """Servidor WS que imita /api/agent/audio."""

    def __init__(self, drop_after_frames=None, close_code=None, initial=b""):
        self.data = bytearray(initial)
        self.drop_after_frames = drop_after_frames
        self.close_code = close_code
        self.connections = 0
        self.auth = []
        self.paths = []

    async def handler(self, ws):
        self.connections += 1
        self.auth.append(ws.request.headers.get("Authorization"))
        self.paths.append(ws.request.path)
        if self.close_code:
            await ws.close(self.close_code, "não gravando")
            return
        await ws.send(json.dumps({"type": "ready", "offset": len(self.data), "format": "s16le", "rate": 16000, "channels": 1}))
        frames = 0
        async for msg in ws:
            if isinstance(msg, bytes):
                assert len(msg) % 2 == 0 and len(msg) <= up.MAX_FRAME
                self.data.extend(msg)
                frames += 1
                if self.drop_after_frames and frames >= self.drop_after_frames and self.connections == 1:
                    await ws.close(1011, "falha simulada")
                    return
            else:
                body = json.loads(msg)
                assert body["type"] == "end"
                assert body["total"] == len(self.data)
                await ws.send(json.dumps({"type": "ended", "offset": len(self.data)}))
                await ws.close()
                return


async def start(backend):
    server = await serve(backend.handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, f"ws://127.0.0.1:{port}"


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch):
    monkeypatch.setattr(up, "BACKOFF", [0.05])


def spool(tmp_path, size):
    path = tmp_path / "mic.pcm"
    payload = os.urandom(size)
    path.write_bytes(payload)
    return path, payload


async def test_sends_everything_and_ends(tmp_path):
    path, payload = spool(tmp_path, 200_000)
    backend = FakeBackend()
    server, base = await start(backend)
    try:
        u = up.ChannelUploader(base, "tok" * 11, "m1", "mic", path, capture_done=lambda: True)
        assert await asyncio.wait_for(u.run(), 10) is True
    finally:
        server.close()
    assert bytes(backend.data) == payload
    assert backend.auth == ["Bearer " + "tok" * 11]
    assert backend.paths == ["/api/agent/audio?meeting=m1&channel=mic"]


async def test_resumes_from_server_offset(tmp_path):
    path, payload = spool(tmp_path, 300_000)
    backend = FakeBackend(initial=payload[:100_000])
    server, base = await start(backend)
    try:
        u = up.ChannelUploader(base, "t" * 32, "m1", "mic", path, capture_done=lambda: True)
        assert await asyncio.wait_for(u.run(), 10)
    finally:
        server.close()
    assert bytes(backend.data) == payload


async def test_reconnects_after_drop(tmp_path):
    path, payload = spool(tmp_path, 400_000)
    backend = FakeBackend(drop_after_frames=2)
    server, base = await start(backend)
    try:
        u = up.ChannelUploader(base, "t" * 32, "m1", "mic", path, capture_done=lambda: True)
        assert await asyncio.wait_for(u.run(), 10)
    finally:
        server.close()
    assert backend.connections == 2
    assert bytes(backend.data) == payload


async def test_follows_growing_file(tmp_path):
    path = tmp_path / "mic.pcm"
    path.write_bytes(b"\x01\x00" * 1000)
    done = {"flag": False}
    backend = FakeBackend()
    server, base = await start(backend)

    async def writer():
        await asyncio.sleep(0.2)
        with open(path, "ab") as fh:
            fh.write(b"\x02\x00" * 1000)
            fh.write(b"\x03")  # meia amostra: não pode ser enviada ainda
            fh.flush()
            await asyncio.sleep(0.2)
            fh.write(b"\x00")
        done["flag"] = True

    try:
        u = up.ChannelUploader(base, "t" * 32, "m1", "mic", path, capture_done=lambda: done["flag"], poll_interval=0.02)
        results = await asyncio.wait_for(asyncio.gather(u.run(), writer()), 10)
        assert results[0] is True
    finally:
        server.close()
    assert bytes(backend.data) == path.read_bytes()
    assert len(backend.data) == 4002


async def test_stops_when_meeting_not_recording(tmp_path):
    path, _ = spool(tmp_path, 1000)
    backend = FakeBackend(close_code=4409)
    server, base = await start(backend)
    try:
        u = up.ChannelUploader(base, "t" * 32, "m1", "mic", path, capture_done=lambda: False)
        assert await asyncio.wait_for(u.run(), 10) is False
        assert u.rejected
    finally:
        server.close()
    assert backend.connections == 1


def test_ws_base():
    assert up.ws_base_from("http://127.0.0.1:3000") == "ws://127.0.0.1:3000"
    assert up.ws_base_from("https://ata.local") == "wss://ata.local"
