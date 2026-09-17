"""Geração com a assinatura pessoal (Constituição 1.4.0): executa o CLI oficial isolado.

O backend manda o pedido (sistema, texto, JSON Schema); aqui roda `claude -p` ou `codex exec`
sem ferramentas, sem hooks, sem MCP e sem instruções do usuário, numa pasta temporária vazia,
com o texto por stdin (nunca na linha de comando). Credenciais ficam com o próprio CLI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("host_agent.llm")

PROVIDERS = ("claude", "codex")
STATUS_TTL_SECONDS = 60
STATUS_TIMEOUT_SECONDS = 20
MAX_OUTPUT_BYTES = 200_000
# Pastas de binários do usuário que o systemd --user não põe no PATH.
EXTRA_PATH = ("~/.local/bin", "~/.npm-global/bin", "~/.bun/bin")
# Só o necessário para o CLI achar o login e a rede; nada de tokens do projeto.
ENV_ALLOWLIST = (
    "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
)
# Recursos do Codex que dão ferramentas ao modelo: todos desligados (os ausentes são ignorados).
CODEX_DISABLED_FEATURES = (
    "shell_tool", "unified_exec", "code_mode", "code_mode_host", "multi_agent", "multi_agent_v2",
    "apps", "plugins", "plugin_sharing", "remote_plugin", "browser_use", "browser_use_external",
    "computer_use", "in_app_browser", "image_generation", "view_image", "hooks", "goals",
    "memories", "skill_search", "skill_mcp_dependency_install", "tool_suggest",
    "workspace_dependencies", "standalone_web_search",
)
MODEL_RE = re.compile(r"^[\w.:/-]{1,80}$")


@dataclass(frozen=True)
class LlmCliConfig:
    enabled: tuple[str, ...] = PROVIDERS
    claude_bin: str = ""
    codex_bin: str = ""
    # vazio = login normal do Claude Code (o --restricted já ignora hooks e configurações)
    claude_config_dir: Path | None = None
    # pasta própria: sem AGENTS.md, skills e config.toml do usuário (login separado)
    codex_home: Path = field(default_factory=lambda: Path.home() / ".config" / "agente-reunioes" / "codex")


@dataclass
class CliStatus:
    available: bool
    reason: str | None
    version: str | None
    features: frozenset[str] = frozenset()
    checked_at: float = 0.0

    def public(self) -> dict:
        return {"available": self.available, "reason": self.reason, "version": self.version}


@dataclass
class CommandResult:
    code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False


class JobError(Exception):
    pass


def find_binary(name: str, configured: str = "") -> str | None:
    if configured:
        path = Path(os.path.expanduser(configured))
        return str(path) if path.is_file() and os.access(path, os.X_OK) else None
    extra = os.pathsep.join(os.path.expanduser(p) for p in EXTRA_PATH)
    return shutil.which(name, path=f"{os.environ.get('PATH', '')}{os.pathsep}{extra}")


def child_env(provider: str, cfg: LlmCliConfig, base: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if base is None else base
    env = {k: source[k] for k in ENV_ALLOWLIST if k in source}
    extra = os.pathsep.join(os.path.expanduser(p) for p in EXTRA_PATH)
    env["PATH"] = f"{source.get('PATH', '/usr/local/bin:/usr/bin:/bin')}{os.pathsep}{extra}"
    env["NO_COLOR"] = "1"
    if provider == "claude":
        # sem autoupdate/telemetria no meio de uma geração
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        if cfg.claude_config_dir:
            env["CLAUDE_CONFIG_DIR"] = str(cfg.claude_config_dir)
    else:
        env["CODEX_HOME"] = str(cfg.codex_home)
    return env


def _tail(data: bytes, limit: int = 300) -> str:
    text = data.decode("utf-8", "replace").strip()
    lines = [line for line in text.splitlines() if line.strip()]
    return (lines[-1] if lines else "")[-limit:]


def build_claude_command(binary: str, job: dict) -> list[str]:
    cmd = [
        binary, "-p",
        "--restricted", "--tools", "", "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format", "json",
        "--json-schema", json.dumps(job["schema"], ensure_ascii=False, separators=(",", ":")),
        "--system-prompt", job["system"],
    ]
    if job.get("model"):
        cmd += ["--model", job["model"]]
    return cmd


def build_codex_command(binary: str, job: dict, workdir: Path, features: frozenset[str]) -> list[str]:
    cmd = [
        binary, "exec",
        "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
        "--sandbox", "read-only", "--color", "never",
        "-C", str(workdir),
        "-c", "project_doc_max_bytes=0",
        "-c", 'web_search="disabled"',
    ]
    for feature in CODEX_DISABLED_FEATURES:
        if not features or feature in features:
            cmd += ["--disable", feature]
    cmd += ["--output-schema", str(workdir / "schema.json"), "-o", str(workdir / "resposta.txt"), "--json"]
    if job.get("model"):
        cmd += ["-m", job["model"]]
    cmd.append("-")
    return cmd


def codex_prompt(job: dict) -> str:
    return (
        "# Instruções\n"
        f"{job['system']}\n\n"
        "Não use ferramentas nem comandos: responda só com o JSON final no schema pedido.\n\n"
        "# Pedido\n"
        f"{job['user']}\n"
    )


def parse_claude_output(stdout: bytes) -> tuple[object, dict]:
    try:
        data = json.loads(stdout)
    except ValueError as err:
        raise JobError(f"saída do claude não é JSON: {_tail(stdout)}") from err
    if isinstance(data, list):  # formato antigo: lista de eventos
        data = next((e for e in reversed(data) if isinstance(e, dict) and e.get("type") == "result"), {})
    if data.get("is_error") or data.get("subtype") not in (None, "success"):
        raise JobError(str(data.get("result") or data.get("subtype") or "erro do claude")[:300])
    output = data.get("structured_output")
    if output is None:
        output = data.get("result", "")
    usage = data.get("usage") or {}
    models = data.get("modelUsage") or {}
    main_model = max(models, key=lambda m: (models[m] or {}).get("outputTokens", 0), default=None)
    input_tokens = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return output, {
        "inputTokens": input_tokens if usage else None,
        "outputTokens": int(usage["output_tokens"]) if "output_tokens" in usage else None,
        "model": main_model,
    }


def parse_codex_output(last_message: str, events: bytes) -> tuple[object, dict]:
    input_tokens = output_tokens = 0
    seen_usage = False
    errors: list[str] = []
    for line in events.decode("utf-8", "replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "turn.completed" and isinstance(event.get("usage"), dict):
            seen_usage = True
            input_tokens += int(event["usage"].get("input_tokens") or 0)
            output_tokens += int(event["usage"].get("output_tokens") or 0)
        elif kind in ("error", "turn.failed"):
            detail = event.get("message") or (event.get("error") or {}).get("message") or kind
            errors.append(str(detail))
    if not last_message.strip():
        raise JobError(errors[-1][:300] if errors else "o codex não devolveu resposta")
    return last_message.strip(), {
        "inputTokens": input_tokens if seen_usage else None,
        "outputTokens": output_tokens if seen_usage else None,
        "model": None,
    }


async def run_command(cmd: list[str], *, stdin: bytes, env: dict[str, str], cwd: Path, timeout: float) -> CommandResult:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=cwd,
        start_new_session=True,  # permite matar o grupo inteiro no timeout
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
        return CommandResult(code=-1, stdout=b"", stderr=b"", timed_out=True)
    return CommandResult(code=proc.returncode or 0, stdout=stdout, stderr=stderr)


class LlmRunner:
    def __init__(self, cfg: LlmCliConfig, runner=run_command):
        self.cfg = cfg
        self._run = runner
        self._status: dict[str, CliStatus] = {}
        self._lock = asyncio.Lock()

    def statuses(self) -> dict[str, dict]:
        """Último estado conhecido (para o heartbeat)."""
        return {p: s.public() for p, s in self._status.items()}

    async def refresh(self, force: bool = False) -> dict[str, dict]:
        async with self._lock:
            now = time.monotonic()
            for provider in PROVIDERS:
                current = self._status.get(provider)
                if not force and current and now - current.checked_at < STATUS_TTL_SECONDS:
                    continue
                try:
                    status = await self._check(provider)
                except Exception as err:  # noqa: BLE001
                    log.warning("falha ao verificar %s: %s", provider, err)
                    status = CliStatus(False, f"falha ao verificar o {provider}", None)
                status.checked_at = now
                if not current or current.public() != status.public():
                    log.info("%s: %s", provider, "pronto" if status.available else status.reason)
                self._status[provider] = status
        return self.statuses()

    async def _check(self, provider: str) -> CliStatus:
        if provider not in self.cfg.enabled:
            return CliStatus(False, f"{provider} desligado na configuração do host-agent", None)
        binary = find_binary(provider, getattr(self.cfg, f"{provider}_bin"))
        if not binary:
            return CliStatus(False, f"{provider} não encontrado nesta máquina", None)
        env = child_env(provider, self.cfg)
        cwd = Path(tempfile.gettempdir())
        version_run = await self._run([binary, "--version"], stdin=b"", env=env, cwd=cwd, timeout=STATUS_TIMEOUT_SECONDS)
        version = _tail(version_run.stdout, 80) or None
        if provider == "claude":
            auth = await self._run([binary, "auth", "status", "--json"], stdin=b"", env=env, cwd=cwd, timeout=STATUS_TIMEOUT_SECONDS)
            try:
                logged = bool(json.loads(auth.stdout).get("loggedIn"))
            except ValueError:
                logged = False
            if not logged:
                return CliStatus(False, "Claude Code sem login: rode `claude` e faça /login", version)
            return CliStatus(True, None, version)
        self.cfg.codex_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        auth = await self._run([binary, "login", "status"], stdin=b"", env=env, cwd=cwd, timeout=STATUS_TIMEOUT_SECONDS)
        if auth.code != 0:
            return CliStatus(
                False,
                f"Codex sem login na pasta do agente: rode `CODEX_HOME={self.cfg.codex_home} codex login --device-auth`",
                version,
            )
        feats = await self._run([binary, "features", "list"], stdin=b"", env=env, cwd=cwd, timeout=STATUS_TIMEOUT_SECONDS)
        names = frozenset(line.split()[0] for line in feats.stdout.decode("utf-8", "replace").splitlines() if line.split())
        return CliStatus(True, None, version, features=names)

    async def run(self, job: dict) -> dict:
        """Executa um pedido e devolve o corpo de /api/agent/llm/:id/result."""
        started = time.monotonic()
        provider = job.get("provider")
        try:
            if provider not in PROVIDERS:
                raise JobError(f"provedor desconhecido: {provider}")
            if job.get("model") and not MODEL_RE.match(str(job["model"])):
                raise JobError("modelo inválido")
            await self.refresh()
            status = self._status.get(provider)
            if not status or not status.available:
                raise JobError(status.reason if status else "CLI indisponível")
            output, usage = await self._execute(provider, job, status)
            body = {"ok": True, "output": output, "usage": usage, "durationMs": int((time.monotonic() - started) * 1000)}
            if len(json.dumps(body, ensure_ascii=False).encode()) > MAX_OUTPUT_BYTES:
                raise JobError("resposta grande demais")
            return body
        except JobError as err:
            log.warning("geração %s falhou: %s", provider, err)
            return {"ok": False, "error": str(err)[:1000]}
        except Exception as err:  # noqa: BLE001
            log.exception("erro inesperado na geração %s", provider)
            return {"ok": False, "error": f"falha interna do host-agent: {type(err).__name__}"}

    async def _execute(self, provider: str, job: dict, status: CliStatus) -> tuple[object, dict]:
        binary = find_binary(provider, getattr(self.cfg, f"{provider}_bin"))
        if not binary:
            raise JobError(f"{provider} não encontrado nesta máquina")
        timeout = float(job.get("timeoutSeconds") or 600)
        env = child_env(provider, self.cfg)
        with tempfile.TemporaryDirectory(prefix="agente-llm-") as tmp:
            workdir = Path(tmp)
            os.chmod(workdir, 0o700)
            if provider == "claude":
                cmd = build_claude_command(binary, job)
                stdin = job["user"].encode("utf-8")
            else:
                (workdir / "schema.json").write_text(json.dumps(job["schema"], ensure_ascii=False), encoding="utf-8")
                cmd = build_codex_command(binary, job, workdir, status.features)
                stdin = codex_prompt(job).encode("utf-8")
            result = await self._run(cmd, stdin=stdin, env=env, cwd=workdir, timeout=timeout)
            if result.timed_out:
                raise JobError(f"o {provider} passou de {int(timeout)} s")
            if provider == "claude":
                if result.code != 0 and not result.stdout.strip():
                    raise JobError(_tail(result.stderr) or f"claude saiu com código {result.code}")
                return parse_claude_output(result.stdout)
            last = workdir / "resposta.txt"
            text = last.read_text(encoding="utf-8") if last.exists() else ""
            if result.code != 0 and not text.strip():
                events_error = None
                try:
                    parse_codex_output("", result.stdout)
                except JobError as err:
                    events_error = str(err)
                raise JobError(events_error or _tail(result.stderr) or f"codex saiu com código {result.code}")
            return parse_codex_output(text, result.stdout)
