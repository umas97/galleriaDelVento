# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests 17-20: the planner, the fluids and the shared lattice constants (SPEC §9, §10.2)."""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from apiclient import Api
from gdv import lattice
from gdv.geometry.placement import Placement
from gdv.geometry.profile import EditorSource, Loop, ProfileDraft, Section3DSource
from gdv.physics import planner
from gdv.physics.fluids import properties
from gdv.physics.planner import CaseSetup, Domain, ReferenceLength, plan, reynolds_text
from synthetic import naca4

ROOT = Path(__file__).resolve().parents[1]


def naca(chord=1.0, name="0012") -> ProfileDraft:
    return ProfileDraft(
        name="naca",
        loops=[Loop(points=[tuple(p) for p in naca4(name, 200, chord)])],
        source=EditorSource(),
    )


def box(w=4.0, h=1.5) -> ProfileDraft:
    pts = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]
    return ProfileDraft(name="box", loops=[Loop(points=pts)], source=EditorSource())


def speed_for(re: float, length: float, fluid="aria", t=20.0) -> float:
    return re * properties(fluid, t).kinematic_viscosity / length


# --- test 19: fluids -------------------------------------------------------------

REFERENCE_FLUIDS = {
    # °C: (density kg/m³, kinematic viscosity m²/s) -- usual tables at 1 atm
    ("aria", 0): (1.293, 1.338e-5),
    ("aria", 20): (1.204, 1.516e-5),
    ("aria", 40): (1.127, 1.702e-5),
    ("acqua", 0): (999.8, 1.792e-6),
    ("acqua", 20): (998.2, 1.004e-6),
    ("acqua", 40): (992.2, 0.658e-6),
}


@pytest.mark.parametrize(("fluid", "t"), list(REFERENCE_FLUIDS))
def test_19_fluid_properties(fluid, t):
    rho, nu = REFERENCE_FLUIDS[fluid, t]
    got = properties(fluid, t)
    assert got.density == pytest.approx(rho, rel=0.005)
    assert got.kinematic_viscosity == pytest.approx(nu, rel=0.005)


def test_19_speed_of_sound():
    assert properties("aria", 20).speed_of_sound == pytest.approx(343.2, rel=0.005)
    assert properties("acqua", 20).speed_of_sound == pytest.approx(1482, rel=0.005)


# --- test 17: similarity -------------------------------------------------------------


def test_17_low_reynolds_is_fully_similar():
    p = plan(CaseSetup(profile=naca(0.015), speed=speed_for(100, 0.015)))
    assert p.re_real == pytest.approx(100)
    assert p.re_sim == pytest.approx(100, rel=1e-9)
    assert not p.partial_similarity
    assert p.tau > p.tau_min
    assert "Re simulato" not in p.texts.reynolds


def test_17_high_reynolds_is_partially_similar():
    p = plan(CaseSetup(profile=naca(4.0), fluid="acqua", speed=speed_for(1e7, 4.0, "acqua")))
    assert p.re_real == pytest.approx(1e7)
    assert p.tau == pytest.approx(planner.TAU_MIN)
    assert p.partial_similarity
    assert p.re_sim < 0.95 * p.re_real
    assert p.texts.reynolds.startswith("Re reale 1,0·10⁷ — Re simulato ")


def test_17_a_fixed_floor_has_its_own_tau_min():
    building = box(10.0, 10.0)
    common = dict(profile=building, speed=10, max_blockage=0.08)
    fixed = plan(CaseSetup(**common, ground="fixed", inlet_profile="boundary_layer"))
    moving = plan(CaseSetup(**common, ground="moving"))
    assert fixed.tau == pytest.approx(planner.TAU_MIN_FIXED_FLOOR) == fixed.tau_min
    assert moving.tau == pytest.approx(planner.TAU_MIN) == moving.tau_min


@pytest.mark.parametrize("speed", [0.1, 1.0, 15.0, 120.0])
@pytest.mark.parametrize("inlet", ["uniform", "boundary_layer"])
def test_17_lattice_velocity_and_time_step(speed, inlet):
    setup = CaseSetup(
        profile=box(20.0, 30.0), speed=speed, ground="fixed", inlet_profile=inlet, max_blockage=0.08
    )
    p = plan(setup)
    assert p.u_lat <= 0.1
    if inlet == "boundary_layer":
        top = (p.height_m / 10.0) ** p.inlet_exponent
        assert p.u_lat * top <= 0.1 + 1e-12
    # Δt is the time in which the flow crosses U_lat cells.
    assert p.dt == pytest.approx(p.dx * p.u_lat / speed)
    assert p.tc_steps == pytest.approx(p.reference_length / speed / p.dt)
    assert p.ramp_steps == max(1000, math.ceil(0.5 * p.tc_steps))


def test_17_resolution_presets_keep_their_cell_count():
    for name, cells in planner.CELLS.items():
        p = plan(CaseSetup(profile=naca(), resolution=name))
        assert p.nx % 4 == 0 and p.ny % 4 == 0
        assert p.nx * p.ny == pytest.approx(cells, rel=0.02)


def test_17_retry_halves_the_simulated_reynolds():
    setup = CaseSetup(profile=naca(1.0), speed=15)
    first = plan(setup)
    retry = plan(setup.model_copy(update={"re_sim_scale": 0.5}))
    assert retry.re_sim == pytest.approx(first.re_sim / 2)
    assert (retry.nx, retry.ny, retry.dx) == (first.nx, first.ny, first.dx)


def test_17_reynolds_text():
    assert reynolds_text(4.1e6) == "4,1·10⁶"
    assert reynolds_text(23000) == "2,3·10⁴"
    assert reynolds_text(99960) == "1,0·10⁵"
    assert reynolds_text(20) == "20"
    assert reynolds_text(2.5) == "2,5"


def test_17_mach_warning():
    assert plan(CaseSetup(profile=naca(), speed=120)).mach_warning
    assert not plan(CaseSetup(profile=naca(), speed=30)).mach_warning


# --- the chamber (SPEC §9.2) ---------------------------------------------------------


def test_chamber_upstream_downstream_and_blockage():
    p = plan(CaseSetup(profile=naca(1.0), speed=15, max_blockage=0.05))
    x0, y0, x1, y1 = 0.0, -0.06, 1.0, 0.06  # NACA 0012, chord 1
    left = p.position[0] - p.pivot[0] + x0
    right = p.position[0] - p.pivot[0] + x1
    assert left == pytest.approx(2.0, rel=1e-6)
    assert p.width_m - right == pytest.approx(5.0, rel=0.02)
    assert (y1 - y0) / p.height_m <= 0.05 + 1e-3
    # Centred vertically without a floor.
    assert p.position[1] - p.pivot[1] == pytest.approx(p.height_m / 2, rel=1e-9)


def test_chamber_is_longer_at_low_reynolds():
    p = plan(CaseSetup(profile=naca(0.015), speed=speed_for(100, 0.015)))
    left = p.position[0] - p.pivot[0]
    assert left == pytest.approx(planner.UPSTREAM_LOW_RE * 0.015, rel=1e-6)
    assert p.width_m == pytest.approx(16 * 0.015, rel=0.02)


def test_chamber_with_floor_keeps_the_real_height():
    car = box(4.0, 1.5)
    car = car.model_copy(
        update={"loops": [Loop(points=[(x, y + 0.2) for x, y in car.loops[0].points])]}
    )
    p = plan(CaseSetup(profile=car, ground="moving", max_blockage=0.08, speed=30))
    assert p.position[1] - p.pivot[1] == pytest.approx(0.0)  # profile y = height over the floor
    assert 1.5 / p.height_m <= 0.08 + 1e-3


def test_moving_floor_keeps_a_gap_of_a_few_cells():
    # A profile below y = 0 sits on the floor at its lowest point: on the belt that
    # closes a pocket the belt pumps into (unstable), so it is lifted by 3 cells.
    moving = plan(CaseSetup(profile=naca(), ground="moving"))
    assert moving.floor_gap_m == pytest.approx(planner.MOVING_FLOOR_GAP_CELLS * moving.dx)
    lowest = min(y for x, y in naca().loops[0].points)
    bottom = moving.position[1] - moving.pivot[1] + lowest
    assert bottom == pytest.approx(moving.floor_gap_m, abs=1e-12)
    # A fixed floor can be touched.
    fixed = plan(CaseSetup(profile=naca(), ground="fixed"))
    assert fixed.floor_gap_m == 0
    assert fixed.position[1] - fixed.pivot[1] + lowest == pytest.approx(0.0, abs=1e-12)
    # Plans saved before the field existed still read.
    data = moving.model_dump()
    del data["floor_gap_m"]
    assert type(moving).model_validate(data).floor_gap_m == 0


def test_chamber_with_boundary_layer_needs_a_floor():
    with pytest.raises(ValueError, match="pavimento"):
        CaseSetup(profile=box(), inlet_profile="boundary_layer", ground="none")


def test_temperature_range():
    with pytest.raises(ValueError, match="acqua"):
        CaseSetup(profile=naca(), fluid="acqua", temperature_c=60)


# --- test 18: what replans and what does not -------------------------------------------


def section(depth: float) -> ProfileDraft:
    """A live section: same envelope, a different cut at every depth."""
    scale = 1.0 - 0.5 * depth
    pts = [tuple(p) for p in naca4("0012", 120, scale)]
    return ProfileDraft(
        name="sezione",
        loops=[Loop(points=pts)],
        source=Section3DSource(
            model_id="m",
            model_name="ala",
            placement=Placement(scale=1.0),
            plane="vertical",
            depth_m=depth,
            depth_fraction=depth,
        ),
    )


def live_setup(depth=0.2, angle=4.0, position=None, domain=None, reference=None) -> CaseSetup:
    return CaseSetup(
        profile=section(depth),
        envelope=(0.0, -0.06, 1.0, 0.06),
        speed=15,
        angle_deg=angle,
        position=position,
        domain=domain,
        reference_length=reference or ReferenceLength(kind="chord", value_m=1.0),
    )


def test_18_section_incidence_and_position_do_not_replan():
    first = plan(live_setup())
    keep = Domain(width_m=first.width_m, height_m=first.height_m)
    for change in (
        {"depth": 0.7},
        {"angle": 7.5},
        {"angle": -3.0},
        {"position": (first.position[0] + 0.3, first.position[1] - 0.1)},
    ):
        again = plan(live_setup(**{"position": first.position, "domain": keep, **change}))
        expected = (
            first
            if "position" not in change
            else first.model_copy(update={"position": change["position"]})
        )
        assert again == expected, change


def test_18_reference_length_changes_only_re_and_tc():
    first = plan(live_setup())
    keep = Domain(width_m=first.width_m, height_m=first.height_m)
    half = plan(
        live_setup(
            position=first.position,
            domain=keep,
            reference=ReferenceLength(kind="chord", value_m=0.5),
        )
    )
    for name in ("nx", "ny", "dx", "dt", "tau", "u_lat", "nu_lat", "width_m", "height_m"):
        assert getattr(half, name) == getattr(first, name), name
    assert half.re_real == pytest.approx(first.re_real / 2)
    assert half.re_sim == pytest.approx(first.re_sim / 2)
    assert half.tc_steps == pytest.approx(first.tc_steps / 2)
    assert not half.resized


def test_18_rotation_resizes_only_past_ten_percent_blockage():
    first = plan(live_setup(angle=0.0))
    keep = Domain(width_m=first.width_m, height_m=first.height_m)
    # NACA 0012: blockage 5% at 0°; at 15° about 32 cm of 2.4 m (13%).
    small = plan(live_setup(angle=4.0, position=first.position, domain=keep))
    assert not small.resized and small.nx == first.nx and small.dx == first.dx
    turned = np.array(naca4("0012", 120, 1.0))
    for angle, should in ((6.0, False), (15.0, True)):
        a = math.radians(-angle)
        y = turned[:, 0] * math.sin(a) + turned[:, 1] * math.cos(a)
        blockage = (y.max() - y.min()) / first.height_m
        result = plan(live_setup(angle=angle, position=first.position, domain=keep))
        assert result.resized is should, (angle, blockage)
        assert bool(blockage > 0.10) is should


def test_18_a_body_outside_the_chamber_resizes_it():
    first = plan(live_setup(angle=0.0))
    keep = Domain(width_m=first.width_m, height_m=first.height_m)
    off = (first.position[0], first.height_m - 0.01)
    result = plan(live_setup(angle=0.0, position=off, domain=keep))
    assert result.resized


# --- test 20: one source for the lattice -------------------------------------------------


def test_20_generated_typescript_matches_python():
    done = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gen_lattice_ts.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr


def test_20_lattice_is_consistent():
    assert np.allclose(lattice.MINV @ lattice.M, np.eye(9))
    assert lattice.W.sum() == pytest.approx(1.0)
    # Second-order isotropy of the weights: Σ w c c = 1/3 I.
    cc = np.einsum("k,ki,kj->ij", lattice.W, lattice.C, lattice.C)
    assert np.allclose(cc, np.eye(2) / 3)


# --- the API ------------------------------------------------------------------------------


def test_plan_over_http(live):
    api = Api(live.port)
    setup = CaseSetup(profile=naca(), speed=15).model_dump(mode="json")
    status, body = api.json("POST", "/api/cases/plan", json_body=setup)
    assert status == 200, body
    assert body["nx"] == plan(CaseSetup(profile=naca(), speed=15)).nx
    setup["temperature_c"] = 90
    status, body = api.json("POST", "/api/cases/plan", json_body=setup)
    assert status == 422 and "temperatura" in body["technical"]
