# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""install.sh and uninstall.sh, in a home directory of their own.

What an automated test can say: the command, the icons and the menu entry land
where the desktop looks for them, the entry is valid and its StartupWMClass is
the window's identity; running the installer twice changes nothing;
uninstalling removes exactly that, and the user's data only after an explicit
"sì" typed on a terminal. What it cannot say -- that the dock shows the right
icon and name -- is a check by hand.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from gdv.config import APP_ID, APP_NAME

REPO = Path(__file__).resolve().parents[1]
INSTALL = REPO / "install.sh"
UNINSTALL = REPO / "uninstall.sh"

pytestmark = pytest.mark.skipif(
    not (REPO / "backend/gdv/static/index.html").is_file()
    or not (REPO / f".venv/bin/{APP_ID}").exists()
    or not (REPO / f"packaging/icons/{APP_ID}.svg").is_file()
    or shutil.which("uv") is None,
    reason="servono .venv, le icone, l'interfaccia (costruita) e uv",
)


def _env(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("XDG_") and k != "VIRTUAL_ENV"}
    env.update(
        HOME=str(home),
        GDV_INSTALL_SKIP_SYNC="1",
        GDV_INSTALL_SKIP_FRONTEND="1",
    )
    return env


def _run(script: Path, home: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script)],
        env=_env(home),
        capture_output=True,
        text=True,
        timeout=120,
        stdin=subprocess.DEVNULL,
        check=False,
    )


def _entry(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "[Desktop Entry]"
    return dict(line.split("=", 1) for line in lines[1:] if "=" in line)


def _installed(home: Path) -> list[Path]:
    share = home / ".local/share"
    return [
        home / f".local/bin/{APP_ID}",
        share / f"applications/{APP_ID}.desktop",
        *(share / f"icons/hicolor/{s}x{s}/apps/{APP_ID}.png" for s in (48, 128, 256)),
        share / f"icons/hicolor/scalable/apps/{APP_ID}.svg",
    ]


def test_install_puts_an_application_in_the_menu_and_again_changes_nothing(tmp_path):
    home = tmp_path / "casa"
    home.mkdir()
    first = _run(INSTALL, home)
    assert first.returncode == 0, first.stderr + first.stdout
    assert f"{APP_NAME} installato" in first.stdout
    for path in _installed(home):
        assert path.is_file(), path

    entry = _entry(home / f".local/share/applications/{APP_ID}.desktop")
    assert entry["Name"] == APP_NAME
    assert entry["Icon"] == APP_ID
    assert entry["Exec"] == str(home / f".local/bin/{APP_ID}")
    from gdv.window import window_class

    assert entry["StartupWMClass"] == window_class()

    snapshot = {p: p.read_bytes() for p in _installed(home)}
    second = _run(INSTALL, home)
    assert second.returncode == 0, second.stderr
    assert {p: p.read_bytes() for p in _installed(home)} == snapshot


def test_install_refuses_to_overwrite_a_command_it_did_not_write(tmp_path):
    home = tmp_path / "casa"
    foreign = home / f".local/bin/{APP_ID}"
    foreign.parent.mkdir(parents=True)
    foreign.write_text("#!/bin/sh\necho altro\n", encoding="utf-8")
    result = _run(INSTALL, home)
    assert result.returncode != 0
    assert "non l'ha scritto install.sh" in result.stderr
    assert "altro" in foreign.read_text(encoding="utf-8")


def test_uninstall_removes_what_was_installed_and_keeps_the_data(tmp_path):
    home = tmp_path / "casa"
    home.mkdir()
    assert _run(INSTALL, home).returncode == 0
    data = home / f".local/share/{APP_ID}"
    data.mkdir(parents=True)
    (data / "importante.txt").write_text("dati", encoding="utf-8")

    result = _run(UNINSTALL, home)
    assert result.returncode == 0, result.stderr
    for path in _installed(home):
        assert not path.exists(), path
    # No terminal to ask on: the data stays, and the user is told how to remove it.
    assert (data / "importante.txt").is_file()
    assert "i dati restano" in result.stdout
