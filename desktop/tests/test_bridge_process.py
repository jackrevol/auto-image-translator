from __future__ import annotations

from pathlib import Path

import pytest

from zip_translator.bridge_process import (
    _embedded_runtime_paths,
    _url_port,
    load_or_create_integrated_token,
)


def test_url_port_accepts_only_local_bridge_addresses() -> None:
    assert _url_port("http://127.0.0.1:39473") == 39473
    assert _url_port("http://localhost:38473") == 38473
    with pytest.raises(ValueError):
        _url_port("https://example.com:38473")


def test_integrated_token_is_persistent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    first = load_or_create_integrated_token()
    second = load_or_create_integrated_token()

    assert first == second
    assert len(first) == 48
    assert (tmp_path / "ImageKoreanTranslator" / "bridge-token.txt").read_text(
        encoding="utf-8"
    ).strip() == first


def test_development_runtime_finds_node_and_bridge_server() -> None:
    node_path, server_path = _embedded_runtime_paths()

    assert node_path.is_file()
    assert server_path.name == "server.js"
    assert server_path.is_file()
