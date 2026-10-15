# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The window: a Chromium in application mode, or an honest tab.

What a test can say: which browser is chosen, the exact command line, the
identity the dock will see, the fallback, and that closing the window stops
the program. What it cannot -- that the dock shows the right icon -- is a check
by hand after install.sh.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from gdv.config import APP_ID
from gdv.window import WindowHost, find_browser, window_class


def fake_browser(tmp_path: Path, lifetime: str = "30") -> Path:
    """A 'browser' that records its arguments and then lives for a while."""
    script = tmp_path / "chromium"
    script.write_text(
        f'#!/bin/sh\nprintf "%s\\n" "$@" > "{tmp_path}/argv"\nexec sleep {lifetime}\n',
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def test_an_explicit_browser_wins(tmp_path):
    browser = fake_browser(tmp_path)
    assert find_browser(str(browser)) == [str(browser)]


def test_a_browser_that_is_not_there_is_not_invented(tmp_path):
    assert find_browser(str(tmp_path / "nessuno")) is None
    assert find_browser(candidates=(), flatpaks=()) is None


def test_the_identity_is_ours_and_not_any_local_app(tmp_path):
    expected = f"chrome-127.0.0.1__{APP_ID}-Default"
    assert window_class(["/usr/bin/google-chrome"]) == expected
    # The port never enters the identity: that is the whole point of the path.
    assert window_class(["/usr/bin/google-chrome"], f"http://127.0.0.1:9999/{APP_ID}") == expected
    assert window_class(["/usr/bin/chromium"]).startswith("chromium-")
    assert window_class(["/snap/bin/chromium"]).startswith("chromium_chromium-")
    assert window_class(["/usr/bin/flatpak", "run", "org.chromium.Chromium"]).startswith(
        "org.chromium.Chromium-"
    )


def test_the_window_is_a_chromium_in_application_mode(tmp_path, xdg_home):
    window = WindowHost(str(fake_browser(tmp_path)))
    window.open("http://127.0.0.1:8123/")
    try:
        assert window.mode == "app"
        for _ in range(100):
            if (tmp_path / "argv").exists():
                break
            time.sleep(0.02)
        argv = (tmp_path / "argv").read_text().split("\n")
        assert f"--app=http://127.0.0.1:8123/{APP_ID}" in argv
        assert any(a.startswith("--user-data-dir=") and "window-profile" in a for a in argv)
        assert any(a.startswith("--class=") for a in argv)
        assert "--no-first-run" in argv
    finally:
        window.close()
    assert not window.alive


def test_closing_the_window_stops_the_program(tmp_path, xdg_home):
    window = WindowHost(str(fake_browser(tmp_path, lifetime="0")))
    window.open("http://127.0.0.1:8123/")
    stop = threading.Event()
    window.watch(stop)
    assert stop.wait(5)


def test_with_no_chromium_it_falls_back_to_a_tab_and_says_so(monkeypatch, xdg_home):
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url) or True)
    window = WindowHost(None, candidates=(), flatpaks=())
    window.open("http://127.0.0.1:8123/")
    assert opened == ["http://127.0.0.1:8123/"]
    info = window.info()
    assert info["mode"] == "tab"
    assert "scheda" in info["note"]
    # Closing a tab is not a reliable signal: it must not stop the program.
    stop = threading.Event()
    window.watch(stop)
    assert not stop.wait(0.2)
