# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""SVG drawings into loops (SPEC §7.3).

``svgelements`` applies every transform and the viewBox and measures in CSS
pixels at 96 per inch. ``path``, ``polygon``, ``polyline``, ``rect``, ``circle``
and ``ellipse`` are read (``line`` cannot enclose anything); curves are
flattened within 0.05% of the drawing's size; an open stroke is closed when its
gap is below 0.5% of the size and discarded otherwise, and the caller says how
many were. SVG's y axis points down: it is flipped, so the loops come out in
pixels with y up.

When the root ``width`` carries a physical unit (``120mm``) the drawing's scale
is known; otherwise the user is asked for a real length.
"""

from __future__ import annotations

import io
import re

import numpy as np

from ..errors import AppError
from .drawing import Drawing
from .polylines import adaptive_flatten, chain

__all__ = ["parse_svg"]

#: Metres per physical unit. The scale is taken from the root width in these, not
#: from svgelements' own px-per-mm constant, which is rounded (3.7795296).
_UNIT_METRES = {
    "mm": 1e-3,
    "cm": 1e-2,
    "q": 0.25e-3,
    "in": 0.0254,
    "pt": 0.0254 / 72,
    "pc": 0.0254 / 6,
}
FLATTEN_FRACTION = 5e-4
CLOSE_GAP_FRACTION = 5e-3
_PHYSICAL = re.compile(r"^\s*([\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|q)\s*$", re.IGNORECASE)


def _not_svg(technical: str) -> AppError:
    return AppError("Il file non sembra un SVG valido", technical, status=422)


def parse_svg(data: bytes) -> Drawing:
    from svgelements import SVG, Close, Move, Path, Shape, SimpleLine

    try:
        svg = SVG.parse(io.BytesIO(data), reify=True, ppi=96)
    except Exception as exc:  # noqa: BLE001 - any parser failure is "not an SVG"
        raise _not_svg(f"{type(exc).__name__}: {exc}") from exc
    if not isinstance(svg, SVG):
        raise _not_svg("nessun elemento <svg> radice")

    paths = []
    for element in svg.elements():
        if isinstance(element, SimpleLine) or not isinstance(element, Shape):
            continue
        # Rotated rects and the like keep their transform even when reified.
        path = Path(element.segments(transformed=True))
        if len(path):
            paths.append(path)

    boxes = [p.bbox() for p in paths]
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        raise AppError("Il disegno non contiene forme", "nessun path, rect, circle, …", status=422)
    lo = np.min([[b[0], b[1]] for b in boxes], axis=0)
    hi = np.max([[b[2], b[3]] for b in boxes], axis=0)
    size = float(max(hi - lo))
    if not size > 0:
        raise AppError("Il disegno non contiene forme", "estensione nulla", status=422)
    tolerance = FLATTEN_FRACTION * size

    # svgelements puts the viewBox origin at (0, 0); put the drawing back where its
    # own coordinates say, so that an exported profile is re-imported in place.
    offset = 0j
    viewbox = getattr(svg, "viewbox", None)
    if viewbox is not None and viewbox.width and viewbox.height:
        offset = complex(
            viewbox.x * svg.width / viewbox.width, viewbox.y * svg.height / viewbox.height
        )

    loops: list[np.ndarray] = []
    discarded = 0
    for path in paths:
        for sub in path.as_subpaths():
            points: list[complex] = []
            closed = False
            for segment in sub:
                if isinstance(segment, Move):
                    if segment.end is not None:
                        points = [complex(segment.end.x, segment.end.y)]
                    continue
                if isinstance(segment, Close):
                    closed = True
                    continue
                if segment.start is None or segment.end is None:
                    continue
                if not points:
                    points = [complex(segment.start.x, segment.start.y)]

                def at(t: float, seg=segment) -> complex:
                    p = seg.point(t)
                    return complex(float(p.x), float(p.y))

                if type(segment).__name__ == "Line":
                    points.append(complex(segment.end.x, segment.end.y))
                else:
                    points.extend(adaptive_flatten(at, tolerance))
            if len(points) < 2:
                continue
            xy = np.array([[(z + offset).real, -(z + offset).imag] for z in points])
            if closed:
                xy = np.vstack([xy, xy[:1]])
            found, open_left = chain([xy], CLOSE_GAP_FRACTION * size)
            loops.extend(loop for loop in found if len(loop) >= 3)
            discarded += len(open_left)

    width = svg.values.get("width")
    match = _PHYSICAL.match(width) if isinstance(width, str) else None
    units, metres_per_px = None, None
    if match and svg.width:
        units = match.group(2).lower()
        metres_per_px = float(match.group(1)) * _UNIT_METRES[units] / float(svg.width)
    return Drawing(
        format="svg",
        loops=loops,
        open_discarded=discarded,
        units=units,
        metres_per_unit=metres_per_px,
        size=size,
    )
