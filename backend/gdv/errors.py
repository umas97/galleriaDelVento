# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Errors meant for the user (SPEC §15).

``message`` is an Italian sentence the interface shows as it is; ``technical`` is
what goes behind the collapsible "Dettagli". Never a traceback in a dialog.
"""

from __future__ import annotations

__all__ = ["AppError", "NewerSchemaError"]


class AppError(Exception):
    status = 400

    def __init__(self, message: str, technical: str = "", *, status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.technical = technical
        if status is not None:
            self.status = status


class NewerSchemaError(AppError):
    """A file written by a newer version: read it if possible, never write it (SPEC §14.2)."""

    status = 409

    def __init__(self, technical: str = "") -> None:
        super().__init__("Creato da una versione più recente di galleriaDelVento", technical)
