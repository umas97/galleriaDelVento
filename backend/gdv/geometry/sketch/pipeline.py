# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The four sketch steps chained, cached, and turned into a profile (SPEC §8).

Every slider of the wizard asks for a new preview, and each must come back
within 400 ms (SPEC §8.6). Each step's result is therefore cached under the
parameters it depends on: moving «Morbidezza» re-runs only the smoothing,
moving «Chiusura varchi» re-runs thresholding and outline but not the
straightening, and so on.

Coordinates: ``corners`` are fractions of the working copy of the photo;
every other point -- region seeds, the two scale points -- is a fraction of
the straightened sheet. Outlines are sent in sheet pixels.

Step 4 turns the chosen outlines into metres: y up, rotated so that the wind
arrow points along +x, optionally flipped, scaled, then placed with the
leading edge at x = 0 and the box centred on y = 0.
"""

from __future__ import annotations

import base64
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from ...errors import AppError
from ..profile import PhotoSource, ProfileDraft, from_arrays
from . import binarize as binarize_step
from . import contour as contour_step
from . import paper
from .params import SketchParams
from .preview import SketchGap, SketchPreview, SketchRegion, Stage

__all__ = ["SketchPipeline", "to_metres"]

#: Points per unselected region sent for drawing: they are only a hint.
HINT_POINTS = 200


class _Cache:
    """A small thread-safe LRU of computed steps."""

    def __init__(self, size: int) -> None:
        self.size = size
        self._items: OrderedDict[Hashable, Any] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Hashable, compute: Callable[[], Any]) -> Any:
        with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
                return self._items[key]
        value = compute()
        with self._lock:
            self._items[key] = value
            while len(self._items) > self.size:
                self._items.popitem(last=False)
        return value


@dataclass
class _Sheet:
    colour: np.ndarray
    gray: np.ndarray
    standard: bool


@dataclass
class _Outlines:
    labels: np.ndarray
    regions: list[contour_step.Region]
    closed: bool
    gap: contour_step.Gap | None
    half_width: float


def _round(values) -> tuple[float, ...]:
    return tuple(round(float(v), 6) for v in np.ravel(values))


def to_metres(
    loops: list[np.ndarray], params: SketchParams, sheet_size: tuple[int, int]
) -> tuple[list[np.ndarray], float] | None:
    """Sheet-pixel loops in metres (see the module docstring), and the scale used.

    ``None`` when the scale is not known yet.
    """
    angle = math.radians(params.wind_deg)
    c, s = math.cos(angle), math.sin(angle)
    # y up, then a rotation by -wind so that the wind blows along +x.
    turn = np.array([[c, -s], [-s, -c]])
    turned = [np.asarray(p, np.float64) @ turn.T for p in loops]
    if params.flip:
        turned = [p * [1.0, -1.0] for p in turned]
    if not turned:
        return None
    allp = np.concatenate(turned)
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    if params.scale_mode == "length":
        if params.length_m is None or hi[0] - lo[0] <= 0:
            return None
        scale = params.length_m / float(hi[0] - lo[0])
    else:
        if params.points is None or params.distance_m is None:
            return None
        (ax, ay), (bx, by) = params.points
        w, h = sheet_size
        pixels = math.hypot((ax - bx) * w, (ay - by) * h)
        if pixels <= 0:
            return None
        scale = params.distance_m / pixels
    origin = np.array([lo[0], (lo[1] + hi[1]) / 2])
    return [(p - origin) * scale for p in turned], scale


class SketchPipeline:
    """The steps for the photos of one library, cached across requests."""

    def __init__(self, load: Callable[[str], bytes]) -> None:
        self._load = load
        self._photos = _Cache(4)
        self._detected = _Cache(16)
        self._sheets = _Cache(4)
        self._inks = _Cache(6)
        self._outlines = _Cache(6)
        self._traces = _Cache(64)
        self._smoothed = _Cache(64)

    # --- step 1 --------------------------------------------------------------------

    def photo(self, photo_id: str) -> np.ndarray:
        return self._photos.get(photo_id, lambda: paper.decode(self._load(photo_id)))

    def detect(self, photo_id: str) -> tuple[np.ndarray, bool]:
        return self._detected.get(photo_id, lambda: paper.find_sheet(self.photo(photo_id)))

    def corners(self, photo_id: str, params: SketchParams) -> tuple[np.ndarray, bool]:
        """Corners in photo pixels, and whether they come from a sheet found or chosen."""
        image = self.photo(photo_id)
        h, w = image.shape[:2]
        if params.corners is None:
            return self.detect(photo_id)
        return np.asarray(params.corners, np.float64) * [w - 1, h - 1], True

    def sheet(self, photo_id: str, corners: np.ndarray) -> _Sheet:
        def compute() -> _Sheet:
            image = self.photo(photo_id)
            size = (image.shape[1], image.shape[0])
            width, height, standard = paper.sheet_shape(corners, size)
            colour = paper.straighten(self.photo(photo_id), corners, (width, height))
            return _Sheet(colour, cv2.cvtColor(colour, cv2.COLOR_BGR2GRAY), standard)

        return self._sheets.get((photo_id, _round(corners)), compute)

    # --- step 2 --------------------------------------------------------------------

    def _ink_key(self, photo_id: str, corners: np.ndarray, params: SketchParams) -> tuple:
        return (photo_id, _round(corners), round(params.threshold, 6))

    def _outline_key(self, photo_id: str, corners: np.ndarray, params: SketchParams) -> tuple:
        return (*self._ink_key(photo_id, corners, params), round(params.closing, 6))

    def ink(self, photo_id: str, corners: np.ndarray, params: SketchParams) -> np.ndarray:
        def compute() -> np.ndarray:
            gray = self.sheet(photo_id, corners).gray
            return binarize_step.binarize(gray, threshold=params.threshold)

        return self._inks.get(self._ink_key(photo_id, corners, params), compute)

    def weld(self, photo_id: str, corners: np.ndarray, params: SketchParams) -> float:
        width = self.sheet(photo_id, corners).gray.shape[1]
        return binarize_step.weld_radius(params.closing, width)

    # --- step 3 --------------------------------------------------------------------

    def outlines(self, photo_id: str, corners: np.ndarray, params: SketchParams) -> _Outlines:
        def compute() -> _Outlines:
            ink = self.ink(photo_id, corners, params)
            weld = self.weld(photo_id, corners, params)
            labels, regions = contour_step.find_regions(ink, weld)
            closed = contour_step.is_closed(regions)
            gap = None if closed else contour_step.find_gap(ink)
            return _Outlines(labels, regions, closed, gap, contour_step.stroke_half_width(ink))

        return self._outlines.get(self._outline_key(photo_id, corners, params), compute)

    def _trace(self, key: tuple, ink: np.ndarray, found: _Outlines, region) -> np.ndarray:
        return self._traces.get(
            (key, region.label),
            lambda: contour_step.region_outline(ink, found.labels, region, found.half_width),
        )

    def _smooth(self, key: tuple, trace: np.ndarray, smoothing: float) -> np.ndarray:
        return self._smoothed.get(
            (key, round(smoothing, 6)), lambda: contour_step.smooth_loop(trace, smoothing)
        )

    def selected(self, found: _Outlines, params: SketchParams, size: tuple[int, int]) -> list[int]:
        """Indices of the chosen regions: those holding a seed, else the largest."""
        if not found.regions:
            return []
        w, h = size
        chosen = []
        for sx, sy in params.regions:
            x = min(w - 1, max(0, round(sx * w)))
            y = min(h - 1, max(0, round(sy * h)))
            label = found.labels[y, x]
            for i, region in enumerate(found.regions):
                if region.label == label and i not in chosen:
                    chosen.append(i)
        return sorted(chosen) or [0]

    def chosen_loops(
        self, photo_id: str, corners: np.ndarray, params: SketchParams
    ) -> tuple[list[np.ndarray], list[SketchRegion], _Outlines, tuple[int, int]]:
        """The smoothed outlines that make the profile, and every region for display."""
        sheet = self.sheet(photo_id, corners)
        h, w = sheet.gray.shape
        found = self.outlines(photo_id, corners, params)
        ink = self.ink(photo_id, corners, params)
        key = self._outline_key(photo_id, corners, params)
        loops: list[np.ndarray] = []
        shown: list[SketchRegion] = []
        if found.closed:
            selected = set(self.selected(found, params, (w, h)))
            for i, region in enumerate(found.regions):
                trace = self._trace(key, ink, found, region)
                if i in selected:
                    outline = self._smooth((key, region.label), trace, params.smoothing)
                    loops.append(outline)
                else:
                    step = max(1, len(trace) // HINT_POINTS)
                    outline = trace[::step]
                shown.append(
                    SketchRegion(
                        seed=(region.seed[0] / w, region.seed[1] / h),
                        fraction=region.fraction,
                        selected=i in selected,
                        outline=[(float(x), float(y)) for x, y in outline],
                    )
                )
        elif params.close_open:
            path = contour_step.open_outline(ink)
            if path is not None:
                loops.append(self._smooth((key, "open"), path, params.smoothing))
        return loops, shown, found, (w, h)

    # --- all together --------------------------------------------------------------

    def process(
        self,
        photo_id: str,
        params: SketchParams,
        stage: Stage,
        *,
        name: str = "schizzo",
        sha256: str = "",
        file_name: str = "",
    ) -> SketchPreview:
        started = time.perf_counter()
        image = self.photo(photo_id)
        ph, pw = image.shape[:2]
        corners, found = self.corners(photo_id, params)
        resolved = params.model_copy(
            update={"corners": [(float(x / (pw - 1)), float(y / (ph - 1))) for x, y in corners]}
        )
        sheet = self.sheet(photo_id, corners)
        sh, sw = sheet.gray.shape
        preview = SketchPreview(
            params=resolved,
            photo_size=(pw, ph),
            sheet_found=found,
            sheet_size=(sw, sh),
            standard_sheet=sheet.standard,
        )
        if stage == "ink":
            mask = self.ink(photo_id, corners, params)
            reach = binarize_step.halo(mask, self.weld(photo_id, corners, params))
            # Ink black on white; how far the weld reaches, in pale blue (BGR).
            image = np.full((*mask.shape, 3), 255, np.uint8)
            image[reach] = (245, 215, 170)
            image[mask] = (0, 0, 0)
            ok, png = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            assert ok
            preview.ink = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
        if stage in ("outline", "profile"):
            loops, shown, outlines, size = self.chosen_loops(photo_id, corners, params)
            preview.regions = shown
            if outlines.gap is not None and not outlines.closed:
                g = outlines.gap
                preview.gap = SketchGap(a=g.a, b=g.b, fraction=g.length / sw)
            if loops and not outlines.closed:
                preview.joined = [(float(x), float(y)) for x, y in loops[0]]
            if stage == "profile" and loops:
                placed = to_metres(loops, params, size)
                if placed is not None:
                    metres, _ = placed
                    source = PhotoSource(sha256=sha256, file_name=file_name, params=resolved)
                    preview.draft = from_arrays(metres, name=name, source=source)
                    allp = np.concatenate(metres)
                    extent = allp.max(axis=0) - allp.min(axis=0)
                    preview.size_m = (float(extent[0]), float(extent[1]))
        preview.elapsed_ms = (time.perf_counter() - started) * 1000
        return preview

    def draft(
        self, photo_id: str, params: SketchParams, *, name: str, sha256: str, file_name: str
    ) -> ProfileDraft:
        """The profile of step 4, or an error saying what is missing."""
        preview = self.process(
            photo_id, params, "profile", name=name, sha256=sha256, file_name=file_name
        )
        if preview.draft is not None:
            return preview.draft
        if preview.regions or preview.joined:
            raise AppError("Manca la scala del disegno", "lunghezza o due punti", status=422)
        gap = preview.gap
        if params.close_open or gap is None:
            raise AppError("Sul foglio non c'è un tratto da chiudere", "nessun tratto", status=422)
        detail = (
            f"varco di {gap.fraction:.1%} della larghezza del foglio "
            f"tra ({gap.a[0]:.0f}, {gap.a[1]:.0f}) e ({gap.b[0]:.0f}, {gap.b[1]:.0f}) px"
        )
        raise AppError("Lo schizzo non ha un contorno chiuso", detail, status=422)

    def sheet_jpeg(self, photo_id: str, params: SketchParams) -> bytes:
        corners, _ = self.corners(photo_id, params)
        ok, data = cv2.imencode(
            ".jpg", self.sheet(photo_id, corners).colour, [cv2.IMWRITE_JPEG_QUALITY, 85]
        )
        assert ok
        return data.tobytes()

    def photo_jpeg(self, photo_id: str) -> bytes:
        ok, data = cv2.imencode(".jpg", self.photo(photo_id), [cv2.IMWRITE_JPEG_QUALITY, 85])
        assert ok
        return data.tobytes()
