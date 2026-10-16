# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Step 2 of the sketch (SPEC §8.3): from the straightened sheet to a mask of ink.

1. **Flat light**: the sheet is divided by its background, estimated with a
   blur of radius 5% of the width. Shadows and gradients go; the strokes,
   much thinner than the blur, stay. The blur runs on a copy reduced 8 times:
   the background is smooth by definition, and a full-size blur that wide
   would take most of the time budget.
2. **Adaptive threshold** (Gaussian, block ~3% of the width): ink is what is
   darker than its neighbourhood by more than ``threshold``.
3. **Specks** smaller than 0.05% of the sheet are removed.

A thin margin along the sheet's border is cleared first: corners placed a
little outside the sheet would otherwise leave a dark frame that encloses
everything.

Welding the gaps of the stroke («Chiusura varchi») is not a morphological
closing here, although the SPEC calls it that: a disc closing never joins two
thin stroke ends facing each other across a gap -- discs slip into the gap
from both sides and meet in the middle -- unless its radius is about d²/4w (8%
of the sheet for a 3% gap). The weld is done where the regions are found
(``contour.find_regions``): the ink is dilated by half the gap, the enclosed
paper found, and grown back. :func:`weld_radius` and :func:`halo` give the
radius and what the dilation covers, for the preview of this step.
"""

from __future__ import annotations

import cv2
import numpy as np

__all__ = ["binarize", "flatten", "halo", "weld_radius"]

#: Background blur radius, fraction of the width (SPEC §8.3).
BACKGROUND_RADIUS = 0.05
#: Adaptive threshold block, fraction of the width (SPEC §8.3).
BLOCK = 0.03
#: Components smaller than this fraction of the sheet are specks (SPEC §8.3).
MIN_SPECK = 0.0005
#: Border cleared of ink, fraction of the width.
MARGIN = 0.01


def flatten(gray: np.ndarray) -> np.ndarray:
    """The sheet with its lighting removed: paper ≈ 255, ink darker (uint8)."""
    h, w = gray.shape
    factor = 8
    reduced = (max(1, w // factor), max(1, h // factor))
    small = cv2.resize(gray, reduced, interpolation=cv2.INTER_AREA)
    # Strokes are dark and thin: a max filter takes them out of the background first.
    small = cv2.dilate(small, np.ones((3, 3), np.uint8))
    sigma = max(0.5, BACKGROUND_RADIUS * w / factor / 2)
    background = cv2.GaussianBlur(small.astype(np.float32), (0, 0), sigma)
    background = cv2.resize(background, (w, h), interpolation=cv2.INTER_LINEAR)
    flat = gray.astype(np.float32) * (255.0 / np.maximum(background, 1.0))
    return np.clip(flat, 0, 255).astype(np.uint8)


def weld_radius(closing: float, width: int) -> float:
    """Dilation radius (pixels) that bridges gaps up to ``closing`` × ``width``."""
    return closing * width / 2


def halo(ink: np.ndarray, radius: float) -> np.ndarray:
    """The ink dilated by a Euclidean disc of ``radius`` pixels (bool)."""
    if radius < 0.5:
        return ink
    paper = (~ink).astype(np.uint8)
    return cv2.distanceTransform(paper, cv2.DIST_L2, cv2.DIST_MASK_PRECISE) <= radius


def binarize(gray: np.ndarray, *, threshold: float) -> np.ndarray:
    """Ink mask (bool) of the straightened sheet ``gray``."""
    h, w = gray.shape
    flat = flatten(gray)
    block = max(3, int(round(BLOCK * w)) | 1)
    adaptive = cv2.adaptiveThreshold(
        flat,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block,
        threshold * 255,
    )
    ink = adaptive > 0
    margin = max(1, int(round(MARGIN * w)))
    ink[:margin], ink[-margin:], ink[:, :margin], ink[:, -margin:] = False, False, False, False
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    small = stats[:, cv2.CC_STAT_AREA] < MIN_SPECK * h * w
    small[0] = True  # the background label
    return ~small[labels]
