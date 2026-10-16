# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The PDF report (SPEC §11.6): the program's own report page, printed by Chrome.

The page (``/report/<id>``, React) is opened by the Chrome the window uses, in
headless mode, with the same anti-network flags (SPEC §2.2), a throw-away
profile and ``--print-to-pdf`` into a folder under the program's cache. The
URL carries a one-time token valid for 60 s: the page claims it and lays
itself out for paper. ``--virtual-time-budget`` lets the page fetch the study
and draw its charts before the print. The PDF is read back, the folder
removed, and the bytes go to the user as a download (SPEC §2.1 #4).
"""

from __future__ import annotations

import logging
import secrets
import subprocess
import threading
import time
import uuid

from .. import safety
from ..config import get_settings
from ..errors import AppError
from ..window import CHROME_OFFLINE_FLAGS, find_browser

__all__ = ["NO_CHROME", "ReportTokens", "render_pdf"]

_log = logging.getLogger(__name__)

NO_CHROME = "Serve Chrome o Chromium per il PDF"
TOKEN_SECONDS = 60.0
#: Virtual time the page gets to load the study and draw its charts, ms.
VIRTUAL_TIME_MS = 30_000
TIMEOUT_S = 120.0


class ReportTokens:
    """One-time tokens for the print URL, valid for 60 s."""

    def __init__(self, lifetime: float = TOKEN_SECONDS) -> None:
        self.lifetime = lifetime
        self._tokens: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def issue(self, study_id: str) -> str:
        token = secrets.token_urlsafe(16)
        now = time.monotonic()
        with self._lock:
            self._tokens = {k: v for k, v in self._tokens.items() if v[1] > now}
            self._tokens[token] = (study_id, now + self.lifetime)
        return token

    def claim(self, token: str) -> str | None:
        """The study the token was issued for, once; None if unknown, used or expired."""
        with self._lock:
            entry = self._tokens.pop(token, None)
        if entry is None or entry[1] < time.monotonic():
            return None
        return entry[0]


def chrome_argv(command: list[str], profile: str, output: str, url: str) -> list[str]:
    return [
        *command,
        "--headless=new",
        f"--user-data-dir={profile}",
        *CHROME_OFFLINE_FLAGS,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--run-all-compositor-stages-before-draw",
        f"--virtual-time-budget={VIRTUAL_TIME_MS}",
        "--no-pdf-header-footer",
        f"--print-to-pdf={output}",
        url,
    ]


def render_pdf(base_url: str, study_id: str, tokens: ReportTokens) -> bytes:
    """Print ``/report/<study_id>`` of the server at ``base_url`` to PDF bytes."""
    settings = get_settings()
    command = find_browser(settings.browser)
    if command is None:
        raise AppError(NO_CHROME, "nessun Chrome o Chromium trovato", status=409)
    folder = safety.make_dirs(settings.tmp_dir / f"report-{uuid.uuid4().hex}")
    try:
        output = folder / "report.pdf"
        token = tokens.issue(study_id)
        url = f"{base_url.rstrip('/')}/report/{study_id}?stampa={token}"
        argv = chrome_argv(command, str(folder / "profilo"), str(output), url)
        started = time.monotonic()
        try:
            run = subprocess.run(  # noqa: S603 - argv built here
                argv, capture_output=True, text=True, timeout=TIMEOUT_S, check=False
            )
        except subprocess.TimeoutExpired as exc:
            raise AppError("Chrome non ha finito il PDF in tempo", str(exc), status=504) from exc
        if not output.is_file() or output.stat().st_size == 0:
            raise AppError("Chrome non ha generato il PDF", (run.stderr or "")[-2000:], status=502)
        data = output.read_bytes()
        _log.info(
            "report PDF dello studio %s: %d byte in %.1f s",
            study_id,
            len(data),
            time.monotonic() - started,
        )
        return data
    finally:
        safety.remove_tree(folder)
