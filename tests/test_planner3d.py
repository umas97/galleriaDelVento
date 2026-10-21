# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests 35-36: the D3Q19 constants and the 3D planner (SPEC §24.3-24.4).

Test 35 is test 20 for the 3D lattice: the generated TypeScript matches
``gdv/lattice3d.py`` (``gen_lattice_ts.py --check`` covers both files, test
20), the matrices are consistent and the equilibria written out are the
moments of the usual equilibrium. Test 36 is tests 17-18 for the 3D planner.
"""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from apiclient import Api
from gdv import lattice3d
from gdv.physics import planner3d
from gdv.physics.fluids import properties
from gdv.physics.planner import MOVING_FLOOR_GAP_CELLS, U_LAT_MAX
from gdv.physics.planner3d import CELLS_3D, TAU_MIN_3D, CaseSetup3D, plan3d
from reference.lbm3d import check_moments

ROOT = Path(__file__).resolve().parents[1]


def sphere(d=0.1, height=0.5, **extra) -> CaseSetup3D:
    values = {
        "model_id": "sfera",
        "name": "sfera",
        "pivot": (0.0, 0.0, height),
        "model_size": (d, d, d),
        "body_box": (-d / 2, -d / 2, -d / 2, d / 2, d / 2, d / 2),
        "frontal_area_m2": math.pi * d * d / 4,
    }
    values.update(extra)
    return CaseSetup3D(**values)


def car(**extra) -> CaseSetup3D:
    values = {
        "model_id": "auto",
        "name": "auto",
        "pivot": (0.0, 0.0, 0.85),
        "model_size": (4.5, 1.8, 1.4),
        "body_box": (-2.25, -0.9, -0.7, 2.25, 0.9, 0.7),
        "frontal_area_m2": 2.2,
        "speed": 30.0,
        "ground": "moving",
        "max_blockage": 0.1,
        "reference_length": {"kind": "length_x"},
    }
    values.update(extra)
    return CaseSetup3D(**values)


def speed_for(re: float, length: float) -> float:
    return re * properties("aria", 20).kinematic_viscosity / length


# --- test 35: the D3Q19 constants ------------------------------------------------------


def test_35_generated_typescript_matches_python():
    done = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gen_lattice_ts.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    text = (ROOT / "frontend" / "src" / "sim3d" / "lattice3d.generated.ts").read_text()
    assert f"export const S_M = {lattice3d.S_M!r}" in text


def test_35_lattice_is_consistent():
    assert np.allclose(lattice3d.MINV @ lattice3d.M, np.eye(19))
    assert lattice3d.W.sum() == pytest.approx(1.0)
    cc = np.einsum("k,ki,kj->ij", lattice3d.W, lattice3d.C, lattice3d.C)
    assert np.allclose(cc, np.eye(3) / 3)
    assert (lattice3d.C[lattice3d.OPPOSITE] == -lattice3d.C).all()
    for flags, sign in ((1, [1, -1, 1]), (2, [1, 1, -1]), (3, [1, -1, -1])):
        assert (lattice3d.C[lattice3d.MIRROR[:, flags]] == lattice3d.C * sign).all()
    # The rows are orthogonal: M⁻¹ is Mᵀ scaled.
    gram = lattice3d.M @ lattice3d.M.T
    assert np.allclose(gram, np.diag(np.diag(gram)))


def test_35_equilibria_are_the_moments_of_the_equilibrium():
    rng = np.random.default_rng(3)
    for _ in range(10):
        rho = 1 + rng.normal(0, 0.05)
        u = rng.normal(0, 0.06, 3)
        cu = lattice3d.C @ u
        feq = lattice3d.W * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (u @ u))
        assert np.allclose(lattice3d.M @ feq, lattice3d.equilibrium_moments(rho, rho * u))


def test_35_reference_matrices_match():
    assert check_moments() < 1e-7


# --- test 36: the 3D planner ------------------------------------------------------------


def test_36_low_reynolds_has_full_similarity():
    p = plan3d(sphere(d=0.001, speed=speed_for(20, 0.001)))
    assert p.re_real == pytest.approx(20, rel=1e-9)
    assert p.re_sim == pytest.approx(20, rel=1e-6)
    assert not p.partial_similarity
    assert p.tau > TAU_MIN_3D


def test_36_high_reynolds_is_partial():
    p = plan3d(car())
    assert p.re_real > 5e6
    assert p.tau == pytest.approx(TAU_MIN_3D)
    assert p.partial_similarity
    assert p.re_sim < 0.95 * p.re_real
    assert "Re simulato" in p.texts.reynolds
    # In 3D the fixed floor holds the same τ_min (measured, 2026-10-20).
    fixed = plan3d(car(ground="fixed"))
    assert fixed.tau == pytest.approx(TAU_MIN_3D)


@pytest.mark.parametrize("resolution", list(CELLS_3D))
def test_36_grid_follows_the_preset(resolution):
    p = plan3d(sphere(speed=10, resolution=resolution))
    cells = p.nx * p.ny * p.nz
    assert cells == pytest.approx(CELLS_3D[resolution], rel=0.06)
    assert p.nx % 2 == p.ny % 2 == p.nz % 2 == 0
    assert p.length_m == pytest.approx(p.nx * p.dx)
    assert p.u_lat <= U_LAT_MAX
    assert p.dt == pytest.approx(p.dx * p.u_lat / p.speed)
    assert p.tc_steps == pytest.approx(p.l_lat / p.u_lat)
    assert p.memory_mb == pytest.approx(2 * 19 * 4 * cells / 1e6)


def test_36_chamber_size_and_blockage():
    s = sphere(speed=10)
    p = plan3d(s)
    # 1.5 L upstream, 3 L downstream; a cross-section blocked by 8%.
    assert p.length_m == pytest.approx(5.5 * 0.1, rel=0.02)
    assert p.blockage == pytest.approx(0.08, rel=0.03)
    assert p.blockage == pytest.approx(s.frontal_area_m2 / (p.width_m * p.height_m))
    # The body sits upstream at 1.5 L, in the middle of the section.
    ox, oy, oz = p.offset
    assert ox - 0.05 == pytest.approx(0.15)
    assert oy == pytest.approx(p.width_m / 2)
    assert oz == pytest.approx(p.height_m / 2)
    # A thin wing gets at least half its largest frontal size (the span) as margin.
    wing = CaseSetup3D(
        model_id="ala", name="ala", pivot=(0, 0, 1), model_size=(0.25, 1.0, 0.03),
        body_box=(-0.125, -0.5, -0.015, 0.125, 0.5, 0.015), frontal_area_m2=0.025,
    )  # fmt: skip
    w = plan3d(wing)
    assert w.width_m >= 2.0 - 2 * w.dx
    assert w.blockage < 0.08
    # A long low body is not given a margin out of its length (SPEC §24.8): a car
    # 22 cm long, 6.6 cm wide and 5.7 cm tall on the belt fills the 10% it may.
    slim = plan3d(car(
        pivot=(0.0, 0.0, 0.0285), model_size=(0.222, 0.066, 0.057),
        body_box=(-0.111, -0.033, -0.0285, 0.111, 0.033, 0.0285), frontal_area_m2=0.0024,
    ))  # fmt: skip
    assert slim.blockage == pytest.approx(0.1, rel=0.03)
    assert slim.width_m < 0.222


def test_36_floor_keeps_the_real_height_and_the_gap():
    p = plan3d(car())
    # The lowest point (0.85 − 0.7 = 0.15 m) is above the belt's 3 cells: unchanged.
    assert p.floor_gap_m == pytest.approx(MOVING_FLOOR_GAP_CELLS * p.dx)
    if p.floor_gap_m <= 0.15:
        assert p.offset[2] == pytest.approx(0.85)
    low = plan3d(car(pivot=(0.0, 0.0, 0.7)))  # touching the belt: lifted by the gap
    assert low.offset[2] - 0.7 == pytest.approx(low.floor_gap_m)
    # Turned below the floor, a body on a fixed floor rests on it.
    sunk = plan3d(car(ground="fixed", pivot=(0.0, 0.0, 0.5)))
    assert sunk.offset[2] + (-0.7) == pytest.approx(0.0, abs=1e-12)
    assert sunk.floor_gap_m == 0.0
    # The chamber holds the body with its margin above.
    assert sunk.height_m > 1.4


def test_36_reference_length_changes_only_the_similarity_numbers():
    base = plan3d(car(reference_length={"kind": "length_x"}))
    other = plan3d(car(reference_length={"kind": "height"}))
    for name in ("nx", "ny", "nz", "dx", "dt", "tau", "offset"):
        assert getattr(base, name) == getattr(other, name), name
    ratio = 4.5 / 1.4
    assert base.re_real / other.re_real == pytest.approx(ratio)
    assert base.re_sim / other.re_sim == pytest.approx(ratio)
    assert base.tc_steps / other.tc_steps == pytest.approx(ratio)


def test_36_reference_area_changes_only_the_normalisation():
    base = plan3d(car())
    voxels = plan3d(car(reference_area_m2=2.0))
    assert (base.nx, base.ny, base.nz, base.dx, base.tau) == (
        voxels.nx, voxels.ny, voxels.nz, voxels.dx, voxels.tau,
    )  # fmt: skip
    assert voxels.a_lat == pytest.approx(2.0 / base.dx**2)
    # The blockage correction follows the reference area (SPEC §24.6): (1 − A/C)².
    section = base.width_m * base.height_m
    assert voxels.blockage_correction == pytest.approx((1 - 2.0 / section) ** 2)
    assert base.blockage_correction == pytest.approx((1 - 2.2 / section) ** 2)
    assert voxels.force_per_coefficient == pytest.approx(0.5 * base.fluid.density * 900 * 2.0)


def test_36_boundary_layer_keeps_the_ceiling_below_the_limit():
    building = CaseSetup3D(
        model_id="ed", name="edificio", pivot=(0, 0, 60), model_size=(30, 30, 120),
        body_box=(-15, -15, -60, 15, 15, 60), frontal_area_m2=3600, speed=10,
        ground="fixed", inlet_profile="boundary_layer", reference_length={"kind": "height"},
    )  # fmt: skip
    p = plan3d(building)
    ceiling = p.u_lat * (p.height_m / 10.0) ** p.inlet_exponent
    assert ceiling <= U_LAT_MAX + 1e-12
    assert p.inlet_reference_cells == pytest.approx(10.0 / p.dx)


def test_36_checks_the_setup():
    with pytest.raises(ValidationError, match="strato limite"):
        sphere(inlet_profile="boundary_layer")
    with pytest.raises(ValidationError, match="temperatura"):
        sphere(fluid="acqua", temperature_c=60)
    with pytest.raises(ValidationError, match="area frontale"):
        sphere(frontal_area_m2=1.0)


def test_36_retry_halves_the_simulated_reynolds():
    p = plan3d(car())
    q = plan3d(car(re_sim_scale=0.5))
    assert q.re_sim == pytest.approx(p.re_sim / 2)
    assert (q.nx, q.ny, q.nz) == (p.nx, p.ny, p.nz)


def test_plan3d_over_http(live):
    api = Api(live.port)
    status, body = api.json("POST", "/api/cases/plan3d", json_body=car().model_dump(mode="json"))
    assert status == 200, body
    assert body["nx"] == plan3d(car()).nx
    assert body["texts"]["grid"].endswith(" cm")
    status, _ = api.json("POST", "/api/cases/plan3d", json_body={"model_id": "x"})
    assert status == 422


def test_cell_text_units():
    assert plan3d(sphere(d=0.001, speed=1)).texts.grid.endswith(" mm")
    assert planner3d._round_cells(17.2) == 18
