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

import pytest

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


def test_4_the_window_argv_carries_the_offline_flags(tmp_path, xdg_home):
    """Test 4 (argv part): Chrome is told not to talk to the network (SPEC §2.2)."""
    from gdv.window import CHROME_OFFLINE_FLAGS

    argv = WindowHost(str(fake_browser(tmp_path))).argv("http://127.0.0.1:8853/")
    for flag in (
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-domain-reliability",
        "--disable-breakpad",
        "--no-pings",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        # Silences the "unsupported command-line flag" bar the two above raise.
        "--test-type",
    ):
        assert flag in argv
    assert set(CHROME_OFFLINE_FLAGS) <= set(argv)
    features = next(a for a in argv if a.startswith("--disable-features="))
    disabled = set(features.split("=", 1)[1].split(","))
    assert {
        "AutofillServerCommunication",
        "SafeBrowsingHashPrefixRealTimeLookups",
        "NetworkTimeServiceQuerying",
        "PreconnectToSearch",
        "PreconnectToSearchDesktop",
        "OptimizationHints",
        "OptimizationHintsFetchingSRP",
        "OptimizationGuideRemoteFetching",
        "OptimizationGuideProactivePersonalizedHintsFetching",
        "OptimizationGuideModelExecution",
    } <= disabled


def test_4_every_disabled_feature_exists_in_the_installed_chrome():
    """Chrome ignores unknown feature names silently: a rename in an update would turn a
    service back on. Each name must appear in the installed Chrome binary (SPEC §2.2)."""
    import shutil

    from gdv.window import CHROME_DISABLED_FEATURES

    found = shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    if found is None:
        pytest.skip("Google Chrome non trovato")
    binary = Path(found).resolve().parent / "chrome"
    if not binary.is_file():
        pytest.skip(f"binario di Chrome non trovato accanto a {found}")
    data = binary.read_bytes()
    missing = [name for name in CHROME_DISABLED_FEATURES if name.encode() not in data]
    assert missing == [], f"funzioni sconosciute a questo Chrome: {missing}"
