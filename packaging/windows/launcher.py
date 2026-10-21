# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""What ``galleriaDelVento.exe`` runs (SPEC §25.3).

The executable has no console, so ``sys.stdout`` and ``sys.stderr`` are
``None`` and whatever the program would print is lost -- a taken port, a
server that does not start, a crash. Here stdout goes nowhere on purpose,
stderr is kept in memory, and if the program ends with an error what it wrote
is shown in a Windows message box with the log's folder. On a clean exit
nothing is shown.

It lives outside the ``gdv`` package: only the frozen program needs it.
"""

from __future__ import annotations

import io
import logging
import os
import sys

#: The end of stderr is what explains the error; a message box has no scrollbar.
SHOWN_CHARS = 1500
_MB_ICONERROR = 0x10


def show_error(text: str) -> None:
    import ctypes

    from gdv.config import APP_NAME, get_settings

    detail = text.strip()[-SHOWN_CHARS:] or "errore sconosciuto"
    message = f"{detail}\n\nIl registro è in:\n{get_settings().log_dir}"
    ctypes.WinDLL("user32").MessageBoxW(None, message, APP_NAME, _MB_ICONERROR)


def main() -> int:
    captured = io.StringIO()
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115 - for the whole run
    if sys.stderr is None:
        sys.stderr = captured
    try:
        from gdv.__main__ import main as run

        code = run()
    except SystemExit as exc:  # argparse, on a wrong option
        code = exc.code if isinstance(exc.code, int) else 2
    except Exception:  # noqa: BLE001 - shown to the user, then the exit code says it
        # Into the log file and, through the terminal handler (or logging's last
        # resort, before the log is set up), into ``captured``.
        logging.getLogger("gdv").exception("errore inatteso")
        code = 1
    if code and sys.stderr is captured:
        show_error(captured.getvalue())
    return code or 0


if __name__ == "__main__":
    sys.exit(main())
