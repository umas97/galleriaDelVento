# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Profile2D contract: validation, orientation, nesting, repair (SPEC §7.1)."""

from __future__ import annotations

import numpy as np
import pytest
from pydantic import ValidationError

from gdv.geometry.placement import Placement
from gdv.geometry.profile import (
    EditorSource,
    Loop,
    Profile2D,
    ProfileDraft,
    Section3DSource,
    SplineData,
    SplineLoop,
    loop_depths,
    normalise,
    repair,
    signed_area,
    validate,
)
from synthetic import naca4


def square(x0: float = 0, y0: float = 0, side: float = 1, ccw: bool = True) -> np.ndarray:
    p = np.array([[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]], float)
    return p if ccw else p[::-1]


def draft(*loops, **kwargs) -> ProfileDraft:
    return ProfileDraft(
        name=kwargs.pop("name", "prova"),
        loops=[Loop(points=[tuple(map(float, pt)) for pt in p]) for p in loops],
        source=kwargs.pop("source", EditorSource()),
        **kwargs,
    )


def codes(report) -> list[tuple[str, int | None]]:
    return [(i.code, i.loop) for i in report.issues]


def test_a_simple_square_is_valid():
    report = validate(draft(square()))
    assert report.valid and report.issues == []


def test_a_naca_profile_is_valid():
    assert validate(draft(naca4("2412", 120, 0.3))).valid


@pytest.mark.parametrize(
    ("points", "code"),
    [
        ([[0, 0], [1, 1], [1, 0], [0, 1]], "self_intersection"),  # bow tie
        ([[0, 0], [2, 0], [2, 2], [1, 0], [0, 2]], "self_intersection"),  # touches itself
        ([[0, 0], [2, 0], [2, 1], [3, 1], [2, 1], [0, 1]], "self_intersection"),  # repeated
        ([[0, 0], [1, 0], [1, 0], [0, 1]], "points_too_close"),
        ([[0, 0], [1, 0], [2, 0]], "zero_area"),
        ([[0, 0], [1, 0]], "too_few_points"),
    ],
)
def test_invalid_loops_are_reported_by_code(points, code):
    report = validate(draft(np.array(points, float)))
    assert not report.valid
    assert codes(report) == [(code, 0)]


def test_a_spike_back_along_an_edge_intersects_itself():
    spike = [[0, 0], [2, 0], [2, 1], [3, 1], [2.5, 1], [0, 1]]
    assert codes(validate(draft(np.array(spike, float)))) == [("self_intersection", 0)]


def test_the_location_of_a_crossing_is_given():
    report = validate(draft(np.array([[0, 0], [1, 1], [1, 0], [0, 1]], float)))
    assert report.issues[0].at == pytest.approx((0.5, 0.5))


def test_points_closer_than_a_micrometre_are_an_error_farther_are_not():
    base = square()
    near = np.insert(base, 1, base[0] + [5e-7, 0], axis=0)
    far = np.insert(base, 1, base[0] + [2e-6, 0], axis=0)
    assert codes(validate(draft(near))) == [("points_too_close", 0)]
    assert validate(draft(far)).valid


def test_size_limits():
    many = [square(3 * i) for i in range(51)]
    assert ("too_many_loops", None) in codes(validate(draft(*many)))
    big = np.stack([np.cos(t := np.linspace(0, 2 * np.pi, 20_002)[:-1]), np.sin(t)], 1)
    assert codes(validate(draft(big))) == [("too_many_points", None)]
    assert codes(validate(draft())) == [("no_loops", None)]


def test_coordinates_must_be_finite():
    with pytest.raises(ValidationError):
        draft(np.array([[0, 0], [1, np.nan], [0, 1]]))


def test_nesting_counts_containing_loops():
    outer = square(0, 0, 10)
    hole = square(2, 2, 6)
    island = square(4, 4, 2)
    apart = square(20, 0, 1)
    assert loop_depths([outer, hole, island, apart]) == [0, 1, 2, 0]


def test_overlapping_bodies_are_both_outer():
    body = square(0, 0, 10)
    wheel = square(8, -1, 3)  # partly inside the body
    assert loop_depths([body, wheel]) == [0, 0]


def test_normalise_orients_outer_ccw_and_holes_cw():
    p = normalise(draft(square(0, 0, 10, ccw=False), square(2, 2, 6, ccw=True)))
    assert signed_area(p.loops[0].points) > 0
    assert signed_area(p.loops[1].points) < 0


def test_normalise_reverses_the_spline_with_its_loop():
    cw = square(ccw=False)
    spline = SplineData(
        loops=[SplineLoop(kind="spline", points=[tuple(q) for q in cw], corners=[1, 0, 0, 0])]
    )
    p = normalise(draft(cw, spline=spline))
    assert p.spline is not None and p.spline.loops[0] is not None
    assert p.spline.loops[0].points == [tuple(q) for q in cw[::-1]]
    assert p.spline.loops[0].corners == [False, False, False, True]


def test_the_spline_must_match_the_loops():
    with pytest.raises(ValidationError):
        draft(square(), square(5), spline=SplineData(loops=[None]))


def test_repair_splits_a_bow_tie_into_two_valid_pieces():
    bow = np.array([[0, 0], [2, 2], [2, 0], [0, 2]], float)
    fixed = repair(draft(bow))
    assert validate(fixed).valid
    assert len(fixed.loops) == 2
    assert sum(abs(signed_area(loop.points)) for loop in fixed.loops) == pytest.approx(2.0)


def test_repair_unites_overlapping_bodies_and_drops_slivers():
    a, b = square(0, 0, 2), square(1, 1, 2)
    tiny = square(10, 10, 1e-3)
    fixed = repair(draft(a, b, tiny), min_area=1e-4)
    assert len(fixed.loops) == 1
    assert abs(signed_area(fixed.loops[0].points)) == pytest.approx(7.0)


def test_repair_keeps_holes():
    fixed = normalise(repair(draft(square(0, 0, 10), square(2, 2, 6, ccw=False))))
    areas = sorted(signed_area(loop.points) for loop in fixed.loops)
    assert areas == pytest.approx([-36.0, 100.0])


def test_profile_round_trips_through_json_with_its_source():
    source = Section3DSource(
        model_id="0123456789abcdef",
        model_name="ala",
        placement=Placement(scale=0.001),
        plane="vertical",
        depth_m=0.25,
        depth_fraction=0.4,
        incidence_deg=4,
        roll_deg=0,
        tilt_deg=10,
    )
    profile = Profile2D(**draft(naca4(), source=source).model_dump())
    again = Profile2D.model_validate_json(profile.model_dump_json())
    assert again == profile
    edited = EditorSource(derived_from=profile.id, origin=source)
    assert EditorSource.model_validate(edited.model_dump()).origin == source
