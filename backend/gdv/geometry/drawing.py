# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""What an SVG or DXF importer hands over: loops in drawing units, y up.

The scale is applied later, when the user has confirmed it (SPEC §7.3, §7.4):
:func:`to_draft` turns a drawing into a ``ProfileDraft`` in metres. The
drawing's own coordinates are kept (no re-centring), so a profile exported and
imported again lands where it was.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from .profile import DrawingSource, ProfileDraft, from_arrays

__all__ = ["Drawing", "clean_loop", "to_draft"]

#: Consecutive points closer than this fraction of the drawing's size merge.
DUPLICATE_FRACTION = 1e-9


@dataclass
class Drawing:
    format: Literal["svg", "dxf"]
    #: Closed loops in drawing units, y up, last point not repeated.
    loops: list[np.ndarray]
    #: Open strokes that could not be closed and were left out.
    open_discarded: int
    #: Units the file declares (``mm``, ``in``...), or ``None``.
    units: str | None
    #: Metres per drawing unit when the file says, else ``None`` (ask the user).
    metres_per_unit: float | None
    #: Largest extent of the drawing, in drawing units.
    size: float

    def __post_init__(self) -> None:
        eps = DUPLICATE_FRACTION * self.size
        cleaned = (clean_loop(loop, eps) for loop in self.loops)
        self.loops = [loop for loop in cleaned if loop is not None]

    @property
    def extent(self) -> tuple[float, float]:
        if not self.loops:
            return 0.0, 0.0
        allp = np.concatenate(self.loops)
        w, h = allp.max(axis=0) - allp.min(axis=0)
        return float(w), float(h)


def clean_loop(points: np.ndarray, eps: float) -> np.ndarray | None:
    """Drop consecutive duplicates (also last-first); ``None`` if fewer than 3 remain."""
    p = np.asarray(points, dtype=np.float64)
    keep = [0]
    for i in range(1, len(p)):
        if np.hypot(*(p[i] - p[keep[-1]])) > eps:
            keep.append(i)
    while len(keep) > 1 and np.hypot(*(p[keep[-1]] - p[keep[0]])) <= eps:
        keep.pop()
    return p[keep] if len(keep) >= 3 else None


def to_draft(
    drawing: Drawing, *, scale: float, name: str, sha256: str, file_name: str
) -> ProfileDraft:
    """The drawing in metres, as a profile draft (not validated yet)."""
    source = DrawingSource(
        kind=drawing.format,
        sha256=sha256,
        file_name=file_name,
        scale=scale,
        units=drawing.units,
    )
    return from_arrays([loop * scale for loop in drawing.loops], name=name, source=source)
