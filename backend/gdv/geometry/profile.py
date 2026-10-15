# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""``Profile2D``, the contract every 2D source converges to (SPEC §5, §7.1).

Coordinates are metres in the flow plane: x along the wind at zero incidence, y
up the plane. A profile is one or more closed loops; outer boundaries run
counter-clockwise and holes clockwise once normalised (:func:`normalise`).

Which loop is a hole is decided by *nesting*: a loop is inside another when
every one of up to :data:`NESTING_SAMPLES` of its vertices, evenly spread, lies
strictly inside it; an even number of containing loops makes it an outer
boundary. Sampling instead of a single vertex keeps two overlapping bodies (a
wheel cutting into a car body) both outer. The frontend
(``frontend/src/profile/nesting.ts``) applies the same rule.

:func:`validate` reports *issues* by code, and the frontend has a faster twin
with the same codes (``frontend/src/profile/validate.ts``, test 9). An invalid
profile is never repaired silently: :func:`repair` proposes a version made with
``shapely.make_valid`` and a union, and the user confirms it.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

import numpy as np
from pydantic import BaseModel, Field, field_validator, model_validator

from .placement import Placement

__all__ = [
    "MAX_LOOPS",
    "MAX_POINTS",
    "MIN_POINT_DISTANCE",
    "DrawingSource",
    "EditorSource",
    "Issue",
    "Loop",
    "PhotoSource",
    "Profile2D",
    "ProfileDraft",
    "ProfileSource",
    "Section3DSource",
    "SplineData",
    "SplineLoop",
    "ValidationReport",
    "from_arrays",
    "is_flat",
    "loop_depths",
    "normalise",
    "repair",
    "signed_area",
    "validate",
]

SCHEMA_VERSION = 1
#: Consecutive points closer than this (metres) are an error (SPEC §7.1).
MIN_POINT_DISTANCE = 1e-6
MAX_LOOPS = 50
MAX_POINTS = 20_000
#: Vertices sampled per loop to decide nesting.
NESTING_SAMPLES = 16

Point = tuple[float, float]


class Loop(BaseModel):
    """A closed polygon: the last point is *not* a repeat of the first."""

    points: list[Point]

    @field_validator("points")
    @classmethod
    def _finite(cls, value: list[Point]) -> list[Point]:
        if not all(math.isfinite(x) and math.isfinite(y) for x, y in value):
            raise ValueError("coordinate non finite nel profilo")
        return value


class SplineLoop(BaseModel):
    """The editable form of one loop (SPEC §7.5): control points and their corners."""

    kind: Literal["spline", "polyline"]
    points: list[Point]
    corners: list[bool]
    #: Height of the chord line when the loop is edited in symmetric mode.
    symmetric_axis_y: float | None = None

    @model_validator(mode="after")
    def _same_length(self) -> SplineLoop:
        if len(self.corners) != len(self.points):
            raise ValueError("ogni punto di controllo deve dire se è uno spigolo")
        if len(self.points) < 3:
            raise ValueError("una spline chiusa ha almeno 3 punti di controllo")
        return self


class SplineData(BaseModel):
    """One entry per loop of the profile; ``None`` for a loop that is not editable yet."""

    loops: list[SplineLoop | None]


class Section3DSource(BaseModel):
    """A cut through a 3D model (SPEC §7.2): enough to restore the exact cut."""

    kind: Literal["section3d"] = "section3d"
    model_id: str
    model_name: str
    #: The model's base placement when the cut was taken (scale, quarter turns, floor).
    placement: Placement
    plane: Literal["vertical", "horizontal"]
    #: Coordinate of the plane along its normal (tunnel y or z), metres.
    depth_m: float
    #: The same as a fraction of the rotated model's extent along the normal.
    depth_fraction: float
    #: Rotation about the plane normal: applied to the cut profile, not to the cut.
    incidence_deg: float = 0.0
    #: Rotation about the wind axis x.
    roll_deg: float = 0.0
    #: Rotation about the in-plane axis across the wind (z for vertical, y for horizontal).
    tilt_deg: float = 0.0
    #: The live cut was invalid and repaired automatically before saving.
    repaired: bool = False


class DrawingSource(BaseModel):
    """An imported SVG or DXF file (SPEC §7.3, §7.4)."""

    kind: Literal["svg", "dxf"]
    sha256: str
    file_name: str
    #: Metres per drawing unit.
    scale: float = Field(gt=0.0)
    #: Units declared by the file, if any.
    units: str | None = None


class PhotoSource(BaseModel):
    """A photographed sketch (SPEC §8); the parameters are filled in Phase 4."""

    kind: Literal["photo"] = "photo"
    sha256: str
    params: dict[str, Any] = {}


OriginSource = Annotated[Section3DSource | DrawingSource | PhotoSource, Field(discriminator="kind")]


class EditorSource(BaseModel):
    """Drawn or edited in the internal editor (SPEC §7.5)."""

    kind: Literal["editor"] = "editor"
    #: The profile this one was edited from, if any.
    derived_from: str | None = None
    #: Where that profile came from originally, kept through later edits.
    origin: OriginSource | None = None


ProfileSource = Annotated[
    Section3DSource | DrawingSource | PhotoSource | EditorSource, Field(discriminator="kind")
]


class ProfileDraft(BaseModel):
    """What a client sends to create or overwrite a profile."""

    name: str = Field(min_length=1, max_length=200)
    loops: list[Loop]
    source: ProfileSource
    spline: SplineData | None = None

    @model_validator(mode="after")
    def _spline_matches(self) -> ProfileDraft:
        if self.spline is not None and len(self.spline.loops) != len(self.loops):
            raise ValueError("la spline deve avere un elemento per ogni anello")
        return self


class Profile2D(ProfileDraft):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    schema_version: int = SCHEMA_VERSION


IssueCode = Literal[
    "no_loops",
    "too_many_loops",
    "too_many_points",
    "too_few_points",
    "points_too_close",
    "self_intersection",
    "zero_area",
]


class Issue(BaseModel):
    code: IssueCode
    #: Index of the loop, or ``None`` for the profile as a whole.
    loop: int | None = None
    #: Where, when it helps the user find it (metres).
    at: Point | None = None


class ValidationReport(BaseModel):
    valid: bool
    issues: list[Issue]


# --- geometry ------------------------------------------------------------------


def signed_area(points: np.ndarray | list[Point]) -> float:
    """Shoelace area: positive for counter-clockwise."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        return 0.0
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def _inside(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Even-odd point-in-polygon for many points (boundary points count as outside)."""
    x, y = points[:, 0][:, None], points[:, 1][:, None]
    ax, ay = polygon[:, 0][None, :], polygon[:, 1][None, :]
    bx, by = np.roll(polygon[:, 0], -1)[None, :], np.roll(polygon[:, 1], -1)[None, :]
    straddles = (ay > y) != (by > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        cross_x = ax + (y - ay) * (bx - ax) / (by - ay)
    return (np.count_nonzero(straddles & (x < cross_x), axis=1) % 2) == 1


def _samples(points: np.ndarray) -> np.ndarray:
    n = len(points)
    if n <= NESTING_SAMPLES:
        return points
    return points[(np.arange(NESTING_SAMPLES) * n) // NESTING_SAMPLES]


def loop_depths(loops: list[np.ndarray]) -> list[int]:
    """How many other loops contain each loop (even = outer boundary, odd = hole)."""
    boxes = [(p.min(axis=0), p.max(axis=0)) for p in loops]
    depths = []
    for i, inner in enumerate(loops):
        sample = _samples(inner)
        depth = 0
        for j, outer in enumerate(loops):
            if i == j or len(outer) < 3:
                continue
            lo, hi = boxes[j]
            if (sample < lo).any() or (sample > hi).any():
                continue
            if _inside(sample, outer).all():
                depth += 1
        depths.append(depth)
    return depths


def normalise(profile: ProfileDraft) -> ProfileDraft:
    """Outer loops counter-clockwise, holes clockwise; the spline follows its loop."""
    arrays = [np.asarray(loop.points, dtype=np.float64) for loop in profile.loops]
    depths = loop_depths(arrays)
    loops = []
    spline_loops = list(profile.spline.loops) if profile.spline else None
    for i, (loop, depth) in enumerate(zip(profile.loops, depths, strict=True)):
        ccw = signed_area(loop.points) > 0
        if ccw == (depth % 2 == 1):  # an outer loop running clockwise, or a hole running CCW
            loops.append(Loop(points=loop.points[::-1]))
            if spline_loops is not None and spline_loops[i] is not None:
                s = spline_loops[i]
                assert s is not None
                spline_loops[i] = s.model_copy(
                    update={"points": s.points[::-1], "corners": s.corners[::-1]}
                )
        else:
            loops.append(loop)
    spline = SplineData(loops=spline_loops) if spline_loops is not None else None
    return profile.model_copy(update={"loops": loops, "spline": spline})


# --- validation ----------------------------------------------------------------


def _self_intersection(points: np.ndarray) -> tuple[bool, Point | None]:
    """Whether the ring touches or crosses itself, and where (when GEOS says)."""
    from shapely import LinearRing  # imported when needed: keeps start-up light
    from shapely.validation import explain_validity

    ring = LinearRing(points)
    if ring.is_simple:
        return False, None
    text = explain_validity(ring)  # "Ring Self-intersection[x y]"
    try:
        x, y = text[text.index("[") + 1 : text.index("]")].split()[:2]
        return True, (float(x), float(y))
    except (ValueError, IndexError):
        return True, None


def is_flat(points: np.ndarray) -> bool:
    """All points on one line (within MIN_POINT_DISTANCE): the loop encloses nothing.

    The shoelace area cannot tell: a bow tie with equal lobes also sums to zero.
    """
    p = np.asarray(points, dtype=np.float64)
    far = p[np.argmax(np.hypot(*(p - p[0]).T))]
    axis = far - p[0]
    length = float(np.hypot(*axis))
    if length <= MIN_POINT_DISTANCE:
        return True
    offsets = np.abs((p - p[0]) @ np.array([-axis[1], axis[0]])) / length
    return float(offsets.max()) <= MIN_POINT_DISTANCE


def validate(profile: ProfileDraft) -> ValidationReport:
    """Every loop simple, not flat, no repeated points; size limits (SPEC §7.1).

    One issue per loop, the first found in this order: too few points, points
    too close, flat (zero area), self-intersection. A simple loop that is not
    flat always has an area.
    """
    issues: list[Issue] = []
    if not profile.loops:
        issues.append(Issue(code="no_loops"))
    if len(profile.loops) > MAX_LOOPS:
        issues.append(Issue(code="too_many_loops"))
    if sum(len(loop.points) for loop in profile.loops) > MAX_POINTS:
        issues.append(Issue(code="too_many_points"))
    for i, loop in enumerate(profile.loops):
        p = np.asarray(loop.points, dtype=np.float64).reshape(-1, 2)
        if len(p) < 3:
            issues.append(Issue(code="too_few_points", loop=i))
            continue
        step = np.hypot(*(np.roll(p, -1, axis=0) - p).T)
        close = np.flatnonzero(step <= MIN_POINT_DISTANCE)
        if len(close):
            x, y = p[close[0]]
            issues.append(Issue(code="points_too_close", loop=i, at=(float(x), float(y))))
            continue
        if is_flat(p):
            issues.append(Issue(code="zero_area", loop=i))
            continue
        crossed, where = _self_intersection(p)
        if crossed:
            issues.append(Issue(code="self_intersection", loop=i, at=where))
    return ValidationReport(valid=not issues, issues=issues)


# --- repair --------------------------------------------------------------------


def _polygons_from_loops(loops: list[np.ndarray]) -> list[Any]:
    """Shapely polygons: each outer loop with the holes directly inside it."""
    from shapely import Polygon

    depths = loop_depths(loops)
    polygons = []
    for i, outer in enumerate(loops):
        if depths[i] % 2 == 1 or len(outer) < 3:
            continue
        holes = []
        for j, hole in enumerate(loops):
            if depths[j] != depths[i] + 1:
                continue
            if _inside(_samples(hole), outer).all():
                holes.append(hole)
        polygons.append(Polygon(outer, holes))
    return polygons


def _dedupe(points: np.ndarray) -> np.ndarray:
    step = np.hypot(*(np.roll(points, -1, axis=0) - points).T)
    return points[step > MIN_POINT_DISTANCE]


def repair(profile: ProfileDraft, min_area: float = 0.0) -> ProfileDraft:
    """A valid version of ``profile``: ``make_valid`` on every body, then their union.

    Overlapping bodies merge into one; pieces smaller than ``min_area`` (m²) and
    degenerate loops disappear. The spline is dropped: it described the old loops.
    """
    from shapely import make_valid, unary_union
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.geometry.polygon import orient

    arrays = []
    for loop in profile.loops:
        p = np.asarray(loop.points, dtype=np.float64).reshape(-1, 2)
        if len(p) >= 3:
            p = _dedupe(p)
        if len(p) >= 3 and not is_flat(p):
            arrays.append(p)
    # "structure" fills each outline the way the mask does (and Clipper's NonZero
    # rule in the frontend): the middle of a self-crossing star stays solid.
    valid = [make_valid(poly, method="structure") for poly in _polygons_from_loops(arrays)]
    merged = unary_union(valid) if valid else Polygon()
    parts = []
    for geom in getattr(merged, "geoms", [merged]):
        if isinstance(geom, Polygon):
            parts.append(geom)
        elif isinstance(geom, MultiPolygon):
            parts.extend(geom.geoms)
        elif hasattr(geom, "geoms"):  # a collection with lines or points: keep the areas
            parts.extend(g for g in geom.geoms if isinstance(g, Polygon))
    loops: list[Loop] = []
    for part in parts:
        if part.is_empty or part.area <= max(min_area, 0.0):
            continue
        part = orient(part, sign=1.0)
        for ring in (part.exterior, *part.interiors):
            coords = _dedupe(np.asarray(ring.coords)[:-1])
            if len(coords) >= 3:
                loops.append(Loop(points=[(float(x), float(y)) for x, y in coords]))
    return profile.model_copy(update={"loops": loops, "spline": None})


def from_arrays(
    loops: list[np.ndarray], *, name: str, source: Any, spline: SplineData | None = None
) -> ProfileDraft:
    """A draft from numpy loops (helper for importers)."""
    return ProfileDraft(
        name=name,
        loops=[Loop(points=[(float(x), float(y)) for x, y in p]) for p in loops],
        source=source,
        spline=spline,
    )
