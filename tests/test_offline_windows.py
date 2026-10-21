# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 4 on Windows: no network from the window's browser (SPEC §25.4).

On Windows the window may be Edge, a browser the offline flags were never
checked on, with Microsoft services of its own. Unlike ``test_offline.py`` the
browser is not driven through playwright, which adds switches of its own that
would hide exactly that traffic: it is started with the *window's* argv, as the
program starts it, plus the recording proxy, and left open on the tunnel for
a while -- services that call home do it at start-up or soon after.

These run in the GitHub action on ``windows-latest``, which has both Chrome
and Edge; the hosts they record are what §25.4 has the user decide on.
"""

from __future__ import annotations

import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from apiclient import Api
from gdv import winsupport
from gdv.controls import AppControls
from gdv.server import STATIC_DIR, LocalServer
from gdv.window import CHROME_DISABLED_FEATURES, CHROME_OFFLINE_FLAGS, WindowHost
from synthetic import naca4
from test_offline import KNOWN_RESIDUAL, RecordingProxy, no_network  # noqa: F401 - fixture

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="serve Windows")

#: How long the window stays open behind the proxy.
IDLE_S = 90
BROWSERS = ("msedge.exe", "chrome.exe")

#: Names of §2.2 that a browser does not have, seen in the action (2026-10-21).
#: A feature the browser lacks cannot call home; if Edge does the same under
#: another name, the proxy of the test above records it.
ABSENT = {"msedge.exe": {"PreconnectToSearchDesktop"}}


def installed(name: str) -> Path | None:
    return next((p for p in winsupport.browser_paths() if p.name == name and p.is_file()), None)


def browser_library(executable: Path) -> Path | None:
    """Where the code is: ``<version>\\chrome.dll`` or ``msedge.dll`` next to the exe."""
    library = executable.with_suffix(".dll").name
    versions = sorted(
        (p for p in executable.parent.iterdir() if re.fullmatch(r"[\d.]+", p.name)),
        key=lambda p: tuple(int(n) for n in p.name.split(".")),
    )
    for folder in reversed(versions):
        if (folder / library).is_file():
            return folder / library
    return None


@pytest.mark.browser
@pytest.mark.parametrize("name", BROWSERS)
def test_4_no_network_from_the_window_on_windows(name, no_network, xdg_home):  # noqa: F811
    browser = installed(name)
    if browser is None:
        pytest.skip(f"{name} non installato")
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("interfaccia non costruita (cd frontend && npm run build)")
    server = LocalServer(AppControls(), "127.0.0.1", 0)
    port = server.start()
    status, created = Api(port).json(
        "POST",
        "/api/profiles",
        json_body={
            "name": "NACA 0012",
            "loops": [{"points": naca4("0012", 120).tolist()}],
            "source": {"kind": "editor"},
        },
    )
    assert status == 200, created
    proxy = RecordingProxy(port)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    tunnel = f"--app=http://127.0.0.1:{port}/galleria/profilo/{created['id']}"
    argv = [
        tunnel if arg.startswith("--app=") else arg
        for arg in WindowHost(str(browser)).argv(f"http://127.0.0.1:{port}/")
    ]
    argv += [f"--proxy-server=http://127.0.0.1:{proxy.server_address[1]}"]
    argv += ["--proxy-bypass-list=<-loopback>"]
    process = subprocess.Popen(argv)  # noqa: S603 - argv built here
    try:
        time.sleep(IDLE_S)
    finally:
        process.terminate()
        process.wait(30)
        proxy.shutdown()
        proxy.server_close()
        server.stop()
    # In the action's log whatever happens: these are what §25.4 decides on.
    print(f"{name}: {proxy.forwarded} richieste dell'app, estranee: {proxy.foreign}")
    assert proxy.forwarded > 10, "the app's traffic did not go through the proxy"
    unexpected = [r for r in proxy.foreign if r not in KNOWN_RESIDUAL]
    assert unexpected == [], "\n".join(unexpected)
    assert no_network == [], no_network


@pytest.mark.parametrize("name", BROWSERS)
def test_4_every_offline_name_exists_in_the_windows_browser(name):
    """As on Linux: an unknown feature or switch is ignored without a word, so
    each one must appear in the browser's code (SPEC §2.2)."""
    browser = installed(name)
    if browser is None:
        pytest.skip(f"{name} non installato")
    library = browser_library(browser)
    if library is None:
        pytest.skip(f"libreria del browser non trovata accanto a {browser}")
    data = library.read_bytes()
    redirects = [f[2:].split("=", 1)[0] for f in CHROME_OFFLINE_FLAGS if "127.0.0.1:9/" in f]
    missing = [n for n in (*CHROME_DISABLED_FEATURES, *redirects) if n.encode() not in data]
    print(f"{name} ({library.parent.name}): sconosciuti {missing}")
    unexpected = sorted(set(missing) - ABSENT.get(name, set()))
    assert unexpected == [], f"nomi sconosciuti a {name}: {unexpected}"
