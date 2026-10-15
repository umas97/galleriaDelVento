# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Open strokes into closed loops: shared by the SVG and DXF importers (SPEC §7.3, §7.4).

A drawing is a heap of pieces -- a DXF profile is often a LINE, then an ARC, then
another LINE -- and only their endpoints say which piece follows which. Every
endpoint is matched to the nearest free endpoint within ``join_tol`` (closest
pairs first), which links the pieces into paths and cycles: a cycle is a loop,
a path stays open and the caller reports it.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np

__all__ = ["adaptive_flatten", "chain"]


def adaptive_flatten(
    point: Callable[[float], complex], tolerance: float, depth: int = 14
) -> list[complex]:
    """Points along a curve ``point(t)``, t in [0, 1], within ``tolerance`` of the chords.

    Bisection on flatness, checked at the middle and at the quarters so that an
    S-shaped piece does not pass for a straight line; every curve is split at
    least four times, so neither does a full circle, whose chord has zero
    length. The first point is not included, the last is.
    """
    out: list[complex] = []

    def flat(t0: float, p0: complex, t1: float, p1: complex, pm: complex) -> bool:
        if abs(pm - (p0 + p1) / 2) > tolerance:
            return False
        q1, q3 = point((3 * t0 + t1) / 4), point((t0 + 3 * t1) / 4)
        return abs(q1 - (3 * p0 + p1) / 4) <= tolerance and abs(q3 - (p0 + 3 * p1) / 4) <= tolerance

    def recurse(t0: float, p0: complex, t1: float, p1: complex, level: int) -> None:
        tm = (t0 + t1) / 2
        pm = point(tm)
        if level >= depth or (level >= 2 and flat(t0, p0, t1, p1, pm)):
            out.append(p1)
            return
        recurse(t0, p0, tm, pm, level + 1)
        recurse(tm, pm, t1, p1, level + 1)

    recurse(0.0, point(0.0), 1.0, point(1.0), 0)
    return out


def chain(
    pieces: Sequence[np.ndarray], join_tol: float
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Join pieces end to end. Returns (closed loops, open chains).

    Loops do not repeat their first point at the end. A piece whose own two
    ends meet is a loop by itself.
    """
    from scipy.spatial import cKDTree

    parts = [np.asarray(p, dtype=np.float64) for p in pieces if len(p) >= 2]
    if not parts:
        return [], []
    # Endpoint 2k is the start of piece k, 2k+1 its end.
    n = len(parts)
    ends = np.empty((2 * n, 2))
    ends[0::2] = [p[0] for p in parts]
    ends[1::2] = [p[-1] for p in parts]
    pairs = cKDTree(ends).query_pairs(join_tol, output_type="ndarray")
    if len(pairs):
        dist = np.hypot(*(ends[pairs[:, 0]] - ends[pairs[:, 1]]).T)
        pairs = pairs[np.argsort(dist, kind="stable")]
    mate = np.full(2 * n, -1, dtype=np.int64)
    for a, b in pairs:
        if mate[a] < 0 and mate[b] < 0:
            mate[a], mate[b] = b, a

    def walk(start_end: int) -> tuple[list[np.ndarray], bool]:
        """Follow the pieces entering piece ``start_end // 2`` at ``start_end``."""
        out: list[np.ndarray] = []
        entry = start_end
        while True:
            k = entry // 2
            seen[k] = True
            piece = parts[k] if entry % 2 == 0 else parts[k][::-1]
            out.append(piece if not out else piece[1:])
            exit_end = entry ^ 1
            nxt = int(mate[exit_end])
            if nxt < 0:
                return out, False
            if nxt == start_end:
                return out, True
            if seen[nxt // 2]:
                return out, False  # pragma: no cover - a matching cannot revisit a piece
            entry = nxt

    seen = np.zeros(n, dtype=bool)
    loops: list[np.ndarray] = []
    open_chains: list[np.ndarray] = []
    # Paths first, from their free ends; whatever is left over is made of cycles.
    for e in range(2 * n):
        if mate[e] < 0 and not seen[e // 2]:
            segments, _ = walk(e)
            open_chains.append(np.concatenate(segments))
    for k in range(n):
        if not seen[k]:
            segments, closed = walk(2 * k)
            points = np.concatenate(segments)
            if closed and len(points) >= 4:
                loops.append(points[:-1])  # the last point repeats the first
            elif not closed:  # pragma: no cover - see walk()
                open_chains.append(points)
    return loops, open_chains
