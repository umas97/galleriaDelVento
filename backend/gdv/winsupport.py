# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""What Windows does differently (SPEC §25).

The program is written for Linux; this module is the only place that knows
about Windows. The other modules call it behind one ``if WINDOWS`` each, so on
Linux none of this runs and nothing there changes:

* folders: everything under ``%LOCALAPPDATA%\\galleriadelvento\\`` -- Local, not
  Roaming, because a roaming profile would copy models of up to 500 MB at every
  logon (``config.py``);
* the browser: Chrome or Edge from where they install, since neither is on the
  PATH (``window.py``), and bringing its window forward (no wmctrl here);
* whether a PID is alive: ``os.kill(pid, 0)`` does not ask that on Windows --
  0 is ``CTRL_C_EVENT``, so it would send a Ctrl+C (``single_instance.py``);
* the stop signals: there is no ``SIGHUP`` (``runtime.py``);
* the interface's media types: Python reads them from the registry, where
  programs often leave ``.js`` as ``text/plain`` -- and Chrome refuses a module
  script served as text, so the window would stay blank (``server.py``).

Only the standard library: ``ctypes`` and ``winreg``, imported inside the
functions, so that the module imports anywhere and the tests can exercise the
pure parts on Linux.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import signal
import sys
from pathlib import Path

__all__ = [
    "TAB_NOTE",
    "WINDOWS",
    "WINDOW_HIDDEN",
    "allow_foreground",
    "browser_paths",
    "find_browser",
    "fix_media_types",
    "local_app_data",
    "pid_alive",
    "raise_window",
    "stop_signals",
]

_log = logging.getLogger(__name__)

WINDOWS = sys.platform == "win32"

TAB_NOTE = (
    "Nessun browser compatibile con la finestra dedicata: il programma è aperto in una "
    "scheda. Installa Microsoft Edge o Google Chrome per avere una finestra propria."
)

#: Why the window could not be brought forward, for the second launch.
WINDOW_HIDDEN = "la finestra è già aperta: cercala nella barra delle applicazioni"

#: Executables looked up in the registry's App Paths, in order of preference:
#: Chrome first, the browser the offline flags were checked on (SPEC §2.2).
_EXECUTABLES = ("chrome.exe", "msedge.exe")

#: Where the installers put them, relative to the folders named by these variables.
_CHROME = ("Google", "Chrome", "Application", "chrome.exe")
_EDGE = ("Microsoft", "Edge", "Application", "msedge.exe")
_INSTALL_PATHS = (
    ("PROGRAMFILES", _CHROME),
    ("PROGRAMFILES(X86)", _CHROME),
    ("LOCALAPPDATA", _CHROME),
    ("PROGRAMFILES(X86)", _EDGE),
    ("PROGRAMFILES", _EDGE),
    ("LOCALAPPDATA", _EDGE),
)

#: The types of what the interface is made of, whatever the registry says.
MEDIA_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".wasm": "application/wasm",
}

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259
_ERROR_ACCESS_DENIED = 5
_SW_RESTORE = 9
_ASFW_ANY = 0xFFFFFFFF


def local_app_data() -> Path:
    """``%LOCALAPPDATA%``, or where it is on a standard install when unset."""
    raw = os.environ.get("LOCALAPPDATA")
    return Path(raw) if raw else Path.home() / "AppData" / "Local"


def fix_media_types() -> None:
    """Serve the interface with its real types, over the registry's."""
    for extension, media_type in MEDIA_TYPES.items():
        mimetypes.add_type(media_type, extension)


def stop_signals() -> tuple[signal.Signals, ...]:
    """The signals that end the program. ``SIGBREAK`` is Ctrl+Break in a console."""
    return (signal.SIGTERM, signal.SIGINT, signal.SIGBREAK)


def _registered(executable: str) -> list[Path]:
    """The paths the installers registered under App Paths (per user, then machine)."""
    import winreg

    found = []
    key_path = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, key_path) as key:
                value, _kind = winreg.QueryValueEx(key, None)
        except OSError:
            continue
        if value:
            found.append(Path(str(value).strip('"')))
    return found


def browser_paths(environ: dict[str, str] | None = None) -> list[Path]:
    """Where Chrome and Edge may be, best first. ``environ`` exists for the tests."""
    environ = os.environ if environ is None else environ
    paths: list[Path] = []
    for executable in _EXECUTABLES:
        if WINDOWS:
            paths.extend(_registered(executable))
        for variable, parts in _INSTALL_PATHS:
            base = environ.get(variable)
            if base and parts[-1] == executable:
                paths.append(Path(base).joinpath(*parts))
    unique: list[Path] = []
    for path in paths:
        if path not in unique:
            unique.append(path)
    return unique


def find_browser(environ: dict[str, str] | None = None) -> list[str] | None:
    """The argv prefix that runs Chrome or Edge, or ``None`` if neither is installed."""
    for path in browser_paths(environ):
        if path.is_file():
            return [str(path)]
    return None


def pid_alive(pid: int) -> bool:
    """Is there a running process with this PID?"""
    if pid <= 0:
        return False
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # Someone else's process: alive, not ours. ``server_responds`` decides.
        return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == _STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def allow_foreground() -> None:
    """Let the running instance raise its window.

    Windows lets only the foreground process -- here, the second launch the user
    just clicked -- bring a window forward, unless it passes that right on.
    """
    import ctypes

    ctypes.WinDLL("user32").AllowSetForegroundWindow(_ASFW_ANY)


def raise_window(pid: int | None) -> bool:
    """Bring forward the visible top-level window of the process ``pid``."""
    if pid is None:
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd: int, _lparam: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(visit, 0)
    if not found:
        return False
    hwnd = found[0]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, _SW_RESTORE)
    if user32.SetForegroundWindow(hwnd):
        return True
    _log.info("Windows non ha concesso il primo piano alla finestra")
    return False
