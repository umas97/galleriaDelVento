# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 9: the two validators agree, and so do the two repairers (SPEC §7.1, §7.2).

30 cases -- valid, self-intersecting, degenerate -- go through ``profile.validate``
and ``frontend/src/profile/validate.ts``: same verdict, same issue codes on the
same loops. On the invalid ones the automatic repairer of live sections
(clipper2-ts) and ``shapely.make_valid`` + union give the same area within 0.5%,
and what TypeScript produced passes ``profile.validate``.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from crosscheck import run_ts
from gdv.geometry.profile import EditorSource, Loop, ProfileDraft, repair, signed_area, validate
from synthetic import naca4


def square(x0=0.0, y0=0.0, side=1.0, ccw=True):
    p = [[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]]
    return p if ccw else p[::-1]


def circle(cx=0.0, cy=0.0, r=1.0, n=200):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([cx + r * np.cos(t), cy + r * np.sin(t)], 1).tolist()


def star(n=5, r=1.0):
    a = np.pi / 2 + np.arange(n) * 4 * np.pi / n
    return np.stack([r * np.cos(a), r * np.sin(a)], 1).tolist()


def naca_swapped():
    p = naca4("0012", 60, 1.0)
    p[[20, 24]] = p[[24, 20]]  # two points of the upper surface swapped: the line crosses
    return p.tolist()


CASES: dict[str, list] = {
    # valid
    "square": [square()],
    "square_cw": [square(ccw=False)],
    "naca0012": [naca4("0012", 100, 1.0).tolist()],
    "naca2412_small": [naca4("2412", 80, 0.05).tolist()],
    "circle": [circle()],
    "with_hole": [square(0, 0, 10), square(2, 2, 6, ccw=False)],
    "two_bodies": [square(), square(3, 0)],
    "overlapping_bodies": [square(0, 0, 2), square(1, 1, 2)],
    "l_shape": [[[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]],
    "collinear_points": [[[0, 0], [1, 0], [2, 0], [2, 1], [0, 1]]],
    "building_50m": [square(-25, 0, 50), square(-10, 5, 3, ccw=False)],
    "thin_sliver_ok": [[[0, 0], [1, 0], [1, 1e-4], [0, 1e-4]]],
    # self-intersecting
    "bow_tie": [[[0, 0], [2, 2], [2, 0], [0, 2]]],
    "figure_eight_unequal": [[[0, 0], [3, 3], [3, 0], [0, 1]]],
    "pinch_on_edge": [[[0, 0], [2, 0], [2, 2], [1, 0], [0, 2]]],
    "repeated_vertex": [[[0, 0], [2, 0], [2, 1], [3, 1], [3, 2], [2, 1], [0, 1]]],
    "pentagram": [star()],
    "naca_swapped": [naca_swapped()],
    "zigzag": [[[0, 0], [4, 0], [4, 2], [0, 1], [0, 3], [4, 3], [4, 4], [0, 4], [2, 2]]],
    "backtrack": [[[0, 0], [3, 0], [3, 1], [1, 1], [2, 1], [0, 1]]],
    "crossing_plus_valid": [[[0, 0], [2, 2], [2, 0], [0, 2]], square(5, 5)],
    "heptagram": [star(7, 2.0)],
    "self_overlap_spiral": [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 1], [3, 1], [3, 3], [1, 3], [1, 0.5], [0, 0.5]]
    ],
    # degenerate (each next to a valid body, so that the repair leaves something)
    "two_points": [[[0, 0], [1, 0]], square(3, 0)],
    "flat_line": [[[0, 0], [1, 0], [2, 0]], square(3, 0)],
    "duplicate_point": [[[0, 0], [1, 0], [1, 0], [1, 1], [0, 1]]],
    "too_close": [[[0, 0], [1, 0], [1 + 5e-7, 0], [1, 1], [0, 1]]],
    "flat_there_and_back": [[[0, 0], [2, 0], [1, 0]], square(3, 0)],
    "tiny_square": [square(0, 0, 5e-7), square(3, 0)],
    "too_many_loops": [square(3 * i, 0, 1) for i in range(51)],
}


def draft(loops) -> ProfileDraft:
    return ProfileDraft(
        name="caso",
        loops=[Loop(points=[(float(x), float(y)) for x, y in p]) for p in loops],
        source=EditorSource(),
    )


def total_area(loops) -> float:
    return sum(signed_area(np.asarray(p)) for p in loops if len(p) >= 3)


@pytest.fixture(scope="module")
def typescript(tmp_path_factory):
    payload = [{"name": k, "loops": v, "min_area": 0.0} for k, v in CASES.items()]
    return {r["name"]: r for r in run_ts("profiles", payload, tmp_path_factory.mktemp("ts"))}


def test_there_are_30_cases():
    assert len(CASES) == 30
    reports = [validate(draft(loops)) for loops in CASES.values()]
    valid = sum(r.valid for r in reports)
    assert valid >= 10 and len(reports) - valid >= 15


@pytest.mark.parametrize("name", list(CASES))
def test_9_same_verdict_and_issues(name, typescript):
    py = validate(draft(CASES[name]))
    ts = typescript[name]["report"]
    assert ts["valid"] == py.valid
    assert [(i["code"], i["loop"]) for i in ts["issues"]] == [(i.code, i.loop) for i in py.issues]


@pytest.mark.parametrize(
    "name", [k for k in CASES if not validate(draft(CASES[k])).valid and k != "too_many_loops"]
)
def test_9_same_repair(name, typescript):
    py = repair(draft(CASES[name]))
    ts_loops = typescript[name]["repaired"]
    assert ts_loops, "TypeScript returned nothing"
    py_area = total_area([np.asarray(loop.points) for loop in py.loops])
    ts_area = total_area(ts_loops)
    assert ts_area == pytest.approx(py_area, rel=0.005)
    assert math.isclose(py_area, abs(py_area))  # outer CCW: positive overall
    assert validate(draft(ts_loops)).valid, validate(draft(ts_loops)).issues
