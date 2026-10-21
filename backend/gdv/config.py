# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Settings, and where things live on disk.

Everything the program writes goes under the XDG base directories of the user
running it -- never next to the files it works on, never inside the source tree:

* ``$XDG_DATA_HOME/galleriadelvento/`` -- the user's data, what a backup must keep;
* ``$XDG_STATE_HOME/galleriadelvento/logs/`` -- the log;
* ``$XDG_CONFIG_HOME/galleriadelvento/`` -- the persistent settings;
* ``$XDG_CACHE_HOME/galleriadelvento/tmp/`` -- temporary files, emptied at start-up;
* ``$XDG_RUNTIME_DIR/galleriadelvento.lock`` -- the single-instance lock. That
  directory is a tmpfs emptied at logout, so a lock can never outlive a reboot.

Every value can be overridden with a ``GDV_*`` environment variable, and
the XDG variables are honoured: the tests run the whole program inside a
temporary home that way.

On Windows the same folders sit under ``%LOCALAPPDATA%\\galleriadelvento\\``
(``dati``, ``stato``, ``config``, ``cache``; the lock in ``stato``), unless an
XDG variable says otherwise (SPEC §25.3).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from . import winsupport

APP_ID = "galleriadelvento"
APP_NAME = "galleriaDelVento"
DESCRIPTION = "Galleria del vento 2D in tempo reale per sezioni, schizzi e profili"
ENV_PREFIX = "GDV_"

#: Fixed, because the window's origin includes the port: another port is
#: another site to the browser, with its own storage and its own PWA install.
#: If it is taken the program says so and stops; it never wanders to another.
#: Except on Windows, when Windows itself reserves it (SPEC §25.8): see winsupport.
DEFAULT_PORT = 8853

#: Where the window opens. The server redirects it to ``/``; the path exists only
#: to give the window an identity in the dock that no other local app shares
#: (``window.py`` explains why the port cannot do that).
WINDOW_PATH = f"/{APP_ID}"


def env(name: str) -> str | None:
    """``GDV_<name>`` from the environment, or ``None``."""
    return os.environ.get(ENV_PREFIX + name) or None


def _xdg(variable: str, fallback: str, windows: str) -> Path:
    raw = os.environ.get(variable)
    if not raw and winsupport.WINDOWS:
        return winsupport.local_app_data() / APP_ID / windows
    base = Path(raw).expanduser() if raw else Path.home() / fallback
    return base / APP_ID


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    log_level: str
    data_dir: Path
    state_dir: Path
    config_dir: Path
    cache_dir: Path
    runtime_dir: Path
    browser: str | None

    @property
    def log_dir(self) -> Path:
        return self.state_dir / "logs"

    @property
    def tmp_dir(self) -> Path:
        return self.cache_dir / "tmp"

    @property
    def lock_path(self) -> Path:
        return self.runtime_dir / f"{APP_ID}.lock"

    @property
    def writable_roots(self) -> tuple[Path, ...]:
        """The only places the program may write into (see ``safety.py``)."""
        return (self.data_dir, self.state_dir, self.config_dir, self.cache_dir)

    def ensure_dirs(self) -> None:
        """Create the directories the program writes into."""
        for path in (self.data_dir, self.log_dir, self.config_dir, self.tmp_dir):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    state = _xdg("XDG_STATE_HOME", ".local/state", "stato")
    return Settings(
        # Loopback, and deliberately not a setting: there is no option to expose
        # the program to the network, so no one can turn it on by mistake.
        host="127.0.0.1",
        port=int(env("PORT") or DEFAULT_PORT),
        log_level=(env("LOG_LEVEL") or "INFO").upper(),
        data_dir=_xdg("XDG_DATA_HOME", ".local/share", "dati"),
        state_dir=state,
        config_dir=_xdg("XDG_CONFIG_HOME", ".config", "config"),
        cache_dir=_xdg("XDG_CACHE_HOME", ".cache", "cache"),
        runtime_dir=Path(runtime) if runtime else state,
        browser=env("BROWSER"),
    )
