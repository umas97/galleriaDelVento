# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Imported SVG and DXF files, kept as they arrived (SPEC §2.1)::

    disegni/<sha256[:16]>.svg|dxf   the uploaded bytes, untouched
    disegni/<sha256[:16]>.json      original name and SHA-256

A profile made from a drawing records the SHA-256 and the scale in its source,
so the drawing can be read again. Re-importing the same bytes reuses the copy.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel

from .. import safety
from ..config import get_settings
from ..errors import AppError
from ..geometry.drawing import Drawing, to_draft
from ..geometry.dxf_import import parse_dxf
from ..geometry.svg_import import parse_svg
from .profiles import CheckResult, check

__all__ = ["DrawingInfo", "DrawingStore", "sniff_drawing"]

_log = logging.getLogger(__name__)

#: Drawings are small: 50 MB is already a very large SVG.
MAX_DRAWING_BYTES = 50 * 1024 * 1024
#: Points per loop sent for the preview in the import dialog.
PREVIEW_POINTS = 400


class DrawingInfo(BaseModel):
    """What the import dialog shows before the user picks the scale."""

    id: str
    format: Literal["svg", "dxf"]
    file_name: str
    loops: int
    open_discarded: int
    units: str | None
    metres_per_unit: float | None
    #: Extent along x and y, drawing units.
    extent: tuple[float, float]
    #: Loops thinned for drawing the preview, drawing units, y up.
    preview: list[list[tuple[float, float]]]


def sniff_drawing(data: bytes) -> Literal["svg", "dxf"]:
    head = data[:4096].decode("latin-1")
    if "<svg" in head.lower():
        return "svg"
    lines = [line.strip() for line in head.splitlines()]
    if any(a == "0" and b in ("SECTION", "EOF") for a, b in zip(lines, lines[1:], strict=False)):
        return "dxf"
    if data.startswith(b"AutoCAD Binary DXF"):
        return "dxf"
    raise AppError("Il file non è un SVG né un DXF", "contenuto non riconosciuto", status=422)


def _thin(loop: np.ndarray) -> list[tuple[float, float]]:
    step = max(1, len(loop) // PREVIEW_POINTS)
    return [(float(x), float(y)) for x, y in loop[::step]]


class DrawingStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or get_settings().data_dir / "disegni"
        self._lock = threading.Lock()

    def _files(self, drawing_id: str) -> tuple[Path, Path, Path]:
        if len(drawing_id) != 16 or any(c not in "0123456789abcdef" for c in drawing_id):
            raise FileNotFoundError("disegno inesistente")
        base = self.root / drawing_id
        return base.with_suffix(".svg"), base.with_suffix(".dxf"), base.with_suffix(".json")

    def _meta(self, drawing_id: str) -> dict[str, str]:
        meta = self._files(drawing_id)[2]
        if not meta.is_file():
            raise FileNotFoundError("disegno inesistente")
        return json.loads(meta.read_text(encoding="utf-8"))

    def _parse(self, drawing_id: str) -> tuple[Drawing, dict[str, str]]:
        meta = self._meta(drawing_id)
        svg, dxf, _ = self._files(drawing_id)
        data = (svg if meta["format"] == "svg" else dxf).read_bytes()
        drawing = parse_svg(data) if meta["format"] == "svg" else parse_dxf(data)
        return drawing, meta

    def import_bytes(self, data: bytes, file_name: str) -> DrawingInfo:
        kind = sniff_drawing(data)
        drawing = parse_svg(data) if kind == "svg" else parse_dxf(data)
        if not drawing.loops:
            raise AppError(
                "Il disegno non contiene contorni chiusi",
                f"{drawing.open_discarded} tratti aperti scartati",
                status=422,
            )
        sha = hashlib.sha256(data).hexdigest()
        drawing_id = sha[:16]
        svg, dxf, meta = self._files(drawing_id)
        with self._lock:
            if not meta.is_file():
                safety.make_dirs(self.root)
                safety.atomic_write_bytes(svg if kind == "svg" else dxf, data)
                safety.atomic_write_json(
                    meta,
                    {"format": kind, "file_name": Path(file_name).name, "sha256": sha},
                )
        _log.info(
            "disegno importato: %s (%s, %d anelli, %d tratti aperti scartati)",
            file_name,
            kind,
            len(drawing.loops),
            drawing.open_discarded,
        )
        return self._info(drawing_id, drawing, Path(file_name).name)

    def info(self, drawing_id: str) -> DrawingInfo:
        drawing, meta = self._parse(drawing_id)
        return self._info(drawing_id, drawing, meta["file_name"])

    @staticmethod
    def _info(drawing_id: str, drawing: Drawing, file_name: str) -> DrawingInfo:
        return DrawingInfo(
            id=drawing_id,
            format=drawing.format,
            file_name=file_name,
            loops=len(drawing.loops),
            open_discarded=drawing.open_discarded,
            units=drawing.units,
            metres_per_unit=drawing.metres_per_unit,
            extent=drawing.extent,
            preview=[_thin(loop) for loop in drawing.loops],
        )

    def draft(self, drawing_id: str, scale: float, name: str) -> CheckResult:
        """The drawing at ``scale`` metres per unit, checked; nothing is saved yet."""
        if not scale > 0:
            raise AppError("La scala deve essere positiva", f"scale={scale}")
        drawing, meta = self._parse(drawing_id)
        draft = to_draft(
            drawing, scale=scale, name=name, sha256=meta["sha256"], file_name=meta["file_name"]
        )
        return check(draft)
