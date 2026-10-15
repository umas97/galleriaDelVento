# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared fixtures: a temporary home for every test, and a live server.

Every test runs with the XDG directories pointed at a temporary folder, so no
test can read or write the real user's data, lock or log.
"""

from __future__ import annotations

import http.client
import json
import socket
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from gdv.config import get_settings
from gdv.controls import AppControls
from gdv.server import LocalServer


@pytest.fixture(autouse=True)
def xdg_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    home = tmp_path / "home"
    for variable, sub in (
        ("XDG_DATA_HOME", "share"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_RUNTIME_DIR", "run"),
        ("XDG_CONFIG_HOME", "config"),
    ):
        (home / sub).mkdir(parents=True)
        monkeypatch.setenv(variable, str(home / sub))
    for name in ("PORT", "LOG_LEVEL", "BROWSER"):
        monkeypatch.delenv(f"GDV_{name}", raising=False)
    get_settings.cache_clear()
    yield home
    get_settings.cache_clear()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@dataclass
class Recorder:
    """Fake controls that remember what the API asked of them."""

    calls: list[str] = field(default_factory=list)
    token: str | None = None

    def controls(self) -> AppControls:
        return AppControls(
            quit=lambda: self.calls.append("quit"),
            show_window=lambda: self.calls.append("show") or {"shown": True},
            window_info=lambda: {"mode": "app", "note": None},
            token=self.token,
        )


@dataclass
class Live:
    """A running server and a small client that can forge headers."""

    port: int
    recorder: Recorder
    static: Path

    def request(
        self,
        method: str,
        path: str,
        *,
        host: str | None = None,
        origin: str | None = None,
        token: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if origin is not None:
            headers["Origin"] = origin
        if token is not None:
            headers["X-App-Token"] = token
        connection.request(method, path, body=b"" if method == "POST" else None, headers=headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body

    def json(self, method: str, path: str, **kwargs: Any) -> tuple[int, Any]:
        status, _headers, body = self.request(method, path, **kwargs)
        return status, json.loads(body)


def start_live(tmp_path: Path, token: str | None = None) -> tuple[Live, LocalServer]:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>shell</title>", encoding="utf-8")
    (static / "assets" / "app-1234.js").write_text("console.log(1)", encoding="utf-8")
    recorder = Recorder(token=token)
    server = LocalServer(recorder.controls(), "127.0.0.1", 0, static_dir=static)
    port = server.start()
    return Live(port, recorder, static), server


@pytest.fixture
def live(tmp_path: Path) -> Iterator[Live]:
    running, server = start_live(tmp_path)
    yield running
    server.stop()


@pytest.fixture
def live_with_token(tmp_path: Path) -> Iterator[Live]:
    running, server = start_live(tmp_path, token="segreto")
    yield running
    server.stop()
