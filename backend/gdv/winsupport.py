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
* the port: Hyper-V and WSL reserve blocks of 100 ports at boot, wherever the
  dynamic range starts -- on a school PC from 1036 up, 8853 included. The
  program then takes a port Windows hands out, which is never reserved, and
  remembers it, so that the window's origin stays the same (``runtime.py``);
* the GPU: on a laptop with two, Windows gives browsers the integrated one, and
  a page asking for the powerful one does not change that. While the program
  runs, the browser of the window gets the preference "high performance" in
  the user's registry -- what Settings -> Display -> Graphics writes -- and
  gets back what it had when the program ends; a choice the user made by
  hand is left alone. Two Chromium switches ask the same (``window.py``);
* the interface's media types: Python reads them from the registry, where
  programs often leave ``.js`` as ``text/plain`` -- and Chrome refuses a module
  script served as text, so the window would stay blank (``server.py``).

Only the standard library: ``ctypes`` and ``winreg``, imported inside the
functions, so that the module imports anywhere and the tests can exercise the
pure parts on Linux.
"""

from __future__ import annotations

import contextlib
import json
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
    "is_reserved",
    "port_candidates",
    "remember_port",
    "browser_paths",
    "find_browser",
    "fix_media_types",
    "prefer_dedicated_gpu",
    "restore_gpu_preference",
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

#: Asked of Chromium on Windows: the high-performance GPU for WebGL and for WebGPU.
GPU_FLAGS = (
    "--force-high-performance-gpu",
    "--use-webgpu-power-preference=default-high-performance",
)
#: Where Windows keeps each program's GPU preference: value name = executable,
#: data like "GpuPreference=2;" (2 is high performance).
GPU_PREFERENCES_KEY = r"Software\Microsoft\DirectX\UserGpuPreferences"
HIGH_PERFORMANCE = "GpuPreference=2;"
#: What the program changed, in the state folder, so that a crash is undone
#: at the next launch.
GPU_MARKER = "gpu-preferenza.json"

#: The bind error of a port Windows reserves (WSAEACCES).
_WSAEACCES = 10013
#: Where the port the program last took is kept, in the state folder.
PORT_FILE = "porta"

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


def is_reserved(error: OSError) -> bool:
    """Is this bind error Windows forbidding the port, not someone using it?"""
    return getattr(error, "winerror", None) == _WSAEACCES


def port_candidates(state_dir: Path, default: int) -> list[int]:
    """The ports to try, in order: the last one taken, the default, then any.

    0 lets Windows choose; it never hands out a port it reserves.
    """
    candidates = []
    try:
        remembered = int((state_dir / PORT_FILE).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        remembered = 0
    for port in (remembered, default, 0):
        if 0 < port < 65536 and port not in candidates:
            candidates.append(port)
    return [*candidates, 0]


def remember_port(state_dir: Path, port: int) -> None:
    """Keep the port taken, for the next launch."""
    from . import safety

    safety.atomic_write_bytes(state_dir / PORT_FILE, f"{port}\n".encode())


def _read_gpu_preference(executable: str) -> str | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, GPU_PREFERENCES_KEY) as key:
            value, _kind = winreg.QueryValueEx(key, executable)
    except OSError:
        return None
    return str(value)


def _write_gpu_preference(executable: str, value: str | None) -> None:
    """Set the preference, or remove it with ``None``."""
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, GPU_PREFERENCES_KEY) as key:
        if value is None:
            with contextlib.suppress(FileNotFoundError):
                winreg.DeleteValue(key, executable)
        else:
            winreg.SetValueEx(key, executable, 0, winreg.REG_SZ, value)


def prefer_dedicated_gpu(executable: str, state_dir: Path) -> None:
    """Give the browser the high-performance GPU until ``restore_gpu_preference``."""
    from . import safety

    restore_gpu_preference(state_dir)
    current = _read_gpu_preference(executable)
    if current is not None and "GpuPreference=" in current:
        return  # the user's own choice
    wanted = (current or "") + HIGH_PERFORMANCE
    marker = {"executable": executable, "original": current, "set": wanted}
    safety.atomic_write_json(state_dir / GPU_MARKER, marker)
    _write_gpu_preference(executable, wanted)
    _log.info("GPU ad alte prestazioni per %s finché il programma è aperto", executable)


def restore_gpu_preference(state_dir: Path) -> None:
    """Put back the preference the program changed, unless the user changed it since."""
    from . import safety

    path = state_dir / GPU_MARKER
    try:
        marker = json.loads(path.read_text(encoding="utf-8"))
        executable, original, wanted = marker["executable"], marker["original"], marker["set"]
    except (OSError, ValueError, KeyError, TypeError):
        return
    if _read_gpu_preference(executable) == wanted:
        _write_gpu_preference(executable, original)
        _log.info("preferenza della GPU di %s rimessa com'era", executable)
    safety.remove_file(path)


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
    """Where Chrome and Edge may be, best first.

    ``environ`` exists for the tests; with it the registry is not read, so that
    only the folders it names count.
    """
    registry = WINDOWS and environ is None
    environ = os.environ if environ is None else environ
    paths: list[Path] = []
    for executable in _EXECUTABLES:
        if registry:
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
