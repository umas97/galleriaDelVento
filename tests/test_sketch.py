# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests 13-16: a photographed hand sketch becomes a profile (SPEC §8).

Every photo is made here (``synthetic.sketch_photo``): a profile drawn with an
irregular 3-6 px stroke and a hand tremor on off-white paper, laid on a table,
photographed by a pinhole camera at a random angle, with a shadow gradient,
noise and JPEG compression. The truth is the shape before it was drawn.
"""

from __future__ import annotations

import math

import cv2
import numpy as np
import pytest
import shapely
from shapely import Polygon

from gdv.geometry.profile import validate
from gdv.geometry.sketch import contour, paper
from gdv.geometry.sketch.params import SketchParams
from gdv.geometry.sketch.pipeline import SketchPipeline, to_metres
from synthetic import (
    SHEET_PX,
    camera_homography,
    ellipse,
    naca4,
    on_sheet,
    open_ellipse,
    sketch_photo,
)


def pipeline_of(data: bytes) -> SketchPipeline:
    return SketchPipeline(lambda _id: data)


def sheet_point(preview, point) -> np.ndarray:
    """Sheet pixels of the preview → pixels of the sheet as drawn (SHEET_PX)."""
    w, h = preview.sheet_size
    return np.array([point[0] / w * SHEET_PX[0], point[1] / h * SHEET_PX[1]])


# --- test 13 -----------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(10))
def test_13_a_photographed_naca_0012_comes_back(seed):
    truth = naca4("0012", 200)
    data, _ = sketch_photo([(on_sheet(truth), True)], seed)
    preview = pipeline_of(data).process("x", SketchParams(length_m=1.0), "profile")
    assert preview.sheet_found
    assert preview.standard_sheet  # A4, snapped to √2
    assert preview.draft is not None and len(preview.draft.loops) == 1
    got = Polygon(preview.draft.loops[0].points)
    want = Polygon(truth)
    hausdorff = shapely.hausdorff_distance(got.exterior, want.exterior, densify=0.01)
    assert hausdorff <= 0.015  # chord = 1 m
    assert abs(got.area / want.area - 1) <= 0.03
    assert validate(preview.draft).valid
    assert len(preview.draft.loops[0].points) == contour.OUTLINE_POINTS


def test_13_the_trailing_edge_stays_a_corner():
    truth = naca4("0012", 200)
    data, _ = sketch_photo([(on_sheet(truth), True)], 1)
    preview = pipeline_of(data).process("x", SketchParams(length_m=1.0), "profile")
    points = np.array(preview.draft.loops[0].points)
    tip = points[np.argmax(points[:, 0])]
    assert tip[0] == pytest.approx(1.0, abs=1e-9)  # the scale is the chord
    assert abs(tip[1]) < 0.01


# --- test 14 -----------------------------------------------------------------------------


def test_14_an_open_stroke_says_where_the_gap_is():
    line, gap_middle = open_ellipse(0.03)
    data, _ = sketch_photo([(line, False)], 0)
    pipeline = pipeline_of(data)
    preview = pipeline.process("x", SketchParams(length_m=1.0), "profile")
    assert preview.regions == [] and preview.draft is None
    gap = preview.gap
    assert gap is not None
    middle = (sheet_point(preview, gap.a) + sheet_point(preview, gap.b)) / 2
    assert np.hypot(*(middle - gap_middle)) < 0.01 * SHEET_PX[0]
    # The ends are a 3% gap apart, minus the stroke's round caps.
    assert 0.02 < gap.fraction < 0.032
    from gdv.errors import AppError

    with pytest.raises(AppError) as error:
        pipeline.draft("x", SketchParams(length_m=1.0), name="a", sha256="", file_name="")
    assert "contorno chiuso" in error.value.message
    assert "varco di" in error.value.technical


def test_14_welding_four_percent_closes_it():
    line, _ = open_ellipse(0.03)
    data, _ = sketch_photo([(line, False)], 0)
    preview = pipeline_of(data).process("x", SketchParams(length_m=1.0, closing=0.04), "profile")
    assert len(preview.regions) == 1
    assert preview.draft is not None and validate(preview.draft).valid
    w, h = preview.size_m
    assert h / w == pytest.approx(0.55, rel=0.02)  # the ellipse, gap bridged smoothly


def test_14_close_in_the_editor_joins_the_ends():
    line, _ = open_ellipse(0.03)
    data, _ = sketch_photo([(line, False)], 0)
    preview = pipeline_of(data).process("x", SketchParams(length_m=1.0, close_open=True), "profile")
    assert preview.joined is not None
    assert preview.draft is not None and validate(preview.draft).valid
    w, h = preview.size_m
    assert h / w == pytest.approx(0.55, rel=0.03)


# --- test 15 -----------------------------------------------------------------------------


def two_shapes() -> bytes:
    wing = on_sheet(naca4("2412", 200), centre=(0.32, 0.35), width=0.4)
    blob = on_sheet(ellipse(1, 0.6), centre=(0.72, 0.68), width=0.3)
    return sketch_photo([(wing, True), (blob, True)], 1)[0]


def test_15_two_shapes_are_two_regions_the_largest_chosen():
    pipeline = pipeline_of(two_shapes())
    preview = pipeline.process("x", SketchParams(length_m=1.0), "profile")
    assert len(preview.regions) == 2
    assert [r.selected for r in preview.regions] == [True, False]
    assert preview.regions[0].fraction > preview.regions[1].fraction
    assert len(preview.draft.loops) == 1
    seeds = [r.seed for r in preview.regions]
    both = pipeline.process("x", SketchParams(length_m=1.0, regions=seeds), "profile")
    assert [r.selected for r in both.regions] == [True, True]
    assert len(both.draft.loops) == 2
    wing = pipeline.process("x", SketchParams(length_m=1.0, regions=[seeds[1]]), "profile")
    assert [r.selected for r in wing.regions] == [False, True]
    assert wing.size_m[1] / wing.size_m[0] == pytest.approx(0.12, rel=0.05)  # NACA 2412


# --- test 16 -----------------------------------------------------------------------------


def test_16_white_on_white_starts_from_the_image_corners():
    data, _ = sketch_photo([(on_sheet(naca4()), True)], 3, table_rgb=(226, 221, 206), shadow=0.0)
    preview = pipeline_of(data).process("x", SketchParams(), "sheet")
    assert not preview.sheet_found
    assert preview.params.corners == [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]


def test_16_the_corners_found_are_the_sheets():
    data, corners = sketch_photo([(on_sheet(naca4()), True)], 5)
    pipeline = pipeline_of(data)
    found, ok = pipeline.detect("x")
    factor = pipeline.photo("x").shape[1] / 2400
    assert ok
    assert np.abs(found - corners * factor).max() < 0.01 * 2000


# --- the pieces ----------------------------------------------------------------------------


def test_decode_respects_the_exif_orientation():
    from PIL import Image

    image = Image.new("RGB", (300, 100), (255, 255, 255))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise to view
    buffer = __import__("io").BytesIO()
    image.save(buffer, "JPEG", exif=exif.tobytes())
    assert paper.decode(buffer.getvalue()).shape[:2] == (300, 100)


def test_decode_reduces_to_the_working_size():
    image = np.full((3000, 4000, 3), 200, np.uint8)
    ok, data = cv2.imencode(".png", image)
    assert paper.decode(data.tobytes()).shape[:2] == (1500, 2000)


@pytest.mark.parametrize("seed", range(6))
def test_the_aspect_ratio_survives_a_strong_perspective(seed):
    rng = np.random.default_rng(seed)
    for ratio in (math.sqrt(2), 1.0, 1.7):
        size = (1000, round(1000 / ratio))
        matrix = camera_homography(size, (2400, 1800), rng, tilt_deg=30)
        src = np.array([[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]], np.float64)
        corners = cv2.perspectiveTransform(src[None], matrix)[0]
        assert paper.aspect_ratio(corners, (2400, 1800)) == pytest.approx(
            size[0] / size[1], rel=0.01
        )


def test_corners_are_ordered_whatever_the_order_given():
    square = np.array([[10, 10], [90, 12], [88, 80], [12, 78]], np.float64)
    for shift in range(4):
        assert np.array_equal(paper.order_corners(np.roll(square, shift, axis=0)), square)
    assert np.array_equal(paper.order_corners(square[::-1]), square)


def test_wind_flip_and_both_scales():
    # A right triangle on the sheet (pixels, y down): 100 px along x, 50 up.
    loop = np.array([[100.0, 200.0], [200.0, 200.0], [100.0, 150.0]])
    params = SketchParams(length_m=2.0)
    (placed,), scale = to_metres([loop], params, (1000, 500))
    assert scale == pytest.approx(0.02)
    assert placed[:, 0].min() == pytest.approx(0) and placed[:, 0].max() == pytest.approx(2)
    assert placed[2, 1] > placed[0, 1]  # the apex points up (y up)
    flipped = to_metres([loop], params.model_copy(update={"flip": True}), (1000, 500))[0][0]
    assert flipped[2, 1] < flipped[0, 1]
    # Wind blowing up the sheet: the 50 px side now lies along the wind.
    turned = to_metres([loop], params.model_copy(update={"wind_deg": 90}), (1000, 500))[0][0]
    assert np.ptp(turned[:, 0]) == pytest.approx(2.0)
    assert np.ptp(turned[:, 1]) == pytest.approx(4.0)
    # Two points 0.1 of the width apart (100 px) are 0.5 m apart: 5 mm per pixel.
    points = SketchParams(scale_mode="points", points=[(0.1, 0.5), (0.2, 0.5)], distance_m=0.5)
    assert to_metres([loop], points, (1000, 500))[1] == pytest.approx(0.005)
    assert to_metres([loop], SketchParams(), (1000, 500)) is None  # no scale yet


def test_a_sharp_corner_is_found_and_a_round_nose_is_not():
    truth = on_sheet(naca4("0012", 400))
    corners = contour.find_corners(truth)
    assert len(corners) == 1
    assert truth[corners[0]][0] == pytest.approx(truth[:, 0].max())


def test_smoothing_keeps_the_corner_and_the_point_count():
    square = np.concatenate(
        [
            np.stack([np.arange(0, 400), np.zeros(400)], 1),
            np.stack([np.full(400, 400), np.arange(0, 400)], 1),
            np.stack([np.arange(400, 0, -1), np.full(400, 400)], 1),
            np.stack([np.zeros(400), np.arange(400, 0, -1)], 1),
        ]
    ).astype(np.float64)
    out = contour.smooth_loop(square, 0.0005, grow=0)
    assert len(out) == contour.OUTLINE_POINTS
    for corner in ([0, 0], [400, 0], [400, 400], [0, 400]):
        assert np.hypot(*(out - corner).T).min() < 1.0
