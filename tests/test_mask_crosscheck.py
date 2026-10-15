# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 10: ``raster2d.py`` and ``mask.ts`` give the same mask, cell for cell (SPEC §10.3).

20 profiles and placements, among them a profile with a hole (the hole's cells
are solid), two overlapping bodies (the common part is solid), bodies cut by
the chamber's edges, live sections (nesting rule) and grid-aligned edges, where
a careless rounding would show.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from crosscheck import run_ts
from gdv.geometry.raster2d import outer_loops, place, rasterize
from synthetic import naca4


def square(x0, y0, side, ccw=True):
    p = [(x0, y0), (x0 + side, y0), (x0 + side, y0 + side), (x0, y0 + side)]
    return p if ccw else p[::-1]


def circle(cx, cy, r, n=180, ccw=True):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    p = [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in t]
    return p if ccw else p[::-1]


def naca(code="0012", chord=1.0):
    return [tuple(map(float, p)) for p in naca4(code, 150, chord)]


def case(name, loops, *, rule="orientation", angle=0.0, position=(2.0, 1.0), pivot=None,
         nx=200, ny=80, dx=0.025):  # fmt: skip
    xs = [x for loop in loops for x, _ in loop]
    ys = [y for loop in loops for _, y in loop]
    pivot = pivot or ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    return {
        "name": name,
        "loops": [[list(p) for p in loop] for loop in loops],
        "rule": rule,
        "pivot": list(pivot),
        "position": list(position),
        "angle_deg": angle,
        "nx": nx,
        "ny": ny,
        "dx": dx,
    }


CASES = [
    case("naca0012", [naca()]),
    case("naca0012_5deg", [naca()], angle=5.0),
    case("naca0012_minus12", [naca()], angle=-12.0),
    case("naca2412_30deg", [naca("2412")], angle=30.0),
    case("naca_90deg", [naca()], angle=90.0, position=(2.0, 1.0)),
    case("square_aligned", [square(0, 0, 0.5)], pivot=(0.0, 0.0), position=(1.0, 0.5)),
    case("square_on_centres", [square(0, 0, 0.5)], pivot=(0.0, 0.0), position=(1.0125, 0.5125)),
    case("square_45deg", [square(0, 0, 0.5)], angle=45.0),
    case("hole_filled", [square(0, 0, 1.0), square(0.25, 0.25, 0.5, ccw=False)]),
    case("overlapping_bodies", [square(0, 0, 0.6), square(0.3, 0.3, 0.6)]),
    case("wheel_in_body", [square(0, 0, 1.2), circle(0.3, 0.0, 0.25)]),
    case("two_bodies", [naca(), square(1.4, -0.2, 0.4)], angle=8.0),
    case("cut_by_left_edge", [square(0, 0, 0.8)], position=(0.1, 1.0)),
    case("cut_by_floor", [square(0, 0, 0.8)], position=(2.0, 0.1)),
    case("beyond_the_chamber", [square(0, 0, 0.8)], position=(10.0, 10.0)),
    case("live_section_nesting", [circle(0, 0, 0.5, ccw=False), circle(0, 0, 0.2)], rule="nesting"),
    case(
        "live_nested_island",
        [circle(0, 0, 0.6), circle(0, 0, 0.4), circle(0, 0, 0.2)],
        rule="nesting",
    ),  # fmt: skip
    case("tiny_body", [circle(0, 0, 0.004, n=12)]),
    case("fine_grid", [naca("4412")], angle=3.3, nx=1024, ny=384, dx=0.004),
    case(
        "star",
        [
            [
                (0.5 * math.cos(a), 0.5 * math.sin(a))
                if k % 2 == 0
                else (0.2 * math.cos(a), 0.2 * math.sin(a))
                for k, a in enumerate(np.linspace(0, 2 * np.pi, 10, endpoint=False))
            ]
        ],
        angle=17.0,
    ),  # fmt: skip
]


def runs(mask: np.ndarray) -> list[int]:
    flat = mask.ravel()
    out: list[int] = []
    for k in np.flatnonzero(flat):
        if out and out[-2] + out[-1] == k:
            out[-1] += 1
        else:
            out += [int(k), 1]
    return out


def python_mask(c) -> np.ndarray:
    loops = outer_loops([[tuple(p) for p in loop] for loop in c["loops"]], c["rule"])
    placed = place(loops, tuple(c["pivot"]), tuple(c["position"]), c["angle_deg"])
    return rasterize(placed, c["nx"], c["ny"], c["dx"])


@pytest.fixture(scope="module")
def typescript(tmp_path_factory):
    return {r["name"]: r["runs"] for r in run_ts("masks", CASES, tmp_path_factory.mktemp("ts"))}


def test_there_are_20_cases():
    assert len(CASES) == 20 and len({c["name"] for c in CASES}) == 20


@pytest.mark.parametrize("c", CASES, ids=lambda c: c["name"])
def test_10_same_mask(c, typescript):
    assert typescript[c["name"]] == runs(python_mask(c))


def test_10_holes_are_solid_and_overlaps_too():
    by_name = {c["name"]: c for c in CASES}
    hole = python_mask(by_name["hole_filled"])
    assert hole.sum() == pytest.approx((1.0 / 0.025) ** 2, rel=0.03)
    both = python_mask(by_name["overlapping_bodies"])
    expected = 2 * 0.36 - 0.09  # union of two 0.6 squares overlapping 0.3 x 0.3
    assert both.sum() * 0.025**2 == pytest.approx(expected, rel=0.03)


def test_10_area_and_position():
    c = CASES[0]
    mask = python_mask(c)
    area = mask.sum() * c["dx"] ** 2
    assert area == pytest.approx(0.0821, rel=0.1)  # NACA 0012: 0.0821 c², 40 cells a chord
    j, i = np.nonzero(mask)
    centre_x = (i.mean() + 0.5) * c["dx"]
    assert centre_x == pytest.approx(2.0 - 0.5 + 0.42, abs=0.05)
