# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The settings of the four sketch steps (SPEC §8): everything needed to redo them.

A profile made from a photo keeps these in its source, so reopening the wizard
from the profile restores every step exactly (SPEC §8.5). Positions are
fractions of an image, not pixels, so they do not depend on its resolution:
``corners`` of the working copy of the photo, every other point of the
straightened sheet. Pure data: no OpenCV here.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

__all__ = ["DEFAULTS", "SketchParams"]

Point = tuple[float, float]


class SketchParams(BaseModel):
    # --- step 1: sheet and perspective ---------------------------------------------
    #: The sheet's corners, top-left, top-right, bottom-right, bottom-left, as
    #: fractions of the photo; ``None`` until found (then they are filled in).
    corners: list[Point] | None = None

    # --- step 2: cleaning and thresholding -----------------------------------------
    #: How much darker than its surroundings a pixel must be to count as ink.
    threshold: float = Field(default=0.12, ge=0.02, le=0.5)
    #: Gaps in the stroke up to this size are welded («Chiusura varchi»),
    #: as a fraction of the sheet's width.
    closing: float = Field(default=0.01, ge=0.0, le=0.08)

    # --- step 3: outline -----------------------------------------------------------
    #: «Morbidezza»: typical deviation the spline may leave, fraction of the perimeter.
    smoothing: float = Field(default=0.0005, ge=0.0, le=0.005)
    #: One point inside each chosen region (sheet fractions); empty = the largest.
    regions: list[Point] = []
    #: No closed region: join the ends of the stroke with a straight line instead.
    close_open: bool = False

    # --- step 4: scale and orientation ---------------------------------------------
    #: Direction the wind blows across the drawing, degrees, counter-clockwise
    #: from left-to-right as the sheet is seen.
    wind_deg: float = Field(default=0.0, ge=-180.0, le=180.0)
    flip: bool = False
    scale_mode: Literal["length", "points"] = "length"
    #: Real length of the drawing along the wind, metres («corda 1,2 m»).
    length_m: float | None = Field(default=None, gt=0.0, le=1e3)
    #: Two points on the sheet and the real distance between them.
    points: list[Point] | None = None
    distance_m: float | None = Field(default=None, gt=0.0, le=1e3)

    @field_validator("corners")
    @classmethod
    def _four(cls, value: list[Point] | None) -> list[Point] | None:
        if value is not None and len(value) != 4:
            raise ValueError("servono 4 angoli del foglio")
        return value

    @field_validator("points")
    @classmethod
    def _two(cls, value: list[Point] | None) -> list[Point] | None:
        if value is not None and len(value) != 2:
            raise ValueError("servono 2 punti per la scala")
        return value


DEFAULTS = SketchParams()
