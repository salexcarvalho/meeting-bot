from pathlib import Path

from host_agent.capture import BYTES_PER_SECOND, MAX_FAILURES, ChannelCapture, Recorder


class FakeProc:
    def __init__(self):
        self.stdout = None
        self.code = None
        self.killed = False

    def poll(self):
        return self.code

    def kill(self):
        self.killed = True
        self.code = -9

    def wait(self, timeout=None):
        return self.code


class Env:
    def __init__(self):
        self.now = 1000.0
        self.device = "alsa_input.mic"
        self.procs = []
        self.fail_spawn = False

    def spawn(self, channel):
        if self.fail_spawn:
            raise OSError("parec não encontrado")
        proc = FakeProc()
        self.procs.append(proc)
        return proc

    def device_fn(self, channel):
        return self.device


def make(tmp_path: Path, env: Env, origin=None) -> ChannelCapture:
    cap = ChannelCapture(
        "mic", tmp_path / "m1" / "mic.pcm", origin if origin is not None else env.now,
        spawn=env.spawn, device_fn=env.device_fn, clock=lambda: env.now,
    )
    cap.open()
    return cap


def test_pad_fills_gap_from_origin(tmp_path):
    env = Env()
    cap = make(tmp_path, env, origin=env.now - 5)  # host-agent começou 5 s depois do backend
    padded = cap.pad_to(env.now)
    assert padded == 5 * BYTES_PER_SECOND
    assert cap.written == 5 * BYTES_PER_SECOND
    cap.close()
    assert (tmp_path / "m1" / "mic.pcm").read_bytes() == b"\x00" * (5 * BYTES_PER_SECOND)


def test_small_lag_is_not_padded(tmp_path):
    env = Env()
    cap = make(tmp_path, env)
    cap.write(b"\x01\x00" * 16000)  # 1 s de áudio
    env.now += 1.5  # 0,5 s de atraso normal de buffer
    assert cap.pad_to(env.now) == 0
    env.now += 1.0  # 1,5 s sem dados → lacuna
    assert cap.pad_to(env.now) == int(1.5 * BYTES_PER_SECOND)
    assert cap.written == int(2.5 * BYTES_PER_SECOND)


def test_reopen_appends_and_keeps_even_size(tmp_path):
    env = Env()
    path = tmp_path / "m1" / "mic.pcm"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x01\x02\x03")
    cap = make(tmp_path, env)
    assert cap.written == 4
    cap.write(b"\x05\x06")
    cap.close()
    assert path.read_bytes() == b"\x01\x02\x03\x00\x05\x06"


def test_restarts_process_when_device_changes(tmp_path):
    env = Env()
    cap = make(tmp_path, env)
    cap.tick(env.now)
    assert cap.state == "recording" and len(env.procs) == 1
    assert cap.device == "alsa_input.mic"
    env.device = "bluez_input.headset"
    env.now += 3.5
    cap.tick(env.now)
    assert env.procs[0].killed
    assert len(env.procs) == 2
    assert cap.device == "bluez_input.headset"
    assert cap.state == "recording"


def test_process_death_backoff_and_unavailable(tmp_path):
    env = Env()
    cap = make(tmp_path, env)
    cap.tick(env.now)
    for i in range(MAX_FAILURES):
        env.procs[-1].code = 1
        env.now += 1
        cap.tick(env.now)  # detecta a morte e agenda nova tentativa
        assert cap.state in ("restarting", "unavailable")
        env.now += 20
        cap.tick(env.now)  # reinicia
        if i < MAX_FAILURES - 1:
            assert cap.state == "recording"
    assert cap.failures == MAX_FAILURES
    # Mesmo sem processo, a linha do tempo continua com silêncio.
    assert cap.written >= int((env.now - cap.origin - 1) * BYTES_PER_SECOND)


def test_spawn_failure_marks_unavailable(tmp_path):
    env = Env()
    env.fail_spawn = True
    cap = make(tmp_path, env)
    for _ in range(MAX_FAILURES):
        cap.tick(env.now)
        env.now += 20
    assert cap.state == "unavailable"


def test_recorder_status_shape(tmp_path):
    env = Env()
    rec = Recorder("m1", tmp_path, origin=env.now, spawn=env.spawn, device_fn=env.device_fn, clock=lambda: env.now)
    status = rec.status()
    assert status["meetingId"] == "m1"
    assert set(status["channels"]) == {"mic", "remote"}
    assert status["channels"]["mic"] == {"state": "restarting", "device": None, "bytes": 0}
