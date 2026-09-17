"""Modo do agente: full (desktop) x llm (container do servidor)."""

from __future__ import annotations

import pytest

from host_agent import config as cfg_mod

TOKEN = "t" * 40


def _load(tmp_path, monkeypatch, toml: str = "", **env):
    monkeypatch.setenv("AGENT_TOKEN", TOKEN)
    for key in ("AGENTE_MODE", "AGENTE_LLM_ENABLED", "AGENTE_BACKEND_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    path = tmp_path / "config.toml"
    path.write_text(toml, encoding="utf-8")
    return cfg_mod.load_config(path)


def test_modo_padrao_e_desktop(tmp_path, monkeypatch):
    cfg = _load(tmp_path, monkeypatch)
    assert cfg.mode == "full"
    assert cfg.llm.enabled == ("claude", "codex")


def test_modo_llm_por_variavel_com_so_um_cli(tmp_path, monkeypatch):
    cfg = _load(tmp_path, monkeypatch, AGENTE_MODE="llm", AGENTE_LLM_ENABLED="claude")
    assert cfg.mode == "llm"
    assert cfg.llm.enabled == ("claude",)


def test_modo_pelo_config_toml(tmp_path, monkeypatch):
    cfg = _load(tmp_path, monkeypatch, toml='mode = "llm"\n')
    assert cfg.mode == "llm"


def test_modo_invalido_para_o_agente(tmp_path, monkeypatch):
    with pytest.raises(SystemExit, match="AGENTE_MODE inválido"):
        _load(tmp_path, monkeypatch, AGENTE_MODE="grava-tudo")
