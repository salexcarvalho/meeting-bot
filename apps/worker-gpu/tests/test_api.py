import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from worker_gpu.asr import ChunkResult, SegmentOut
from worker_gpu.jobs import JobManager
from worker_gpu.main import create_app


class FakeEngine:
    model_name = "fake"
    compute_type = "int8"
    device = "cpu"
    error = None

    def __init__(self, ready=True):
        self.ready = ready
        self.calls = []

    def load_in_background(self):
        pass

    def transcribe_chunk(self, audio, language, prompt):
        self.calls.append(("chunk", len(audio), language, prompt))
        return ChunkResult(len(audio) / 16000, 1.5, 0.01, [SegmentOut(0.1, 1.2, "olá pessoal")])

    def transcribe_file(self, audio, language, prompt, word_timestamps, progress=None):
        self.calls.append(("file", len(audio), word_timestamps))
        if progress:
            progress(1.0)
        return [SegmentOut(0.0, 1.0, "primeira fala"), SegmentOut(1.0, 2.0, "segunda fala")]


class FakeDiarizer:
    def __init__(self, available=False):
        self._available = available

    def status(self):
        return ("enabled", None) if self._available else ("unavailable", "sem HF_TOKEN")

    def available(self):
        return self._available

    def run(self, audio):
        raise AssertionError("não deveria diarizar")


@pytest.fixture
def audio_root(tmp_path, monkeypatch):
    root = tmp_path / "audio"
    (root / "m1").mkdir(parents=True)
    (root / "m1" / "remote.ogg").write_bytes(b"x")
    monkeypatch.setenv("AUDIO_ROOT", str(root))
    return root


def make_client(engine=None, diarizer=None):
    engine = engine or FakeEngine()
    diarizer = diarizer or FakeDiarizer()
    jobs = JobManager(engine, diarizer, loader=lambda p: np.zeros(32000, dtype=np.float32))
    app = create_app(engine=engine, diarizer=diarizer, jobs=jobs, load_model=False)
    return TestClient(app), engine


def test_health_reports_diarization_state():
    client, _ = make_client()
    with client:
        body = client.get("/health").json()
    assert body["ok"] is True
    assert body["diarization"] == "unavailable"
    assert body["diarization_reason"] == "sem HF_TOKEN"


def test_health_503_while_loading():
    client, _ = make_client(engine=FakeEngine(ready=False))
    with client:
        assert client.get("/health").status_code == 503


def test_chunk_ok():
    client, engine = make_client()
    pcm = (np.ones(16000, dtype="<i2") * 1000).tobytes()
    with client:
        res = client.post("/transcribe/chunk?language=pt&prompt=Portal%20SES", content=pcm,
                          headers={"Content-Type": "application/octet-stream"})
    assert res.status_code == 200
    body = res.json()
    assert body["speech_seconds"] == 1.5
    assert body["duration"] == 1.0
    assert body["segments"] == [{"start": 0.1, "end": 1.2, "text": "olá pessoal"}]
    assert engine.calls[0] == ("chunk", 16000, "pt", "Portal SES")


@pytest.mark.parametrize("payload", [b"", b"\x00", b"\x00\x00" * (35 * 16000 + 1)])
def test_chunk_rejects_invalid_body(payload):
    client, _ = make_client()
    with client:
        res = client.post("/transcribe/chunk", content=payload)
    assert res.status_code == 400


def test_chunk_503_while_loading():
    client, _ = make_client(engine=FakeEngine(ready=False))
    with client:
        assert client.post("/transcribe/chunk", content=b"\x00\x00").status_code == 503


def test_job_lifecycle(audio_root):
    client, engine = make_client()
    with client:
        res = client.post("/jobs/transcribe", json={
            "language": "pt",
            "files": [{"path": str(audio_root / "m1" / "remote.ogg"), "channel": "remote", "diarize": True}],
        })
        assert res.status_code == 202
        job_id = res.json()["job_id"]
        deadline = time.time() + 5
        body = {}
        while time.time() < deadline:
            body = client.get(f"/jobs/{job_id}").json()
            if body["status"] in ("done", "error"):
                break
            time.sleep(0.02)
    assert body["status"] == "done", body
    channel = body["result"]["channels"][0]
    assert channel["channel"] == "remote"
    assert channel["diarized"] is False  # diarizador indisponível
    assert channel["duration"] == 2.0
    assert [s["text"] for s in channel["segments"]] == ["primeira fala", "segunda fala"]
    assert engine.calls[0] == ("file", 32000, False)


def test_job_rejects_path_outside_root(audio_root, tmp_path):
    outside = tmp_path / "segredo.ogg"
    outside.write_bytes(b"x")
    client, _ = make_client()
    with client:
        for path in [str(outside), str(audio_root / ".." / "segredo.ogg"), "/etc/passwd"]:
            res = client.post("/jobs/transcribe", json={"files": [{"path": path}]})
            assert res.status_code == 400, path


def test_unknown_job_404():
    client, _ = make_client()
    with client:
        assert client.get("/jobs/nao-existe").status_code == 404
