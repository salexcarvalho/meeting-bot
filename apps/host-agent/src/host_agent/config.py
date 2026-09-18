"""Configuração do host-agent (~/.config/agente-reunioes/config.toml + .env do projeto)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .llm_runner import PROVIDERS, LlmCliConfig

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "agente-reunioes"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "agente-reunioes"
STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "agente-reunioes"


@dataclass(frozen=True)
class Config:
    backend_url: str
    agent_token: str
    """full = desktop (alertas + captura + geração); llm = só geração (container do servidor)"""
    mode: str
    spool_dir: Path
    state_dir: Path
    env_file: Path
    llm: LlmCliConfig = LlmCliConfig()


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _path(value: str | None) -> Path | None:
    return Path(os.path.expanduser(value)) if value else None


def load_llm_config(data: dict) -> LlmCliConfig:
    """Seção [llm] do config.toml (assinaturas pessoais: claude/codex)."""
    section = data.get("llm", {})
    raw = os.environ.get("AGENTE_LLM_ENABLED")
    listed = [p.strip() for p in raw.split(",")] if raw else section.get("enabled", PROVIDERS)
    enabled = tuple(p for p in listed if p in PROVIDERS)
    return LlmCliConfig(
        enabled=enabled,
        claude_bin=section.get("claude_bin", ""),
        codex_bin=section.get("codex_bin", ""),
        claude_config_dir=_path(section.get("claude_config_dir")),
        codex_home=_path(section.get("codex_home")) or CONFIG_DIR / "codex",
    )


def load_config(path: Path | None = None) -> Config:
    path = path or CONFIG_DIR / "config.toml"
    data: dict = {}
    if path.exists():
        with path.open("rb") as fh:
            data = tomllib.load(fh)

    env_file = Path(os.path.expanduser(data.get("env_file", ""))) if data.get("env_file") else None
    env = read_env_file(env_file) if env_file else {}

    host = env.get("BIND_ADDRESS", "127.0.0.1")
    if host in ("0.0.0.0", ""):
        host = "127.0.0.1"
    port = env.get("HOST_PORT", "3000")
    backend_url = os.environ.get("AGENTE_BACKEND_URL") or data.get("backend_url") or f"http://{host}:{port}"
    token = os.environ.get("AGENT_TOKEN") or env.get("AGENT_TOKEN", "")
    if len(token) < 32:
        raise SystemExit(
            f"AGENT_TOKEN não encontrado. Configure env_file em {path} apontando para o .env do projeto."
        )
    mode = (os.environ.get("AGENTE_MODE") or data.get("mode") or "full").strip().lower()
    if mode not in ("full", "llm"):
        raise SystemExit(f"AGENTE_MODE inválido: {mode!r} (use full ou llm)")
    return Config(
        backend_url=backend_url.rstrip("/"),
        agent_token=token,
        mode=mode,
        spool_dir=Path(os.path.expanduser(data.get("spool_dir", DATA_DIR / "spool"))),
        state_dir=Path(os.path.expanduser(data.get("state_dir", STATE_DIR))),
        env_file=env_file or Path(),
        llm=load_llm_config(data),
    )
