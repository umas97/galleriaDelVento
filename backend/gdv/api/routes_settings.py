# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Persistent settings over HTTP (SPEC §14.3), and the space the library takes (§12.1 #9).

``GET /api/settings`` gives every value and the defaults; ``PUT
/api/settings/{chiave}`` with ``{"value": ...}`` writes one key and gives every
value back. ``GET /api/settings/storage`` sums the library's folders.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .. import settings
from ..config import get_settings

__all__ = ["router"]

router = APIRouter(prefix="/api", tags=["settings"])

#: The library's folders, as SPEC §14.1 names them, in the order shown.
LIBRARY_FOLDERS = ("modelli", "profili", "foto", "disegni", "studi")


class SettingValue(BaseModel):
    value: Any


def _size(folder: Path) -> tuple[int, int]:
    """Bytes and files under ``folder``; symlinks are counted as links, never followed."""
    total = files = 0
    if not folder.is_dir():
        return 0, 0
    for root, _dirs, names in os.walk(folder):
        for name in names:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
                files += 1
            except OSError:
                continue
    return total, files


@router.get("/settings")
def read_settings() -> dict[str, Any]:
    return {"values": settings.load(), "defaults": settings.DEFAULTS}


@router.put("/settings/{key}")
def write_setting(key: str, body: SettingValue) -> dict[str, Any]:
    return {"values": settings.update(key, body.value), "defaults": settings.DEFAULTS}


@router.get("/settings/storage")
def storage() -> dict[str, Any]:
    data = get_settings().data_dir
    parts = []
    for name in LIBRARY_FOLDERS:
        size, files = _size(data / name)
        parts.append({"folder": name, "bytes": size, "files": files})
    return {
        "path": str(data),
        "parts": parts,
        "total_bytes": sum(p["bytes"] for p in parts),
    }
