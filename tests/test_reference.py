# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests 21-24 and 26: the physics, on the reference solver (SPEC §10.8, §18).

The validation cases (22-24) run minutes on the CPU and are marked ``slow``:
``uv run pytest -q -m slow`` runs them. They use chambers longer than the
program's 2 L upstream where the test is about the solver, not the chamber.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from gdv.geometry.profile import EditorSource, Loop, ProfileDraft
from gdv.geometry.raster2d import outer_loops, place, rasterize
from gdv.physics.fluids import properties
from gdv.physics.planner import CaseSetup, plan
from reference.lbm2d import LatticeCase, Reference, check_moments
from synthetic import naca4


def test_written_out_collision_matches_the_matrices():
    assert check_moments() < 1e-7


def circle(cx: float, cy: float, d: float, n: int = 800) -> list[tuple[float, float]]:
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return [(cx + d / 2 * math.cos(a), cy + d / 2 * math.sin(a)) for a in t]


# --- test 21: Poiseuille ---------------------------------------------------------------


def test_21_poiseuille_profile():
    width = 64
    nx, ny = 400, width + 2
    mask = np.zeros((ny, nx), np.uint8)
    mask[0] = mask[-1] = 1  # no-slip walls by bounce-back: halfway, at y = 1 and y = 65
    u, nu = 0.04, 0.1
    ref = Reference(
        LatticeCase(
            nx=nx, ny=ny, tau=3 * nu + 0.5, u_lat=u, mask=mask, ramp_steps=500, cs=0.0,
            sponge_start=int(nx * 0.92),
        )
    )  # fmt: skip
    ref.run(30_000)
    column = ref.ux[1:-1, 300].astype(np.float64)
    y = np.arange(width) + 0.5  # cell centres, walls at 0 and width
    mean = column.mean()
    exact = 1.5 * mean * (1 - (2 * y / width - 1) ** 2)
    error = np.sqrt(np.mean((column - exact) ** 2)) / np.sqrt(np.mean(exact**2))
    assert error < 0.01, error
    assert ref.rho_inf() == pytest.approx(1.0, abs=0.05)  # the pressure level holds


# --- test 26: forced instability --------------------------------------------------------


def summary(ref: Reference, length: float) -> dict:
    """What a result keeps: an unstable case keeps no numbers (SPEC §9.5)."""
    if ref.unstable():
        return {"status": "unstable", "cd": None, "cl": None}
    cd, cl, _ = ref.coefficients(length)
    return {"status": "provisional", "cd": cd, "cl": cl}


def test_26_forced_instability_is_detected():
    # MRT alone survives tau = 0.5001 at U = 0.08 on this grid for 18 000 steps
    # (measured); at 0.15 it fails within 1500.
    d = 20
    nx, ny = 240, 160
    mask = rasterize([circle(60, 80.3, d)], nx, ny, 1.0)
    ref = Reference(
        LatticeCase(nx=nx, ny=ny, tau=0.5001, u_lat=0.15, mask=mask, ramp_steps=200, cs=0.0)
    )
    for _ in range(100):
        ref.run(200)
        if ref.unstable():
            break
    result = summary(ref, d)
    assert result["status"] == "unstable"
    assert all(v is None or math.isfinite(v) for v in result.values() if not isinstance(v, str))


def test_26_the_subgrid_model_keeps_it_stable():
    d = 20
    nx, ny = 240, 160
    mask = rasterize([circle(60, 80.3, d)], nx, ny, 1.0)
    ref = Reference(LatticeCase(nx=nx, ny=ny, tau=0.502, u_lat=0.08, mask=mask, ramp_steps=200))
    ref.run(8000)
    assert not ref.unstable()


# --- test 22-23: cylinder ----------------------------------------------------------------

D = 40


def cylinder_case(re: float, upstream: float, downstream: float, offset: float = 0.0):
    """D = 40 cells, chamber 20 D tall (blockage 5%), free-slip walls."""
    nx, ny = int((upstream + 1 + downstream) * D), 20 * D
    cx, cy = upstream * D + D / 2, ny / 2
    mask = rasterize([circle(cx, cy + offset, D)], nx, ny, 1.0)
    u = 0.08
    case = LatticeCase(
        nx=nx, ny=ny, tau=3 * u * D / re + 0.5, u_lat=u, mask=mask, ramp_steps=1000,
        sponge_start=int(round(nx * 0.92)),
    )  # fmt: skip
    return case, cx, cy


@pytest.mark.slow
def test_22_cylinder_re20():
    case, cx, cy = cylinder_case(20, 10, 10)
    ref = Reference(case)
    ref.run(12_000)
    history = []
    for _ in range(8):
        ref.run(250)
        history.append(ref.coefficients(D, cx, cy)[0])
    cd = float(np.mean(history))
    assert 1.95 <= cd <= 2.25, cd
    assert np.ptp(history) < 0.005 * cd  # steady
    # Recirculation: where the centre line behind the cylinder turns downstream again.
    row = 0.5 * (ref.ux[case.ny // 2] + ref.ux[case.ny // 2 - 1])
    x = np.arange(case.nx) + 0.5
    back = np.flatnonzero((x > cx + D / 2) & (row < 0))
    length = (x[back].max() + 0.5 - (cx + D / 2)) / D
    print(f"test 22: Cd {cd:.4f}, L/D {length:.3f}")
    assert 0.8 <= length <= 1.1, length


def strouhal(cl: np.ndarray, every: int, length: float, u: float) -> tuple[float, float]:
    """Frequency peak of Cl as a Strouhal number, and its height over the noise."""
    signal = (cl - cl.mean()) * np.hanning(len(cl))
    spectrum = np.abs(np.fft.rfft(signal))
    freq = np.fft.rfftfreq(len(cl), d=every)
    k = int(np.argmax(spectrum[1:])) + 1
    return freq[k] * length / u, spectrum[k] / np.median(spectrum[1:])


@pytest.mark.slow
def test_23_cylinder_re100():
    case, cx, cy = cylinder_case(100, 10, 10)
    # Off centre for a while, then centred: the wake starts shedding sooner.
    shifted = rasterize([circle(cx, cy + 3, D)], case.nx, case.ny, 1.0)
    centred = case.mask
    case.mask = shifted
    ref = Reference(case)
    ref.run(4000)
    ref.set_mask(centred)
    ref.run(36_000)
    samples = []
    for _ in range(3000):  # 24 000 steps, about 8 shedding periods
        ref.run(8)
        samples.append(ref.coefficients(D, cx, cy))
    cd, cl, _ = np.array(samples).T
    st, peak = strouhal(cl, 8, D, case.u_lat)
    print(f"test 23: Cd {cd.mean():.4f}, St {st:.4f}, Cl amplitude {cl.std() * 2**0.5:.3f}")
    assert 1.25 <= cd.mean() <= 1.45, cd.mean()
    assert 0.155 <= st <= 0.175, st
    assert peak > 10


# --- test 24: NACA 0012 ----------------------------------------------------------------


def naca_run(angle: float) -> tuple[float, float]:
    chord = 1.0
    profile = ProfileDraft(
        name="NACA 0012",
        loops=[Loop(points=[tuple(p) for p in naca4("0012", 200, chord)])],
        source=EditorSource(),
    )
    speed = 1e4 * properties("aria", 20).kinematic_viscosity / chord
    p = plan(CaseSetup(profile=profile, speed=speed, angle_deg=angle, resolution="normale"))
    assert p.re_sim == pytest.approx(1e4, rel=1e-6)
    loops = outer_loops([loop.points for loop in profile.loops], "orientation")
    mask = rasterize(
        [
            [(x / p.dx, y / p.dx) for x, y in loop]
            for loop in place(loops, p.pivot, p.position, angle)
        ],
        p.nx,
        p.ny,
        1.0,
    )
    ref = Reference(LatticeCase.from_plan(p, mask))
    ref.run(p.transient_steps + int(10 * p.tc_steps))
    samples = []
    for _ in range(int(6 * p.tc_steps) // 8):
        ref.run(8)
        samples.append(ref.coefficients(p.l_lat)[:2])
    cd, cl = np.array(samples).T
    return float(cd.mean()), float(cl.mean())


@pytest.mark.slow
def test_24_naca0012_re1e4():
    cd0, cl0 = naca_run(0.0)
    cd_plus, cl_plus = naca_run(5.0)
    cd_minus, cl_minus = naca_run(-5.0)
    print(f"test 24: Cd(0) {cd0:.4f}, Cl(0) {cl0:.4f}, Cl(+5) {cl_plus:.4f}, Cl(-5) {cl_minus:.4f}")
    assert cd0 > 0
    assert abs(cl0) < 0.02
    assert 0.25 <= cl_plus <= 0.65, cl_plus
    assert cl_minus == pytest.approx(-cl_plus, rel=0.03)
