# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""What the API may ask of the program around it.

The server never imports the window or the runtime: it is handed these
callbacks. That keeps the dependency one-way (runtime -> server, runtime ->
window) and lets the tests hand the server fakes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


def _no_window() -> dict[str, Any]:
    return {"mode": "none"}


@dataclass
class AppControls:
    #: "Esci": stop everything. ``None`` when nobody owns the process (a test, a
    #: bare uvicorn), and then the API refuses instead of half-stopping.
    quit: Callable[[], None] | None = None
    #: A second launch asks for the window through this.
    show_window: Callable[[], dict[str, Any]] | None = None
    #: What the interface is being shown in. The UI reads it to explain itself.
    window_info: Callable[[], dict[str, Any]] = field(default=_no_window)
    #: Session token every ``/api`` call must carry. ``None`` disables the check.
    token: str | None = None
