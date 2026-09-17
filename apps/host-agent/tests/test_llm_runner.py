import json
import os
import stat
from pathlib import Path

import pytest

from host_agent import llm_runner as lr

SCHEMA = {"type": "object", "properties": {"resumo": {"type": "string"}}, "required": ["resumo"], "additionalProperties": False}
SECRET = "trecho confidencial da reunião"


def job(provider, **extra):
    return {
        "id": "j1",
        "provider": provider,
        "model": "",
        "system": "Você é o arquiteto.",
        "user": SECRET,
        "schema": SCHEMA,
        "timeoutSeconds": 30,
        **extra,
    }


def script(path: Path, body: str) -> str:
    path.write_text("#!/usr/bin/env python3\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


FAKE_CLAUDE = r'''
import json, os, sys, time
REC = {rec!r}
args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.0 (Claude Code)"); sys.exit(0)
if args[:2] == ["auth", "status"]:
    print(json.dumps({{"loggedIn": {logged}}})); sys.exit(0)
data = sys.stdin.read()
json.dump({{"args": args, "stdin": data, "env": dict(os.environ), "cwd": os.getcwd()}}, open(REC, "w"))
if "{mode}" == "slow":
    time.sleep(30)
if "{mode}" == "error":
    print(json.dumps({{"type": "result", "subtype": "success", "is_error": True, "result": "Credit balance too low"}})); sys.exit(1)
print(json.dumps({{
    "type": "result", "subtype": "success", "is_error": False,
    "result": "{{}}", "structured_output": {{"resumo": "ok: " + data[:5]}},
    "usage": {{"input_tokens": 2, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 10, "output_tokens": 50}},
    "modelUsage": {{"claude-haiku-4-5": {{"outputTokens": 3}}, "claude-sonnet-5": {{"outputTokens": 50}}}},
}}))
'''

FAKE_CODEX = r'''
import json, os, sys
REC = {rec!r}
args = sys.argv[1:]
home = os.environ.get("CODEX_HOME", "")
if args == ["--version"]:
    print("codex-cli 0.1.0"); sys.exit(0)
if args[:2] == ["login", "status"]:
    ok = os.path.exists(os.path.join(home, "auth.json"))
    print("Logged in using ChatGPT" if ok else "Not logged in"); sys.exit(0 if ok else 1)
if args[:2] == ["features", "list"]:
    print("shell_tool   stable  true\napps   stable   true\nhooks  stable true"); sys.exit(0)
data = sys.stdin.read()
json.dump({{"args": args, "stdin": data, "env": dict(os.environ)}}, open(REC, "w"))
out = args[args.index("-o") + 1]
schema = json.load(open(args[args.index("--output-schema") + 1]))
assert schema["required"] == ["resumo"]
if "{mode}" == "fail":
    print(json.dumps({{"type": "turn.failed", "error": {{"message": "usage limit reached"}}}})); sys.exit(1)
open(out, "w").write(json.dumps({{"resumo": "codex ok"}}))
print(json.dumps({{"type": "thread.started"}}))
print(json.dumps({{"type": "turn.completed", "usage": {{"input_tokens": 900, "output_tokens": 40}}}}))
'''


@pytest.fixture
def fakes(tmp_path, monkeypatch):
    def make(claude_mode="ok", codex_mode="ok", logged="True", codex_login=True):
        rec_claude = tmp_path / "claude.json"
        rec_codex = tmp_path / "codex.json"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir(exist_ok=True)
        claude = script(bin_dir / "claude", FAKE_CLAUDE.format(rec=str(rec_claude), mode=claude_mode, logged=logged))
        codex = script(bin_dir / "codex", FAKE_CODEX.format(rec=str(rec_codex), mode=codex_mode))
        home = tmp_path / "codex-home"
        home.mkdir(exist_ok=True)
        if codex_login:
            (home / "auth.json").write_text("{}")
        cfg = lr.LlmCliConfig(claude_bin=claude, codex_bin=codex, codex_home=home)
        return lr.LlmRunner(cfg), rec_claude, rec_codex
    monkeypatch.setenv("AGENT_TOKEN", "x" * 40)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-nao-pode-vazar")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-nao-pode-vazar")
    return make


async def test_claude_isolado_texto_por_stdin(fakes):
    runner, rec, _ = fakes()
    result = await runner.run(job("claude", model="sonnet"))
    assert result["ok"] is True
    assert result["output"] == {"resumo": "ok: trech"}
    assert result["usage"] == {"inputTokens": 1012, "outputTokens": 50, "model": "claude-sonnet-5"}
    call = json.loads(rec.read_text())
    args = call["args"]
    assert args[0] == "-p"
    for flag in ("--restricted", "--strict-mcp-config", "--no-session-persistence"):
        assert flag in args
    assert args[args.index("--tools") + 1] == ""
    assert json.loads(args[args.index("--json-schema") + 1]) == SCHEMA
    assert args[args.index("--system-prompt") + 1] == "Você é o arquiteto."
    assert args[args.index("--model") + 1] == "sonnet"
    assert call["stdin"] == SECRET
    assert all(SECRET not in a for a in args)
    for leaked in ("AGENT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        assert leaked not in call["env"]
    assert call["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert Path(call["cwd"]).name.startswith("agente-llm-")
    assert not Path(call["cwd"]).exists()  # pasta temporária removida


async def test_codex_isolado_sem_ferramentas(fakes, tmp_path):
    runner, _, rec = fakes()
    result = await runner.run(job("codex"))
    assert result == {
        "ok": True,
        "output": '{"resumo": "codex ok"}',
        "usage": {"inputTokens": 900, "outputTokens": 40, "model": None},
        "durationMs": result["durationMs"],
    }
    call = json.loads(rec.read_text())
    args = call["args"]
    assert args[0] == "exec" and args[-1] == "-"
    for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"):
        assert flag in args
    assert args[args.index("--sandbox") + 1] == "read-only"
    disabled = {args[i + 1] for i, a in enumerate(args) if a == "--disable"}
    assert disabled == {"shell_tool", "apps", "hooks"}  # só os que existem nesta versão
    assert "-m" not in args
    assert "Você é o arquiteto." in call["stdin"] and SECRET in call["stdin"]
    assert all(SECRET not in a for a in args)
    assert call["env"]["CODEX_HOME"] == str(tmp_path / "codex-home")
    assert "OPENAI_API_KEY" not in call["env"] and "AGENT_TOKEN" not in call["env"]


async def test_status_e_erros_claros(fakes, tmp_path):
    runner, _, _ = fakes(logged="False", codex_login=False)
    status = await runner.refresh(force=True)
    assert status["claude"] == {"available": False, "reason": "Claude Code sem login: rode `claude` e faça /login", "version": "2.1.0 (Claude Code)"}
    assert status["codex"]["available"] is False
    assert f"CODEX_HOME={tmp_path / 'codex-home'} codex login --device-auth" in status["codex"]["reason"]
    result = await runner.run(job("codex"))
    assert result["ok"] is False and "codex login" in result["error"]

    runner, _, _ = fakes(claude_mode="error", codex_mode="fail")
    assert await runner.run(job("claude")) == {"ok": False, "error": "Credit balance too low"}
    assert await runner.run(job("codex")) == {"ok": False, "error": "usage limit reached"}
    assert (await runner.run(job("gpt")))["error"] == "provedor desconhecido: gpt"
    assert (await runner.run(job("claude", model="sonnet; rm -rf ~")))["error"] == "modelo inválido"


async def test_timeout_mata_o_processo(fakes):
    runner, _, _ = fakes(claude_mode="slow")
    result = await runner.run(job("claude", timeoutSeconds=1))
    assert result == {"ok": False, "error": "o claude passou de 1 s"}


async def test_desligado_ou_ausente(tmp_path):
    cfg = lr.LlmCliConfig(enabled=("claude",), claude_bin=str(tmp_path / "nao-existe"), codex_home=tmp_path)
    runner = lr.LlmRunner(cfg)
    status = await runner.refresh()
    assert status["claude"]["reason"] == "claude não encontrado nesta máquina"
    assert status["codex"]["reason"] == "codex desligado na configuração do host-agent"


def test_parse_saidas():
    out, usage = lr.parse_claude_output(json.dumps({"result": '{"a":1}', "usage": {}}).encode())
    assert out == '{"a":1}' and usage["inputTokens"] is None
    with pytest.raises(lr.JobError, match="não é JSON"):
        lr.parse_claude_output(b"Error: not logged in")
    with pytest.raises(lr.JobError, match="o codex não devolveu resposta"):
        lr.parse_codex_output("", b"lixo\n")


def test_env_sem_segredos():
    env = lr.child_env("codex", lr.LlmCliConfig(codex_home=Path("/x")), base={
        "HOME": "/home/u", "PATH": "/usr/bin", "AGENT_TOKEN": "t", "CODEX_API_KEY": "k", "DATABASE_URL": "d",
    })
    assert env["HOME"] == "/home/u" and env["CODEX_HOME"] == "/x"
    assert env["PATH"].startswith("/usr/bin" + os.pathsep)
    assert not {"AGENT_TOKEN", "CODEX_API_KEY", "DATABASE_URL"} & env.keys()


async def test_erro_inesperado_vira_resposta(fakes, monkeypatch):
    runner, _, _ = fakes()

    async def boom(*args, **kwargs):
        raise RuntimeError("quebrou")

    monkeypatch.setattr(runner, "_execute", boom)
    assert await runner.run(job("claude")) == {"ok": False, "error": "falha interna do host-agent: RuntimeError"}
