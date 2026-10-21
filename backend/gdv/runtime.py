# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Starting the program, and stopping it.

``__main__`` parses the command line; this is what the bare ``galleriadelvento`` does.
The order is fixed and every step depends on the one before:

1. take the lockfile -- which is also how a second launch finds the first and
   asks it for its window instead of starting a second program;
2. start the server in a background thread and wait until it answers. The
   window comes after, never before: a page loaded before the port listens
   shows an error and does not come back;
3. open the window and give it the main thread, then wait for one of the ways
   the program ends -- the window closed, "Esci" in the interface, SIGTERM or
   Ctrl+C. All of them set the same ``stop`` event;
4. on the way out close the window, stop the server and release the lock, in
   a ``finally`` that every exit path goes through.

The server always runs in a thread and the main thread always belongs to the
window (GTK insists on it) or to the wait. Uvicorn installs no signal handlers
off the main thread, so the program keeps control of its own shutdown.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import signal
import sys
import threading
from typing import Any

from . import safety, single_instance, winsupport
from .config import APP_ID, APP_NAME, Settings, env, get_settings
from .controls import AppControls
from .server import LocalServer

_log = logging.getLogger(__name__)

#: The log on file: what is left to read when a program started from the menu,
#: with no terminal, misbehaves. Three files of 1 MB at most.
LOG_BYTES = 1024 * 1024
LOG_BACKUPS = 2


def want_window(args: argparse.Namespace) -> bool:
    """Should this launch open a window?

    Yes by default -- the bare command is what the menu entry runs. ``--no-window``
    turns it off, and so does a session with no display at all (SSH);
    ``--window`` overrides that check for a session whose variables lie.
    Windows has no such variables, and a desktop session always has a screen.
    """
    if getattr(args, "no_window", False):
        return False
    if getattr(args, "window", False) or winsupport.WINDOWS:
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def configure_logging(settings: Settings, terminal_level: str | None) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    file_handler = logging.handlers.RotatingFileHandler(
        settings.log_dir / f"{APP_ID}.log",
        maxBytes=LOG_BYTES,
        backupCount=LOG_BACKUPS,
        encoding="utf-8",
        delay=True,
    )
    file_handler.setLevel(getattr(logging, settings.log_level, logging.INFO))
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(process)d %(levelname)s %(name)s: %(message)s")
    )
    terminal = logging.StreamHandler()
    terminal.setLevel(getattr(logging, terminal_level or "WARNING"))
    terminal.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root.addHandler(file_handler)
    root.addHandler(terminal)
    root.setLevel(min(file_handler.level, terminal.level))


def _install_signal_handlers(stop: threading.Event) -> None:
    def handler(signum: int, _frame: object) -> None:
        _log.info("segnale %s: chiusura", signal.Signals(signum).name)
        stop.set()

    signals = (
        winsupport.stop_signals()
        if winsupport.WINDOWS
        else (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    )
    for signum in signals:
        signal.signal(signum, handler)


def take_lock(settings: Settings, port: int, chosen: bool) -> single_instance.LockFile:
    """The lock, on the fixed port -- or, on Windows, on one it does not reserve.

    Windows reserves blocks of ports at boot (``winsupport``); unless the user
    chose the port, the program then moves to the one it took last time, or to
    any port Windows hands out, and remembers it (SPEC §25.8). Elsewhere, and
    for a port in use by another program, the error stands.
    """
    if not winsupport.WINDOWS or chosen:
        return single_instance.acquire(port)
    candidates = winsupport.port_candidates(settings.state_dir, port)
    for candidate in candidates[:-1]:
        try:
            return single_instance.acquire(candidate)
        except single_instance.PortReserved:
            _log.warning("porta %s riservata da Windows: provo la successiva", candidate)
        except single_instance.PortBusy:
            # The remembered port was the program's own pick: another program
            # may have it now. The fixed one taken by another program stays an error.
            if candidate == port:
                raise
            _log.warning("porta %s occupata da un altro programma: provo la successiva", candidate)
    return single_instance.acquire(candidates[-1])


def run(args: argparse.Namespace) -> int:
    settings = get_settings()
    settings.ensure_dirs()
    configure_logging(settings, args.log_level)
    port = args.port if args.port is not None else settings.port
    chosen = args.port is not None or env("PORT") is not None
    with_window = want_window(args)

    from .window import WindowHost

    try:
        lock = take_lock(settings, port, chosen)
    except single_instance.AlreadyRunning as exc:
        return _hand_over(exc.info, with_window)
    except single_instance.PortBusy as exc:
        _log.error("%s", exc)
        print(f"errore: {exc}", file=sys.stderr)
        return 2

    # Only after the lock: a second launch must not empty the first one's files.
    safety.empty_dir(settings.tmp_dir)

    stop = threading.Event()
    window: WindowHost | None = None
    url = ""

    def show_window() -> dict[str, Any]:
        nonlocal window
        if window is None:
            # Started with --no-window: a second launch still gets a window, on
            # this server, and closing it ends this program as usual.
            window = WindowHost(browser=getattr(args, "browser", None))
            window.open(url)
            window.watch(stop)
            return {"shown": True, "opened": True}
        return window.show()

    def window_info() -> dict[str, Any]:
        return window.info() if window is not None else {"mode": "none"}

    controls = AppControls(
        quit=stop.set,
        show_window=show_window,
        window_info=window_info,
    )
    server = LocalServer(controls, settings.host, port)
    try:
        bound = server.start()
    except OSError as exc:
        _log.error("impossibile avviare il server: %s", exc)
        print(f"errore: impossibile avviare il server: {exc}", file=sys.stderr)
        lock.release()
        return 2
    lock.update(port=bound)
    if winsupport.WINDOWS and not chosen:
        winsupport.remember_port(settings.state_dir, bound)
    url = f"http://{settings.host}:{bound}/"
    _log.info("server in ascolto su %s", url)
    _install_signal_handlers(stop)

    try:
        if with_window:
            window = WindowHost(browser=getattr(args, "browser", None) or settings.browser)
            window.open(url)
            print(f"{APP_NAME} in ascolto su {url}", flush=True)
            window.run(stop)
        else:
            print(f"{APP_NAME} in ascolto su {url}", flush=True)
            stop.wait()
    finally:
        if window is not None:
            window.close()
        server.stop()
        lock.release()
        _log.info("chiuso")
    return 0


def _hand_over(info: single_instance.LockInfo, with_window: bool) -> int:
    """A second launch: show the running program instead of starting another."""
    print(f"{APP_NAME} è già in esecuzione su {info.url}", flush=True)
    if not with_window:
        return 0
    if winsupport.WINDOWS:
        winsupport.allow_foreground()
    answer = single_instance.ask_to_show(info.port)
    if answer is None:
        print("l'istanza in esecuzione non ha risposto")
    elif answer.get("opened"):
        print("nuova finestra aperta sull'istanza in esecuzione")
    elif answer.get("shown"):
        print("finestra esistente portata in primo piano")
    else:
        print(answer.get("reason") or "la finestra non può essere mostrata")
    # Exiting non-zero from the menu icon would be a fault; not raising a window
    # is at most a nuisance, and it has been explained.
    return 0
