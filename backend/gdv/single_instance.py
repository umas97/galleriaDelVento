# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""One running program at a time.

The lockfile in ``$XDG_RUNTIME_DIR`` holds the server's PID and port. That is
enough to answer the questions a second launch asks, in this order:

1. is there a lockfile, and is the process it names alive? A file naming a dead
   PID is stale -- the program was killed, or crashed -- and is removed without
   ceremony;
2. does that process answer on its port, *as this program*? PIDs are recycled,
   and refusing to start because an unrelated process inherited the number would
   be a bug the user could not diagnose. The health check names the app, so
   another of the user's local programs on the same port is not mistaken for us;
3. then the second launch is a request to *see* the program, not to start it
   again: it asks the running instance to show its window, and exits 0.

Nothing here uses ``fcntl`` locks. An advisory lock dies with its file
descriptor, so after a crash it cannot answer question 1 -- the only question
that matters.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import socket
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from . import winsupport
from .config import APP_ID, APP_NAME, get_settings

__all__ = [
    "AlreadyRunning",
    "LockFile",
    "LockInfo",
    "PortBusy",
    "acquire",
    "ask_to_show",
    "read_lock",
    "server_responds",
]

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class LockInfo:
    pid: int
    port: int
    started_at: float = 0.0

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"


class AlreadyRunning(RuntimeError):
    """An instance of ours is up. Carries the lock so the caller can talk to it."""

    def __init__(self, info: LockInfo) -> None:
        super().__init__(f"{APP_NAME} è già in esecuzione su {info.url}")
        self.info = info


class PortBusy(RuntimeError):
    """The port is taken by something that is not us."""

    def __init__(self, port: int) -> None:
        super().__init__(
            f"la porta {port} è occupata da un altro programma; usa --port per sceglierne un'altra"
        )
        self.port = port


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if winsupport.WINDOWS:
        return winsupport.pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Someone else's process: alive, not ours. ``server_responds`` decides.
        return True
    except OSError as exc:  # pragma: no cover - defensive
        return exc.errno != errno.ESRCH
    return True


def read_lock(path: Path | None = None) -> LockInfo | None:
    """The lockfile's content, or ``None`` if absent or unreadable.

    A truncated file can only come from a crash between open and write; refusing
    to start over it would leave a program that will not launch, with no reason.
    """
    target = path or get_settings().lock_path
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        return LockInfo(
            pid=int(payload["pid"]),
            port=int(payload["port"]),
            started_at=float(payload.get("started_at", 0.0)),
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def server_responds(port: int, *, timeout: float = 1.0) -> bool:
    """Does *this program* answer on that port?"""
    if port <= 0:
        return False
    try:
        with urllib.request.urlopen(  # noqa: S310 - loopback, fixed scheme
            f"http://127.0.0.1:{port}/api/health", timeout=timeout
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False
    return payload.get("status") == "ok" and payload.get("app") == APP_ID


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # On Windows SO_REUSEADDR binds even over a listening socket: the probe
        # would always say "free". Exclusive use is what fails when it is taken.
        option = socket.SO_EXCLUSIVEADDRUSE if winsupport.WINDOWS else socket.SO_REUSEADDR
        sock.setsockopt(socket.SOL_SOCKET, option, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


@dataclass
class LockFile:
    """The lock this process holds. Released on exit, and only by its owner."""

    path: Path
    info: LockInfo

    def update(self, **fields: Any) -> None:
        self.info = replace(self.info, **fields)
        self._write()

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Written whole, then moved into place: a reader never sees half a file.
        temporary = self.path.with_suffix(".lock.tmp")
        temporary.write_text(json.dumps(asdict(self.info)), encoding="utf-8")
        temporary.replace(self.path)

    def release(self) -> None:
        """Remove the lockfile, unless another process has taken it over since."""
        current = read_lock(self.path)
        if current is not None and current.pid != self.info.pid:
            return
        self.path.unlink(missing_ok=True)


def acquire(port: int, *, path: Path | None = None) -> LockFile:
    """Take the lock for this process.

    Args:
        port: the port about to be bound; 0 if the kernel will choose, in which
            case the caller writes the real one with ``update(port=...)``.
        path: the lockfile. Tests override it; nothing else should.

    Raises:
        AlreadyRunning: an instance of ours is up and answering.
        PortBusy: the fixed port is taken by a process that is not ours.
    """
    target = path or get_settings().lock_path
    existing = read_lock(target)
    if existing is not None:
        if _pid_alive(existing.pid) and server_responds(existing.port):
            raise AlreadyRunning(existing)
        _log.info("lockfile stantio (pid %s): lo rimuovo", existing.pid)
        target.unlink(missing_ok=True)

    if port and not port_is_free(port):
        if server_responds(port):
            # Ours, but the lockfile was deleted under a live server.
            raise AlreadyRunning(LockInfo(pid=0, port=port))
        raise PortBusy(port)

    lock = LockFile(target, LockInfo(pid=os.getpid(), port=port, started_at=time.time()))
    lock._write()
    return lock


def ask_to_show(port: int, *, timeout: float = 30.0) -> dict[str, Any] | None:
    """Ask the running instance to show its window. ``None`` if it cannot be asked."""
    request = urllib.request.Request(  # noqa: S310 - loopback, fixed scheme
        f"http://127.0.0.1:{port}/api/window/show", data=b"", method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return dict(json.loads(response.read().decode("utf-8")))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None
