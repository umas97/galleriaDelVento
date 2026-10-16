# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""What the wizard receives for each step (``pipeline.SketchPipeline.process``).

Pure data, without OpenCV, so the API can name these types at start-up.
Outlines and gaps are in pixels of the straightened sheet; seeds are fractions.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from ..profile import ProfileDraft
from .params import SketchParams

__all__ = ["SketchGap", "SketchPreview", "SketchRegion", "Stage"]

#: The step a preview is for: what it computes and returns.
Stage = Literal["sheet", "ink", "outline", "profile"]
Point = tuple[float, float]


class SketchRegion(BaseModel):
    #: A point well inside, sheet fractions: what ``SketchParams.regions`` holds.
    seed: Point
    #: Area as a fraction of the sheet.
    fraction: float
    selected: bool
    #: Sheet pixels; the smoothed outline when selected, a light trace otherwise.
    outline: list[Point]


class SketchGap(BaseModel):
    """The two free ends nearest to each other, sheet pixels."""

    a: Point
    b: Point
    #: Their distance as a fraction of the sheet's width.
    fraction: float


class SketchPreview(BaseModel):
    #: The parameters actually used, with the corners filled in.
    params: SketchParams
    photo_size: tuple[int, int]
    sheet_found: bool
    sheet_size: tuple[int, int]
    #: The aspect ratio snapped to √2 (A4, A3).
    standard_sheet: bool
    #: Step 2: the ink as a PNG data URL: black on white, the reach of the
    #: gap welding in pale blue.
    ink: str | None = None
    #: Step 3 and 4: the regions offered, largest first.
    regions: list[SketchRegion] | None = None
    #: No closed outline: where the stroke is open.
    gap: SketchGap | None = None
    #: The stroke closed by joining its ends («Chiudi nell'editor»), sheet pixels.
    joined: list[Point] | None = None
    #: Step 4: the profile, once the scale is known.
    draft: ProfileDraft | None = None
    #: Size of the profile, metres.
    size_m: tuple[float, float] | None = None
    elapsed_ms: float = 0.0
