# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The application window: a Chromium in ``--app`` mode.

The user must never see a browser. A Chromium started with ``--app=URL`` is a
window with no address bar, no tabs and no bookmarks; what this module adds is
what makes it behave like a desktop program rather than a stripped browser:

* a **dedicated profile** under ``$XDG_DATA_HOME``. Without it the window
  inherits the user's extensions, session and policies, and opens differently
  depending on whether their browser happened to be running;
* a **window identity of its own** -- what ``StartupWMClass`` in the menu entry
  points at. Without it the dock shows Chromium's icon, or another local app's
  (see :func:`window_class`);
* the browser process is a **child of this one**, so closing the window is a
  signal the program can act on, and "Esci" can close the window;
* a **fallback that says so**: with only Firefox there is no application mode,
  so the interface opens in an ordinary tab and explains, in one line, why it
  looks like a browser. Degraded, never mysterious.

On Windows the browser is found and raised by ``winsupport`` (SPEC §25.3);
``--class`` and ``--name`` mean nothing there and are ignored by Chrome.

This module never installs or downloads a browser.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import winsupport
from .config import APP_NAME, WINDOW_PATH, get_settings

__all__ = [
    "BROWSER_CANDIDATES",
    "FLATPAK_CANDIDATES",
    "WindowHost",
    "find_browser",
    "window_class",
]

_log = logging.getLogger(__name__)

#: Executables tried in order.
BROWSER_CANDIDATES: tuple[str, ...] = (
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
    "microsoft-edge",
)
#: The same browsers as Flatpak application ids, tried after the native ones.
FLATPAK_CANDIDATES: tuple[str, ...] = (
    "org.chromium.Chromium",
    "com.google.Chrome",
    "com.brave.Browser",
    "com.microsoft.Edge",
)
#: Size of a fresh window; the profile remembers it afterwards.
WINDOW_SIZE = "1280,860"

#: No network from Chrome itself (SPEC §2.2). The window, the headless PDF and
#: the browser tests all use this list. Checked on Google Chrome 155.
#: Chrome features that call home even with the switches below (see there).
CHROME_DISABLED_FEATURES: tuple[str, ...] = (
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
)

CHROME_OFFLINE_FLAGS: tuple[str, ...] = (
    # Service traffic in the background: variations seed, field trials, update
    # pings, the "is the network up" probes.
    "--disable-background-networking",
    # Component updater: CRLSets, Widevine, certificate-transparency lists...
    "--disable-component-update",
    # Google account sync.
    "--disable-sync",
    # Default web apps installed (and fetched) on a fresh profile.
    "--disable-default-apps",
    # Extensions and their update checks.
    "--disable-extensions",
    # Domain Reliability: reports of failed requests to Google.
    "--disable-domain-reliability",
    # Crash reporter uploads.
    "--disable-breakpad",
    # Hyperlink auditing pings (<a ping>).
    "--no-pings",
    # Metrics are recorded locally but never uploaded.
    "--metrics-recording-only",
    # Safe Browsing list downloads.
    "--safebrowsing-disable-auto-update",
    # Features that call home even with the flags above, each seen in a net-log
    # of Chrome 155 behind test 4's recording proxy (2026-10-15):
    # AutofillServerCommunication: form-type queries to content-autofill.googleapis.com;
    # SafeBrowsingHashPrefixRealTimeLookups: OHTTP key fetch from www.gstatic.com;
    # NetworkTimeServiceQuerying: clients2.google.com/time;
    # PreconnectToSearch(Desktop): sockets opened to www.google.com in advance;
    # the Optimization Guide (OptimizationHints and its fetching on search pages,
    # remote fetching, proactive personalised hints, remote model execution): calls to
    # optimizationguide-pa.googleapis.com, seen once in a full test run (2026-10-16).
    # Unknown names are ignored without a word: the test checks each one is in the
    # installed Chrome.
    "--disable-features=" + ",".join(CHROME_DISABLED_FEATURES),
    # Services no flag turns off, pointed at a dead loopback address. Port 9
    # (discard) is on Chrome's list of unsafe ports: the request fails before
    # any socket is opened. GAIA: the ListAccounts call of the account
    # reconciler; Google base URL: the "AI mode" eligibility fetch; component
    # and extension updates (beyond --disable-component-update, some still run).
    "--gaia-url=http://127.0.0.1:9/",
    "--google-base-url=http://127.0.0.1:9/",
    "--component-updater=url-source=http://127.0.0.1:9/",
    "--apps-gallery-update-url=http://127.0.0.1:9/",
    # GCM, the push channel of Chrome's own services: its check-in on
    # android.clients.google.com, seen behind test 4's proxy when a WebGPU page
    # (the 3D tunnel) runs on the real GPU (2026-10-20); registration and the
    # MCS connection would follow a check-in, so they are pointed away too.
    "--gcm-checkin-url=http://127.0.0.1:9/",
    "--gcm-registration-url=http://127.0.0.1:9/",
    "--gcm-mcs-endpoint=http://127.0.0.1:9/",
    # Left: the updater's "activity reporter" has its URL compiled in and no
    # switch. It shows up on some launches; the barrier below makes it fail on
    # DNS, and test 4 accepts that one host only (decision of 2026-10-15).
    # The final barrier: no name resolves except loopback, so anything the
    # flags above missed fails on DNS instead of leaving the machine.
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    # Not a network flag: --host-resolver-rules and --gaia-url are on Chrome's
    # list of "unsupported" switches, and each launch opened with a bar across
    # the window ("Stai utilizzando una segnalazione della riga di comando non
    # supportata..."). --test-type is what Chrome itself checks before showing
    # that bar (chromedriver passes it for the same reason). It stays in this
    # list so that test 4 runs Chrome with it and proves it adds no traffic.
    "--test-type",
)

TAB_NOTE = (
    winsupport.TAB_NOTE
    if winsupport.WINDOWS
    else f"Nessun browser compatibile con la finestra dedicata: {APP_NAME} è aperto in una "
    "scheda. Installa Chromium (sudo snap install chromium), oppure usa «Installa come "
    "app» dal menu del browser, per avere una finestra propria."
)

#: Chromium names app windows after its *own* desktop entry, which is not always
#: the executable's name. Anything not listed keeps its name.
_DESKTOP_BASE_NAMES = {
    "google-chrome": "chrome",
    "google-chrome-stable": "chrome",
    "chromium-browser": "chromium",
}


def find_browser(
    explicit: str | None = None,
    *,
    candidates: tuple[str, ...] | None = None,
    flatpaks: tuple[str, ...] | None = None,
) -> list[str] | None:
    """The argv prefix that runs a Chromium, or ``None`` if there is none.

    A list, so that a Flatpak (``flatpak run <id>``) and a binary look the same
    to the caller. ``candidates`` and ``flatpaks`` exist for the tests.
    """
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return [str(path)]
        resolved = shutil.which(explicit)
        if resolved:
            return [resolved]
        _log.warning("browser indicato non trovato: %s", explicit)
        return None
    if winsupport.WINDOWS and candidates is None:
        return winsupport.find_browser()
    for name in BROWSER_CANDIDATES if candidates is None else candidates:
        resolved = shutil.which(name)
        if resolved:
            return [resolved]
    flatpak = shutil.which("flatpak")
    if flatpak:
        for app_id in FLATPAK_CANDIDATES if flatpaks is None else flatpaks:
            probe = subprocess.run(  # noqa: S603 - fixed argv
                [flatpak, "info", app_id], capture_output=True, check=False
            )
            if probe.returncode == 0:
                return [flatpak, "run", app_id]
    return None


def _desktop_base_name(command: list[str] | None) -> str:
    if command is None:
        # No browser yet (install.sh on a bare machine): Chrome is the most
        # common, and --class makes X11 agree with whatever turns up later.
        return "chrome"
    if Path(command[0]).name == "flatpak" and len(command) >= 3:
        return command[2]
    name = Path(command[0]).name
    if Path(command[0]).parts[:2] == ("/", "snap"):
        return f"{name}_{name}"  # a snap's desktop entry is <snap>_<app>
    return _DESKTOP_BASE_NAMES.get(name, name)


def window_class(command: list[str] | None = None, url: str | None = None) -> str:
    """The identity the window gets, as the dock and the window manager see it.

    Under Wayland Chromium ignores ``--class`` and derives the identity from its
    own desktop name plus the *host and path* of the ``--app`` URL -- never the
    port. Every local app at ``http://127.0.0.1:<port>/`` would get the same
    identity, and the dock would give all of them the icon of whichever menu
    entry claimed it first. Hence ``WINDOW_PATH``: the window opens there, the
    server redirects it to ``/``, and the identity stays ours. For Chrome:
    ``chrome-127.0.0.1__galleriadelvento-Default``.

    install.sh writes this into ``StartupWMClass``; the window also gets it as
    ``--class`` so that an X11 session agrees.
    """
    if command is None:
        command = find_browser(get_settings().browser)
    parts = urlsplit(url or f"http://127.0.0.1{WINDOW_PATH}")
    app_name = f"{parts.hostname or ''}_{parts.path or '/'}"
    return f"{_desktop_base_name(command)}-{re.sub(r'[^A-Za-z0-9._-]', '_', app_name)}-Default"


def profile_dir() -> Path:
    """The window's own browser profile."""
    return get_settings().data_dir / "window-profile"


class WindowHost:
    """The window this process opened, and how.

    ``mode`` is ``app`` (dedicated window), ``tab`` (fallback, with ``note`` for
    the interface to show) or ``none`` (not opened yet).
    """

    def __init__(
        self,
        browser: str | None = None,
        *,
        candidates: tuple[str, ...] | None = None,
        flatpaks: tuple[str, ...] | None = None,
    ) -> None:
        self._command = find_browser(browser, candidates=candidates, flatpaks=flatpaks)
        self._lock = threading.Lock()
        self.process: subprocess.Popen[bytes] | None = None
        self.mode = "none"
        self.note: str | None = None
        self.url: str | None = None
        self._stop: threading.Event | None = None

    @property
    def pid(self) -> int | None:
        return self.process.pid if self.process is not None else None

    @property
    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def argv(self, url: str) -> list[str]:
        assert self._command is not None
        app_url = url.split("?", 1)[0].rstrip("/") + WINDOW_PATH
        wm_class = window_class(self._command, app_url)
        return [
            *self._command,
            f"--app={app_url}",
            f"--user-data-dir={profile_dir()}",
            f"--class={wm_class}",
            f"--name={wm_class}",
            f"--window-size={WINDOW_SIZE}",
            "--no-first-run",
            "--no-default-browser-check",
            *CHROME_OFFLINE_FLAGS,
            *(winsupport.GPU_FLAGS if winsupport.WINDOWS else ()),
        ]

    def open(self, url: str) -> None:
        """Open the interface: the dedicated window if possible, a tab if not."""
        with self._lock:
            self.url = url
            if self._command is not None:
                profile_dir().mkdir(parents=True, exist_ok=True)
                if winsupport.WINDOWS:
                    self._prefer_dedicated_gpu()
                try:
                    self.process = subprocess.Popen(  # noqa: S603 - argv built here, no shell
                        self.argv(url), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                except OSError as exc:
                    _log.warning("impossibile avviare %s: %s", self._command[0], exc)
                else:
                    self.mode, self.note = "app", None
                    _log.info("finestra aperta con %s", self._command[0])
                    return
            _log.info("nessun browser Chromium: apro una scheda del browser predefinito")
            try:
                webbrowser.open(url)
            except Exception as exc:  # noqa: BLE001 - a missing browser is not a crash
                _log.warning("nessun browser disponibile: %s", exc)
            self.mode, self.note, self.process = "tab", TAB_NOTE, None

    def watch(self, stop: threading.Event) -> None:
        """When the window closes, stop the program -- as any desktop program does.

        A tab is not watched: closing a tab is not a reliable sign that the user
        wants the program gone, so in tab mode it ends from "Esci" or a signal.
        """
        self._stop = stop
        process = self.process
        if process is None:
            return

        def wait() -> None:
            process.wait()
            if process is self.process:
                _log.info("finestra chiusa: chiudo il programma")
                stop.set()

        threading.Thread(target=wait, name="window", daemon=True).start()

    def run(self, stop: threading.Event) -> None:
        self.watch(stop)
        stop.wait()

    def show(self) -> dict[str, Any]:
        """A second launch asked for the window: raise it, or open a new one."""
        if not self.alive:
            if self.url is None:
                return {"shown": False, "reason": "nessuna finestra da mostrare"}
            self.open(self.url)
            if self._stop is not None:
                self.watch(self._stop)
            return {"shown": True, "opened": True, "mode": self.mode}
        if self._raise():
            return {"shown": True}
        if winsupport.WINDOWS:
            return {"shown": False, "reason": winsupport.WINDOW_HIDDEN}
        return {
            "shown": False,
            "reason": "la finestra è già aperta: cercala fra le finestre "
            "(installa wmctrl o xdotool perché venga portata in primo piano)",
        }

    def _raise(self) -> bool:
        """Bring the window forward with wmctrl or xdotool, when either exists.

        Under Wayland neither can reach a native window; the caller then says
        where the window is instead of opening a second one.
        """
        if winsupport.WINDOWS:
            return winsupport.raise_window(self.pid)
        wm_class = window_class(self._command)
        for tool, argv in (
            ("wmctrl", ["-x", "-a", wm_class]),
            ("xdotool", ["search", "--class", wm_class, "windowactivate", "%1"]),
        ):
            path = shutil.which(tool)
            if path is None:
                continue
            result = subprocess.run([path, *argv], capture_output=True, check=False)  # noqa: S603
            if result.returncode == 0:
                return True
        return False

    def _prefer_dedicated_gpu(self) -> None:
        assert self._command is not None
        try:
            winsupport.prefer_dedicated_gpu(self._command[0], get_settings().state_dir)
        except OSError as exc:  # a registry that refuses is not a reason not to open
            _log.warning("preferenza della GPU non impostata: %s", exc)

    def info(self) -> dict[str, Any]:
        return {"mode": self.mode, "note": self.note, "window_pid": self.pid}

    def close(self, timeout: float = 5.0) -> None:
        """Close the window: politely first, then not."""
        if winsupport.WINDOWS:
            try:
                winsupport.restore_gpu_preference(get_settings().state_dir)
            except OSError as exc:
                _log.warning("preferenza della GPU non rimessa com'era: %s", exc)
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
