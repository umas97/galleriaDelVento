# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The real program, started as the menu would start it (minus the window).

Each test runs ``python -m gdv --no-window`` in a temporary home, waits for
it to answer, and checks the ways it can end: "Esci", SIGTERM -- and that a
second launch behaves.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gdv.config import APP_ID

URL = re.compile(r"http://127\.0\.0\.1:(\d+)/(?:\?t=(\S+))?")


@pytest.fixture
def env(xdg_home: Path) -> dict[str, str]:
    environment = dict(os.environ)
    environment.update(
        XDG_DATA_HOME=str(xdg_home / "share"),
        XDG_STATE_HOME=str(xdg_home / "state"),
        XDG_RUNTIME_DIR=str(xdg_home / "run"),
        PYTHONUNBUFFERED="1",
    )
    environment.pop("DISPLAY", None)
    environment.pop("WAYLAND_DISPLAY", None)
    from conftest import free_port

    environment["GDV_PORT"] = str(free_port())
    return environment


def launch(env: dict[str, str]) -> tuple[subprocess.Popen[str], int, str | None]:
    process = subprocess.Popen(
        [sys.executable, "-m", "gdv", "--no-window"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    line = process.stdout.readline()
    match = URL.search(line)
    if match is None:
        process.kill()
        errors = process.stderr.read() if process.stderr else ""
        raise AssertionError(f"avvio fallito: {line!r} {errors}")
    return process, int(match.group(1)), match.group(2)


def call(port: int, path: str, token: str | None = None, method: str = "GET") -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=b"" if method == "POST" else None, method=method
    )
    if token:
        request.add_header("X-App-Token", token)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def test_it_starts_answers_and_quits_from_the_interface(env, xdg_home):
    process, port, token = launch(env)
    try:
        assert call(port, "/api/health")["app"] == APP_ID
        assert (xdg_home / "run" / f"{APP_ID}.lock").exists()
        call(port, "/api/app/quit", token, method="POST")
        assert process.wait(10) == 0
    finally:
        process.kill()
    assert not (xdg_home / "run" / f"{APP_ID}.lock").exists()


def test_sigterm_closes_it_cleanly(env, xdg_home):
    process, port, _ = launch(env)
    try:
        call(port, "/api/health")
        process.send_signal(signal.SIGTERM)
        assert process.wait(10) == 0
    finally:
        process.kill()
    assert not (xdg_home / "run" / f"{APP_ID}.lock").exists()


def test_a_second_launch_hands_over_and_exits(env):
    first, port, _ = launch(env)
    try:
        second = subprocess.run(
            [sys.executable, "-m", "gdv", "--no-window"],
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert second.returncode == 0
        assert "già in esecuzione" in second.stdout
        assert first.poll() is None
        assert call(port, "/api/health")["status"] == "ok"
    finally:
        first.terminate()
        first.wait(10)
