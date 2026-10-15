# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""``Profile2D`` → the solver's mask of solid cells: the reference (SPEC §10.3, test 10).

``frontend/src/sim2d/mask.ts`` does the same, step for step, and test 10 asks
the two to agree cell for cell. That is why this is written as plain scalar
arithmetic in a fixed order, with no clever vectorisation: every intermediate
is the same IEEE double in both languages.

Rule: a cell is solid when its centre lies inside at least one *outer* loop --
the union of the bodies, holes filled. Inside a loop is even-odd, along the
cell's row: the crossings ``c`` of the row's centre line with the loop's edges
(an edge counts when exactly one of its ends lies above the line), sorted, make
the cells with ``c[2m] <= x < c[2m+1]`` solid.

Which loops are outer: counter-clockwise ones for a saved profile (its
orientation is normalised), an even nesting depth for a live section.

Chamber frame: origin at the bottom-left corner, cell ``(i, j)`` (column, row)
has its centre at ``((i + 0.5) dx, (j + 0.5) dx)``; the mask is indexed
``[j, i]``. A profile point ``p`` sits at ``position + R(-incidence)(p - pivot)``
(see ``physics/planner.py``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Literal

import numpy as np

from .profile import loop_depths, signed_area

__all__ = ["outer_loops", "place", "rasterize"]

Point = tuple[float, float]


def outer_loops(
    loops: Sequence[Sequence[Point]], rule: Literal["orientation", "nesting"]
) -> list[list[Point]]:
    """The loops that bound solid bodies (holes are filled, SPEC §10.3)."""
    usable = [list(map(tuple, loop)) for loop in loops if len(loop) >= 3]
    if rule == "orientation":
        return [loop for loop in usable if signed_area(loop) > 0]
    depths = loop_depths([np.asarray(loop, dtype=np.float64) for loop in usable])
    return [loop for loop, depth in zip(usable, depths, strict=True) if depth % 2 == 0]


def place(
    loops: Sequence[Sequence[Point]], pivot: Point, position: Point, angle_deg: float
) -> list[list[Point]]:
    """Profile coordinates → chamber coordinates (incidence positive = nose up)."""
    a = -angle_deg * math.pi / 180
    c = math.cos(a)
    s = math.sin(a)
    px, py = pivot
    qx, qy = position
    out = []
    for loop in loops:
        placed = []
        for x, y in loop:
            dx = x - px
            dy = y - py
            placed.append((qx + (c * dx - s * dy), qy + (s * dx + c * dy)))
        out.append(placed)
    return out


def _first_at_or_after(c: float, dx: float, n: int) -> int:
    """The first column whose centre is >= c, clamped to [0, n]."""
    i = math.ceil(c / dx - 0.5)
    i = min(max(i, 0), n)
    while i > 0 and (i - 1 + 0.5) * dx >= c:
        i -= 1
    while i < n and (i + 0.5) * dx < c:
        i += 1
    return i


def rasterize(loops: Sequence[Sequence[Point]], nx: int, ny: int, dx: float) -> np.ndarray:
    """Solid cells (1) of the union of ``loops`` (chamber coordinates), shape (ny, nx)."""
    mask = np.zeros((ny, nx), dtype=np.uint8)
    for loop in loops:
        n = len(loop)
        if n < 3:
            continue
        rows: dict[int, list[float]] = {}
        for k in range(n):
            ax, ay = loop[k]
            bx, by = loop[(k + 1) % n]
            if ay == by:
                continue
            lo = min(ay, by)
            hi = max(ay, by)
            j0 = max(0, math.floor(lo / dx - 0.5))
            j1 = min(ny - 1, math.ceil(hi / dx - 0.5))
            for j in range(j0, j1 + 1):
                yc = (j + 0.5) * dx
                if (ay > yc) != (by > yc):
                    rows.setdefault(j, []).append(ax + (yc - ay) * (bx - ax) / (by - ay))
        for j, crossings in rows.items():
            crossings.sort()
            for m in range(0, len(crossings) - 1, 2):
                i0 = _first_at_or_after(crossings[m], dx, nx)
                i1 = _first_at_or_after(crossings[m + 1], dx, nx)
                if i1 > i0:
                    mask[j, i0:i1] = 1
    return mask
