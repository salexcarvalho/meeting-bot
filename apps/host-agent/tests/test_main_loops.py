"""Resiliência dos laços do host-agent: falha numa iteração não pode matar o laço."""

import asyncio
import logging

import pytest

from host_agent import main as hm
from host_agent.config import Config

CTX = dict(backend_url="http://127.0.0.1:1", agent_token="x" * 40)


def make_agent(tmp_path, mode="full") -> hm.HostAgent:
    cfg = Config(
        spool_dir=tmp_path / "spool", state_dir=tmp_path / "state", env_file=tmp_path / ".env", mode=mode, **CTX
    )
    return hm.HostAgent(cfg)


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(hm, "HEARTBEAT_SECONDS", 0.01)


class FakeApi:
    """heartbeat devolve o próximo item da lista; Exception é levantada."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = 0

    async def heartbeat(self, capture, llm, mode):
        self.calls += 1
        item = self.results.pop(0) if self.results else {"meetings": []}
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self):
        pass


async def wait_until(cond, timeout=2.0):
    async with asyncio.timeout(timeout):
        while not cond():
            await asyncio.sleep(0.005)


async def stop(agent, task):
    agent._stopping.set()
    await asyncio.wait_for(task, 2)


async def test_excecao_na_iteracao_nao_para_o_heartbeat(tmp_path, caplog):
    agent = make_agent(tmp_path)
    # 1) payload inválido (KeyError em Meeting.from_api)  2) ValueError do backend  3) ok
    agent.api = FakeApi([{"meetings": [{"sem": "id"}]}, ValueError("json inválido"), {"meetings": []}, {"meetings": []}])
    with caplog.at_level(logging.ERROR, logger="host_agent"):
        task = asyncio.create_task(agent.heartbeat_loop())
        await wait_until(lambda: agent.api.calls >= 4)
        assert not task.done()
        await stop(agent, task)
    erros = [r for r in caplog.records if r.exc_info]
    assert len(erros) == 2  # as duas falhas foram logadas com traceback, nada silencioso


async def test_cancelamento_propaga(tmp_path):
    agent = make_agent(tmp_path)
    agent.api = FakeApi([])
    task = asyncio.create_task(agent.heartbeat_loop())
    await wait_until(lambda: agent.api.calls >= 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_converge_travado_nao_trava_o_heartbeat(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(hm, "CONVERGE_TIMEOUT", 0.05)
    agent = make_agent(tmp_path)
    agent.api = FakeApi([{"meetings": []}] * 50)

    async def hang(desired):
        await asyncio.sleep(3600)

    agent.converge = hang
    with caplog.at_level(logging.ERROR, logger="host_agent"):
        task = asyncio.create_task(agent.heartbeat_loop())
        await wait_until(lambda: agent.api.calls >= 3)
        await stop(agent, task)
    assert any("converge excedeu" in r.getMessage() for r in caplog.records)


async def test_heartbeat_travado_estoura_o_teto(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(hm, "HEARTBEAT_CALL_TIMEOUT", 0.05)
    agent = make_agent(tmp_path)
    calls = 0

    async def hang(capture, llm, mode):
        nonlocal calls
        calls += 1
        await asyncio.sleep(3600)

    agent.api.heartbeat = hang
    with caplog.at_level(logging.ERROR, logger="host_agent"):
        task = asyncio.create_task(agent.heartbeat_loop())
        await wait_until(lambda: calls >= 2)
        await stop(agent, task)
    assert any("heartbeat excedeu" in r.getMessage() for r in caplog.records)


async def test_aviso_quando_heartbeat_envelhece(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(hm, "STALE_WARNING_EVERY", 0)
    agent = make_agent(tmp_path)
    agent._last_heartbeat_ok -= 3600
    agent.api = FakeApi([None, None])
    with caplog.at_level(logging.WARNING, logger="host_agent"):
        task = asyncio.create_task(agent.heartbeat_loop())
        await wait_until(lambda: agent.api.calls >= 2)
        await stop(agent, task)
    assert any("último heartbeat bem-sucedido" in r.getMessage() for r in caplog.records)


async def test_modo_llm_nao_converge(tmp_path):
    agent = make_agent(tmp_path, mode="llm")
    agent.api = FakeApi([{"meetings": [{"sem": "id"}]}] * 3)
    task = asyncio.create_task(agent.heartbeat_loop())
    await wait_until(lambda: agent.api.calls >= 3)
    await stop(agent, task)


async def test_excecao_em_alertas_nao_para_o_laco(tmp_path, caplog):
    agent = make_agent(tmp_path)
    calls = 0

    def due(now, meetings):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("agenda corrompida")
        return []

    agent.scheduler.due = due
    with caplog.at_level(logging.ERROR, logger="host_agent"):
        task = asyncio.create_task(agent.alert_loop())
        # a falha espera HEARTBEAT_SECONDS (0.01) e repete
        await wait_until(lambda: calls >= 2, timeout=3)
        await stop(agent, task)
    assert any(r.exc_info for r in caplog.records)


async def test_task_que_morre_e_logada_e_encerra_com_erro(tmp_path, caplog):
    agent = make_agent(tmp_path)

    async def boom():
        raise RuntimeError("laço morreu")

    task = asyncio.create_task(boom(), name="heartbeat")
    task.add_done_callback(agent._on_loop_done)
    with caplog.at_level(logging.CRITICAL, logger="host_agent"):
        await asyncio.wait_for(agent._stopping.wait(), 2)
    assert agent.exit_code == 1
    rec = next(r for r in caplog.records if "terminou inesperadamente" in r.getMessage())
    assert rec.exc_info and "laço morreu" in str(rec.exc_info[1])


async def test_encerramento_normal_nao_vira_erro(tmp_path):
    agent = make_agent(tmp_path)
    agent._stopping.set()

    async def ok():
        return None

    task = asyncio.create_task(ok())
    task.add_done_callback(agent._on_loop_done)
    await task
    await asyncio.sleep(0)
    assert agent.exit_code == 0


async def test_tarefa_avulsa_que_falha_e_logada(tmp_path, caplog):
    agent = make_agent(tmp_path)

    async def boom():
        raise RuntimeError("alerta quebrou")

    with caplog.at_level(logging.ERROR, logger="host_agent"):
        agent._spawn(boom(), "alerta")
        await wait_until(lambda: not agent._background)
    assert any(r.exc_info for r in caplog.records)
