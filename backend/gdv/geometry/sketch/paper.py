# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Step 1 of the sketch (SPEC §8.1, §8.2): read the photo, find the sheet, straighten it.

The photo is decoded with its EXIF orientation applied (OpenCV does it for
JPEG, PNG and WebP) and reduced to :data:`WORKING_SIZE` pixels on the long
side: every later step works on that copy.

The sheet is the largest convex quadrilateral covering more than 20% of the
image, found on Canny edges closed by a morphological closing. A sheet that
runs off the photo has no edge there, so each edge chain is first wrapped in
its convex hull. When no edge gives a sheet (white paper on a white desk), a
second try thresholds the brightness: a sheet is usually the largest bright
area. When neither finds it, the corners start at the image's corners and the
user drags them (test 16): never an error.

Straightening uses a homography onto a rectangle. Its aspect ratio is
estimated from the corners with a pinhole camera (:func:`aspect_ratio`);
within ±5% of √2 it snaps to √2 (A4, A3).
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from ...errors import AppError

__all__ = [
    "WORKING_SIZE",
    "aspect_ratio",
    "decode",
    "find_sheet",
    "order_corners",
    "sheet_shape",
    "straighten",
]

#: Long side of the working copy (SPEC §8.1).
WORKING_SIZE = 2000
#: Long side of the copy the sheet is searched in: edges need no more.
DETECT_SIZE = 800
#: A sheet covers more than this fraction of the photo (SPEC §8.2).
MIN_SHEET_FRACTION = 0.2
#: Aspect ratios within this of √2 are an A-series sheet.
A_TOLERANCE = 0.05


def decode(data: bytes) -> np.ndarray:
    """The photo as BGR, upright, reduced to the working size."""
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise AppError(
            "La foto non si riesce a leggere", "OpenCV non decodifica il file", status=422
        )
    h, w = image.shape[:2]
    factor = WORKING_SIZE / max(h, w)
    if factor < 1:
        size = (max(1, round(w * factor)), max(1, round(h * factor)))
        image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    return image


def order_corners(points: np.ndarray) -> np.ndarray:
    """Four points as top-left, top-right, bottom-right, bottom-left (image axes, y down)."""
    p = np.asarray(points, np.float64).reshape(4, 2)
    centre = p.mean(axis=0)
    angles = np.arctan2(p[:, 1] - centre[1], p[:, 0] - centre[0])
    p = p[np.argsort(angles)]  # clockwise on screen, starting somewhere
    start = int(np.argmin(p.sum(axis=1)))  # top-left: smallest x + y
    return np.roll(p, -start, axis=0)


def _quad(contour: np.ndarray, min_area: float) -> tuple[float, np.ndarray] | None:
    hull = cv2.convexHull(contour)
    area = cv2.contourArea(hull)
    if area < min_area:
        return None
    perimeter = cv2.arcLength(hull, True)
    for eps in (0.02, 0.03, 0.05):
        approx = cv2.approxPolyDP(hull, eps * perimeter, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return cv2.contourArea(approx), approx.reshape(4, 2).astype(np.float64)
        if len(approx) < 4:
            return None
    return None


def _best_quad(contours, min_area: float) -> np.ndarray | None:
    best: tuple[float, np.ndarray] | None = None
    for contour in contours:
        found = _quad(contour, min_area)
        if found and (best is None or found[0] > best[0]):
            best = found
    return None if best is None else best[1]


def find_sheet(image: np.ndarray) -> tuple[np.ndarray, bool]:
    """The sheet's corners in ``image`` pixels (ordered), and whether it was found."""
    h, w = image.shape[:2]
    factor = min(1.0, DETECT_SIZE / max(h, w))
    small = cv2.resize(image, (round(w * factor), round(h * factor)), interpolation=cv2.INTER_AREA)
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    min_area = MIN_SHEET_FRACTION * gray.shape[0] * gray.shape[1]
    # The image's own border must not look like an edge of the sheet.
    max_area = 0.98 * gray.shape[0] * gray.shape[1]

    edges = cv2.Canny(gray, 30, 90)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    quad = _best_quad(contours, min_area)
    if quad is None or cv2.contourArea(quad.astype(np.float32)) > max_area:
        _, bright = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        quad = _best_quad(contours, min_area)
        if quad is not None and cv2.contourArea(quad.astype(np.float32)) > max_area:
            quad = None
    if quad is None:
        return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float64), False
    return order_corners(quad / factor), True


def _plain_ratio(corners: np.ndarray) -> float:
    """Width over height from the mean opposite sides: right without perspective."""
    sides = np.hypot(*(corners - np.roll(corners, -1, axis=0)).T)  # top, right, bottom, left
    return float((sides[0] + sides[2]) / max(sides[1] + sides[3], 1e-9))


def aspect_ratio(corners: np.ndarray, image_size: tuple[int, int]) -> float:
    """Width over height of the real sheet, from its four corners in the photo.

    A pinhole camera with square pixels and the principal point at the image
    centre (any phone photo that has not been cropped) leaves one unknown, the
    focal length, which the quadrilateral itself gives: Zhang and He,
    "Whiteboard scanning and image enhancement" (2007), §3. Averaging opposite
    sides instead is off by 5-10% under a strong perspective. Without
    perspective (a parallelogram) the focal length is undetermined and not
    needed: the sides are then exact.
    """
    w, h = image_size
    u0, v0 = (w - 1) / 2, (h - 1) / 2
    tl, tr, br, bl = (np.array([x, y, 1.0]) for x, y in np.asarray(corners, np.float64))
    k2 = np.dot(np.cross(tl, br), bl) / np.dot(np.cross(tr, br), bl)
    k3 = np.dot(np.cross(tl, br), tr) / np.dot(np.cross(bl, br), tr)
    n2 = k2 * tr - tl  # the top side's vanishing direction
    n3 = k3 * bl - tl  # the left side's
    plain = _plain_ratio(np.asarray(corners, np.float64))
    if abs(n2[2]) < 1e-4 and abs(n3[2]) < 1e-4:
        return plain
    if abs(n2[2] * n3[2]) < 1e-12:
        return plain
    f2 = -(
        n2[0] * n3[0]
        - (n2[0] * n3[2] + n2[2] * n3[0]) * u0
        + n2[2] * n3[2] * u0**2
        + n2[1] * n3[1]
        - (n2[1] * n3[2] + n2[2] * n3[1]) * v0
        + n2[2] * n3[2] * v0**2
    ) / (n2[2] * n3[2])
    size = max(w, h)
    # A weak perspective gives a focal length that is noise: the sides are fine then.
    if not 0.3 * size < math.sqrt(max(f2, 0.0)) < 6 * size:
        return plain
    f = math.sqrt(f2)
    inverse = np.linalg.inv(np.array([[f, 0, u0], [0, f, v0], [0, 0, 1.0]]))
    metric = inverse.T @ inverse
    return float(math.sqrt((n2 @ metric @ n2) / (n3 @ metric @ n3)))


def sheet_shape(corners: np.ndarray, image_size: tuple[int, int]) -> tuple[int, int, bool]:
    """Width and height of the straightened sheet (pixels) and whether it snapped to √2.

    The long side follows the sheet's longest side in the photo, so
    straightening neither invents nor throws away much detail.
    """
    c = np.asarray(corners, np.float64)
    ratio = aspect_ratio(c, image_size)
    long = max(float(np.hypot(*(c - np.roll(c, -1, axis=0)).T).max()), 8.0)
    landscape = ratio >= 1
    elongation = ratio if landscape else 1 / ratio
    snapped = abs(elongation / math.sqrt(2) - 1) <= A_TOLERANCE
    if snapped:
        elongation = math.sqrt(2)
    short = long / elongation
    width, height = (long, short) if landscape else (short, long)
    return max(8, round(width)), max(8, round(height)), snapped


def straighten(image: np.ndarray, corners: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """The sheet seen from straight above, ``size`` = (width, height) pixels."""
    w, h = size
    target = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    matrix = cv2.getPerspectiveTransform(np.asarray(corners, np.float32), target)
    return cv2.warpPerspective(
        image, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
