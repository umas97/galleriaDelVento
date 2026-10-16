# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Step 3 of the sketch (SPEC §8.4): from the ink mask to smooth closed outlines.

The stroke is a line, not a filled shape. The paper it encloses is found by
filling from outside: paper pixels connected (4-connectivity, so the fill
cannot slip through a diagonal stroke) to the sheet's border are outside;
every other connected piece of paper is an enclosed *region*.

The outline must fall on the middle of the stroke, not on its inner edge. The
stroke is split between the region and what lies beyond it with two distance
transforms: an ink pixel goes to the region when it is at least as close to
the region as to any other paper. That is the region grown outward by half
the local stroke width, measured where the stroke actually is -- a hand
stroke varies from 3 to 6 pixels, and a single global offset would not follow
it.

The pixel outline is then smoothed with a periodic smoothing spline
(``splprep``, «Morbidezza») and resampled at :data:`OUTLINE_POINTS` points,
denser where it bends.

No closed region larger than 1% of the sheet means the stroke is open: the
two free ends nearest to each other are reported with their distance, found
as the far ends of the stroke along its own pixels (geodesic distance).
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

__all__ = [
    "OUTLINE_POINTS",
    "OUTSIDE",
    "STROKE",
    "Gap",
    "Region",
    "find_gap",
    "find_corners",
    "distance_to",
    "find_regions",
    "is_closed",
    "open_outline",
    "region_outline",
    "smooth_loop",
    "stroke_half_width",
]

#: Points of every smoothed outline (SPEC §8.4).
OUTLINE_POINTS = 400
#: A region must cover this fraction of the sheet to count as a closed outline.
MIN_CLOSED = 0.01
#: Regions smaller than this are not offered at all (inside of letters, specks).
MIN_REGION = 0.0025
#: At most this many regions are offered, the largest.
MAX_REGIONS = 20
#: A corner turns by more than this over 1% of the perimeter (as in fit.ts).
CORNER_DEG = 50
#: ...and still turns by most of it over a stretch this many times shorter.
CORNER_SHORT = 8


@dataclass
class Region:
    label: int
    #: Area as a fraction of the sheet.
    fraction: float
    #: A point well inside the region (pixels): where it is farthest from its edge.
    seed: tuple[float, float]
    #: Bounding box x, y, w, h (pixels).
    box: tuple[int, int, int, int]


@dataclass
class Gap:
    a: tuple[float, float]
    b: tuple[float, float]
    #: Distance between the two ends, pixels.
    length: float


def distance_to(mask: np.ndarray) -> np.ndarray:
    """Euclidean distance (pixels) from every pixel to the nearest pixel of ``mask``."""
    return cv2.distanceTransform((~mask).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)


#: Labels of :func:`find_regions`: the stroke, the paper outside; regions from 2.
STROKE, OUTSIDE = 0, 1


def find_regions(ink: np.ndarray, weld: float = 0.0) -> tuple[np.ndarray, list[Region]]:
    """Labels of the sheet, and its enclosed regions, largest first.

    The enclosure is decided on the ink dilated by ``weld`` pixels, where gaps
    in the stroke up to twice that are bridged; each region is then grown back
    by the same amount, up to the real stroke (across a gap it bulges out by
    about d²/8·weld, a gentle curve). Every pixel is labelled :data:`STROKE`,
    :data:`OUTSIDE` or a region's label. The stroke includes the enclosed
    pockets too small to be offered: where a wobbly stroke touches itself it
    pinches off such a pocket, which is part of the line, not a shape. It also
    includes the paper of a shape thinner than the weld (the tail of a profile).
    """
    h, w = ink.shape
    welded = distance_to(ink) <= weld
    count, parts, stats, _ = cv2.connectedComponentsWithStats(
        (~welded).astype(np.uint8), connectivity=4
    )
    border = np.unique(np.concatenate([parts[0], parts[-1], parts[:, 0], parts[:, -1]]))
    outside = np.zeros(count, bool)
    outside[border] = True
    outside[0] = True  # label 0 is the (welded) ink
    labels = np.full((h, w), STROKE, np.int32)
    regions: list[Region] = []
    for part in np.argsort(-stats[:, cv2.CC_STAT_AREA]):
        if outside[part] or len(regions) >= MAX_REGIONS:
            continue
        if stats[part, cv2.CC_STAT_AREA] < MIN_REGION * h * w / 4:
            break  # smaller still once grown back by a thin rim: not offered
        x, y, bw, bh = (int(v) for v in stats[part, :4])
        pad = int(np.ceil(weld)) + 2
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
        core = parts[y0:y1, x0:x1] == part
        grown = (distance_to(core) <= weld + 1) & ~ink[y0:y1, x0:x1]
        grown &= labels[y0:y1, x0:x1] == STROKE
        area = int(grown.sum())
        if area < MIN_REGION * h * w:
            continue
        label = len(regions) + 2
        labels[y0:y1, x0:x1][grown] = label
        depth = cv2.distanceTransform(np.pad(core.astype(np.uint8), 1), cv2.DIST_L2, 3)
        sy, sx = np.unravel_index(int(np.argmax(depth)), depth.shape)
        box = cv2.boundingRect(grown.astype(np.uint8))
        regions.append(
            Region(
                label,
                area / (h * w),
                (float(x0 + sx - 1), float(y0 + sy - 1)),
                (x0 + box[0], y0 + box[1], box[2], box[3]),
            )
        )
    regions.sort(key=lambda r: -r.fraction)
    # The paper left over: what touches the border is outside, the rest is stroke.
    rest = (labels == STROKE) & ~ink
    _, pieces = cv2.connectedComponents(rest.astype(np.uint8), connectivity=4)
    edge = np.unique(np.concatenate([pieces[0], pieces[-1], pieces[:, 0], pieces[:, -1]]))
    touching = np.isin(pieces, edge[edge > 0])
    labels[touching] = OUTSIDE
    return labels, regions


def stroke_half_width(ink: np.ndarray) -> float:
    """Half the typical width of the stroke, pixels, from the distance transform:
    its mean along the stroke's ridge (local maxima). A stroke w pixels wide
    peaks at about (w + 1) / 2 there."""
    depth = cv2.distanceTransform(ink.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    ridge = ink & (depth >= cv2.dilate(depth, np.ones((3, 3), np.uint8))) & (depth > 0)
    if not ridge.any():
        return 0.5
    return max(0.5, float(np.mean(depth[ridge])))


def region_outline(
    ink: np.ndarray, labels: np.ndarray, region: Region, half_width: float
) -> np.ndarray:
    """The region's outline on the middle of its stroke, pixels, as traced (not smoothed).

    Each ink pixel goes to the region when it is at least as close to it as to
    any other paper: the stroke splits along its middle line wherever it is,
    whatever its local width. Closing the gaps also fills the thin parts of
    the shape narrower than the gaps (the tail of a profile): there the region
    stops short, and the split would lose the tail and shorten the shape. So
    the pixels farther than half a stroke from the other paper are added too:
    the filled tail is such ink. Past the end of the region, where the two
    strokes of a sharp edge merge, three quarters of half a stroke suffice.
    The trace runs through pixel centres; :func:`smooth_loop` corrects that.
    """
    h, w = ink.shape
    x, y, bw, bh = region.box
    # The stroke around the region, and a filled tail past its end, lie within this.
    pad = max(16, int(0.12 * w))
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
    crop_labels = labels[y0:y1, x0:x1]
    crop_ink = crop_labels == STROKE  # the stroke and its pinched pockets
    inside = crop_labels == region.label
    other = ~crop_ink & ~inside
    if x0 > 0 or y0 > 0 or x1 < w or y1 < h:
        # Beyond the crop lies the paper outside the stroke: keep it as such.
        other[0], other[-1], other[:, 0], other[:, -1] = True, True, True, True
    to_inside = distance_to(inside)
    to_other = distance_to(other)
    # Where two strokes merge before meeting at a sharp edge, the shape between
    # their middle lines gets thinner than a pixel and the tail would break off at
    # the neck: away from the region (beyond a stroke's width) a lower bar holds it.
    tail = (to_other > 0.75 * half_width) & (to_inside > 2 * half_width)
    body = inside | (crop_ink & ((to_inside <= to_other) | (to_other > half_width) | tail))
    _, parts = cv2.connectedComponents(body.astype(np.uint8), connectivity=8)
    sx, sy = round(region.seed[0]) - x0, round(region.seed[1]) - y0
    shape = (parts == parts[sy, sx]).astype(np.uint8)
    contours, _ = cv2.findContours(shape, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    best = max(contours, key=cv2.contourArea)
    return best.reshape(-1, 2).astype(np.float64) + [x0, y0]


def _turning(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Absolute turn (radians) at ``b`` going from ``a`` to ``c``, row by row."""
    u, v = b - a, c - b
    return np.abs(np.arctan2(u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0], (u * v).sum(axis=1)))


def _at(points: np.ndarray, cum: np.ndarray, s: np.ndarray) -> np.ndarray:
    """Points at arc lengths ``s`` along the closed polyline (``cum`` from the first)."""
    total = cum[-1]
    s = np.mod(s, total)
    closed = np.concatenate([points, points[:1]])
    return np.stack([np.interp(s, cum, closed[:, 0]), np.interp(s, cum, closed[:, 1])], 1)


def find_corners(points: np.ndarray) -> list[int]:
    """Sharp corners of a closed outline, the rule of «Rendi modificabile» (fit.ts):
    a turn above :data:`CORNER_DEG` over 1% of the perimeter, still large over a
    stretch :data:`CORNER_SHORT` times shorter (a round nose turns less and less as
    the stretch shrinks, a corner does not), and the largest within 1%."""
    p = np.asarray(points, np.float64)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*(np.roll(p, -1, axis=0) - p).T))])
    h = cum[-1] * 0.01
    # Shorter stretches than a few pixels see the staircase of the trace, not the shape.
    short = max(h / CORNER_SHORT, 3.0)
    s = cum[:-1]
    wide = _turning(_at(p, cum, s - h), p, _at(p, cum, s + h))
    narrow = _turning(_at(p, cum, s - short), p, _at(p, cum, s + short))
    limit = np.radians(CORNER_DEG)
    candidates = np.flatnonzero((wide > limit) & (narrow >= 0.6 * wide))
    corners: list[int] = []
    for i in candidates[np.argsort(-wide[candidates], kind="stable")]:
        gap = np.abs(s[corners] - s[i])
        if (np.minimum(gap, cum[-1] - gap) >= h).all():
            corners.append(int(i))
    return sorted(corners)


def _fit(points: np.ndarray, sigma: float, periodic: bool):
    """A smoothing spline through ``points``, allowed to stray ``sigma`` on average.

    An open piece keeps its two ends (heavy weights): they are corners.
    """
    from scipy.interpolate import splprep

    k = min(3, len(points) - 1)
    if periodic:
        closed = np.concatenate([points, points[:1]])
        smooth = len(points) * sigma**2
        tck, _ = splprep([closed[:, 0], closed[:, 1]], s=smooth, per=1, k=k, quiet=2)
        return tck
    weights = np.ones(len(points))
    weights[[0, -1]] = 100.0
    tck, _ = splprep(
        [points[:, 0], points[:, 1]], w=weights, s=len(points) * sigma**2, k=k, quiet=2
    )
    return tck


def smooth_loop(
    points: np.ndarray, smoothing: float, n: int = OUTLINE_POINTS, grow: float = 0.25
) -> np.ndarray:
    """A closed outline smoothed by splines and resampled at ``n`` points.

    ``smoothing`` is the typical distance the spline may stray from the traced
    points, as a fraction of the perimeter. Sharp corners (a trailing edge) are
    kept: the outline is cut there and each piece smoothed on its own, since a
    single smooth spline would round them off and shorten the shape. The
    resampling puts points with a density growing with the square root of the
    curvature: the nose of a profile gets many, its flat sides few; every corner
    is a sample. Finally every point moves ``grow`` pixels outward: the trace
    through pixel centres of a split stroke falls on its middle (odd widths) or
    half a pixel inside it (even widths).
    """
    from scipy.interpolate import splev

    p = np.asarray(points, np.float64)
    step = np.hypot(*(np.roll(p, -1, axis=0) - p).T)
    p = p[step > 1e-9]
    perimeter = float(np.hypot(*(np.roll(p, -1, axis=0) - p).T).sum())
    # Thin the trace to about one point every 2 px: the spline needs no more.
    stride = max(1, len(p) // max(64, int(perimeter / 2)))
    p = p[::stride]
    sigma = smoothing * perimeter
    corners = find_corners(p)
    if corners:
        pieces = [
            np.concatenate([p, p])[a : (b if b > a else b + len(p)) + 1]
            for a, b in zip(corners, corners[1:] + corners[:1], strict=True)
        ]
        tcks = [_fit(piece, sigma, False) if len(piece) >= 4 else None for piece in pieces]
    else:
        pieces, tcks = [p], [_fit(p, sigma, True)]

    # Dense samples of every piece, with their weight (arc length x density).
    dense, weight = [], []
    for piece, tck in zip(pieces, tcks, strict=True):
        m = max(8, 20 * n * len(piece) // len(p))
        u = np.linspace(0, 1, m, endpoint=False)
        if tck is None:  # too short to fit: straight
            xy = piece[0] + (piece[-1] - piece[0]) * u[:, None]
            speed = np.full(m, np.hypot(*(piece[-1] - piece[0])))
            curvature = np.zeros(m)
        else:
            xy = np.stack(splev(u, tck), 1)
            dx, dy = splev(u, tck, der=1)
            ddx, ddy = splev(u, tck, der=2)
            speed = np.hypot(dx, dy)
            curvature = np.abs(dx * ddy - dy * ddx) / np.maximum(speed, 1e-12) ** 3
        dense.append(xy)
        weight.append(speed / m * (1 + np.sqrt(curvature * perimeter / (2 * np.pi))))
    totals = np.array([w.sum() for w in weight])
    # Points per piece in proportion to its weight, at least its corner.
    counts = np.maximum(1, np.floor(totals / totals.sum() * n).astype(int))
    while counts.sum() < n:
        counts[np.argmax(totals / counts)] += 1
    while counts.sum() > n:
        counts[np.argmax(np.where(counts > 1, counts, 0))] -= 1
    out = []
    for xy, w, count in zip(dense, weight, counts, strict=True):
        cumulative = np.concatenate([[0.0], np.cumsum(w)[:-1]])
        targets = np.arange(count) * (w.sum() / count)
        index = np.searchsorted(cumulative, targets, side="right") - 1
        out.append(xy[np.clip(index, 0, len(xy) - 1)])
    loop = np.concatenate(out)
    if grow:
        tangent = np.roll(loop, -1, axis=0) - np.roll(loop, 1, axis=0)
        normal = np.stack([tangent[:, 1], -tangent[:, 0]], 1)
        normal /= np.maximum(np.hypot(*normal.T), 1e-12)[:, None]
        # (ty, -tx) points outward when the loop runs clockwise on screen.
        sign = 1.0 if _shoelace(loop) > 0 else -1.0
        loop = loop + sign * grow * normal
    return loop


def _shoelace(p: np.ndarray) -> float:
    """Signed area in image axes (y down): positive for clockwise on screen."""
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def _far_end(graph, start: int):
    from scipy.sparse.csgraph import dijkstra

    dist, pred = dijkstra(graph, indices=start, return_predecessors=True)
    dist[~np.isfinite(dist)] = -1
    return int(np.argmax(dist)), pred


def _stroke_graph(mask: np.ndarray):
    """Pixel graph of a stroke: 8 neighbours, diagonal steps √2 long."""
    from scipy.sparse import coo_matrix

    ys, xs = np.nonzero(mask)
    index = -np.ones(mask.shape, np.int64)
    index[ys, xs] = np.arange(len(ys))
    rows, cols, weights = [], [], []
    h, w = mask.shape
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        ny, nx = ys + dy, xs + dx
        ok = (ny < h) & (nx >= 0) & (nx < w)
        a = np.flatnonzero(ok)
        b = index[ny[ok], nx[ok]]
        keep = b >= 0
        rows.append(a[keep])
        cols.append(b[keep])
        weights.append(np.full(int(keep.sum()), np.hypot(dy, dx)))
    r, c, wt = np.concatenate(rows), np.concatenate(cols), np.concatenate(weights)
    n = len(ys)
    both = (np.concatenate([r, c]), np.concatenate([c, r]))
    graph = coo_matrix((np.concatenate([wt, wt]), both), (n, n))
    return graph.tocsr(), np.stack([xs, ys], 1).astype(np.float64)


@dataclass
class _Stroke:
    ends: tuple[np.ndarray, np.ndarray]
    path: np.ndarray


def _strokes(ink: np.ndarray, limit: int = 6) -> list[_Stroke]:
    """The largest pieces of ink, each with its two far ends and the path between them."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    out = []
    for label in np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:limit] + 1:
        x, y, bw, bh = (int(v) for v in stats[label, :4])
        mask = labels[y : y + bh, x : x + bw] == label
        graph, pixels = _stroke_graph(mask)
        if len(pixels) < 2:
            continue
        a, _ = _far_end(graph, 0)
        b, pred = _far_end(graph, a)
        path = [b]
        while path[-1] != a and pred[path[-1]] >= 0:
            path.append(int(pred[path[-1]]))
        offset = np.array([x, y], np.float64)
        out.append(_Stroke((pixels[a] + offset, pixels[b] + offset), pixels[path[::-1]] + offset))
    return out


def find_gap(ink: np.ndarray) -> Gap | None:
    """The two free ends of the strokes nearest to each other (an open outline)."""
    ends = [end for stroke in _strokes(ink) for end in stroke.ends]
    best: Gap | None = None
    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            d = float(np.hypot(*(ends[i] - ends[j])))
            if d > 0 and (best is None or d < best.length):
                best = Gap(tuple(ends[i]), tuple(ends[j]), d)
    return best


def open_outline(ink: np.ndarray) -> np.ndarray | None:
    """The largest stroke from one end to the other, to be closed with a straight line."""
    strokes = _strokes(ink, limit=1)
    if not strokes or len(strokes[0].path) < 8:
        return None
    return strokes[0].path


def is_closed(regions: list[Region]) -> bool:
    return bool(regions) and regions[0].fraction >= MIN_CLOSED
