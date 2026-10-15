# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""A profile as DXF or SVG, to reuse it in CAD or Inkscape (SPEC §11.5).

The DXF is in metres (``$INSUNITS`` = 6), one closed ``LWPOLYLINE`` per loop.
The SVG is in millimetres (``width="…mm"`` and a viewBox in mm, y flipped),
one path with every loop and the even-odd rule, so holes show as holes. Both
come back through the importers as the same profile (test 11).
"""

from __future__ import annotations

import io
from xml.sax.saxutils import escape, quoteattr

import numpy as np

from .profile import ProfileDraft

__all__ = ["to_dxf", "to_svg"]

#: Blank border around the drawing, as a fraction of its size.
MARGIN = 0.05


def to_dxf(profile: ProfileDraft) -> bytes:
    import ezdxf

    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    msp = doc.modelspace()
    for loop in profile.loops:
        msp.add_lwpolyline(loop.points, close=True)
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue().encode("utf-8")


def _number(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def to_svg(profile: ProfileDraft) -> bytes:
    allp = np.concatenate([np.asarray(loop.points) for loop in profile.loops]) * 1000.0
    allp[:, 1] *= -1
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    pad = MARGIN * float(max(hi - lo) or 1.0)
    lo, hi = lo - pad, hi + pad
    w, h = hi - lo
    parts = []
    for loop in profile.loops:
        p = np.asarray(loop.points) * 1000.0
        coords = " L ".join(f"{_number(x)} {_number(-y)}" for x, y in p)
        parts.append(f"M {coords} Z")
    title = escape(profile.name)
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_number(w)}mm" '
        f'height="{_number(h)}mm" viewBox="{_number(lo[0])} {_number(lo[1])} '
        f'{_number(w)} {_number(h)}">\n'
        f"  <title>{title}</title>\n"
        f'  <path d={quoteattr(" ".join(parts))} fill="#c9ced8" fill-rule="evenodd" '
        'stroke="#111" stroke-width="0.2"/>\n'
        "</svg>\n"
    )
    return svg.encode("utf-8")
