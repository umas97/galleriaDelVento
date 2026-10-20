# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests 37-38: the 3D physics, on the 3D reference solver (SPEC §24.4).

Test 37 is the Poiseuille flow of a square duct, against the series solution;
with it, a forced instability that the density check catches (as test 26).
Test 38, the sphere at Re 20 and 100 at the Normale resolution, runs a quarter
of an hour on the CPU and is marked ``slow``.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from gdv.physics.fluids import properties
from gdv.physics.planner3d import CaseSetup3D, plan3d
from reference.lbm3d import LatticeCase3D, Reference3D


def duct_profile(a: int) -> np.ndarray:
    """Fully developed flow in a square duct of side a (cells), at the cell centres, mean 1."""
    y = np.arange(a) + 0.5
    yy, zz = np.meshgrid(y, y, indexing="xy")
    u = np.zeros_like(yy)
    for n in range(1, 100, 2):
        u += (
            (1 - np.cosh(n * np.pi * (zz - a / 2) / a) / np.cosh(n * np.pi / 2))
            * np.sin(n * np.pi * yy / a)
            / n**3
        )
    return u / u.mean()


# --- test 37: square duct ------------------------------------------------------------


def test_37_square_duct_poiseuille():
    a = 24
    nx, ny, nz = 96, a + 2, a + 2
    mask = np.zeros((nz, ny, nx), np.uint8)
    mask[0] = mask[-1] = 1  # no-slip walls by bounce-back: halfway, at 1 and a + 1
    mask[:, 0] = mask[:, -1] = 1
    ref = Reference3D(
        LatticeCase3D(
            nx=nx, ny=ny, nz=nz, tau=1.0, u_lat=0.03, mask=mask, ramp_steps=500, cs=0.0,
            sponge_start=int(nx * 0.92),
        )
    )  # fmt: skip
    ref.run(3000)
    level = ref.rho_inf()
    ref.run(1000)
    u = ref.macro()[1][1:-1, 1:-1, 60]
    exact = duct_profile(a) * u.mean()
    error = np.sqrt(np.mean((u - exact) ** 2)) / np.sqrt(np.mean(exact**2))
    assert error < 0.01, error
    # The pressure level is the one that drives the duct, and it holds.
    assert ref.rho_inf() == pytest.approx(level, abs=1e-3)
    assert not ref.unstable()


def test_37_forced_instability_is_detected():
    # Without the subgrid model, tau = 0.5001 at U = 0.15 fails within 100 steps;
    # with it, tau = 0.502 at U = 0.08 holds (measured).
    nx, ny, nz = 96, 48, 48
    z, y, x = np.mgrid[0:nz, 0:ny, 0:nx] + 0.5
    mask = (((x - 24) ** 2 + (y - 24.3) ** 2 + (z - 23.8) ** 2) < 64).astype(np.uint8)
    ref = Reference3D(
        LatticeCase3D(nx=nx, ny=ny, nz=nz, tau=0.5001, u_lat=0.15, mask=mask, ramp_steps=100, cs=0)
    )
    for _ in range(20):
        ref.run(50)
        if ref.unstable():
            break
    assert ref.unstable()
    stable = Reference3D(
        LatticeCase3D(nx=nx, ny=ny, nz=nz, tau=0.502, u_lat=0.08, mask=mask, ramp_steps=100)
    )
    stable.run(1000)
    assert not stable.unstable()
    assert all(math.isfinite(v) for v in stable.forces())


# --- test 38: sphere -----------------------------------------------------------------

#: Schiller–Naumann, Cd = 24/Re (1 + 0.15 Re^0.687): 2.61 at Re 20, 1.09 at Re 100.
SPHERE_CD = {20: 2.61, 100: 1.09}


def blockage_corrected(cd: float, blockage: float) -> float:
    """Continuity correction: the flow passes the body at U / (1 − A/C), so
    Cd_c = Cd (1 − A/C)². Free-slip walls at the Normale chamber's 8% blockage
    raise the sphere's drag by about a fifth (measured on the GPU, 2026-10-20:
    at Re 20, 3.39 with 8%, 2.91 with 2.2%); the length upstream matters 2-3%."""
    return cd * (1.0 - blockage) ** 2


def sphere_run(re: float) -> tuple[float, float, float]:
    d = 0.001
    setup = CaseSetup3D(
        model_id="sfera", name="sfera", pivot=(0.0, 0.0, 0.5), model_size=(d, d, d),
        body_box=(-d / 2, -d / 2, -d / 2, d / 2, d / 2, d / 2), frontal_area_m2=math.pi * d * d / 4,
        speed=re * properties("aria", 20).kinematic_viscosity / d, resolution="normale",
    )  # fmt: skip
    plan = plan3d(setup)
    assert plan.re_sim == pytest.approx(re, rel=1e-6)
    z, y, x = (np.mgrid[0 : plan.nz, 0 : plan.ny, 0 : plan.nx] + 0.5) * plan.dx
    ox, oy, oz = plan.offset
    mask = (((x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2) < (d / 2) ** 2).astype(np.uint8)
    del x, y, z
    # The coefficients on the frontal area the flow sees: the voxels' (SPEC §24.3).
    area = float((mask.max(axis=2) > 0).sum())
    ref = Reference3D(LatticeCase3D.from_plan(plan, mask))
    ref.run(plan.ramp_steps + int(6 * plan.tc_steps))
    history = []
    for _ in range(8):
        ref.run(int(plan.tc_steps / 4))
        history.append(ref.coefficients(area)[0])
    assert not ref.unstable()
    cd = float(np.mean(history))
    assert np.ptp(history) < 0.005 * cd  # steady
    return cd, area / (plan.ny * plan.nz), plan.l_lat


@pytest.mark.slow
@pytest.mark.parametrize("re", [20, 100])
def test_38_sphere(re):
    cd, blockage, diameter = sphere_run(re)
    corrected = blockage_corrected(cd, blockage)
    print(f"test 38: Re {re}, D {diameter:.1f} celle, bloccaggio {blockage:.3f}: Cd {cd:.4f}, "
          f"corretto {corrected:.4f} (riferimento {SPHERE_CD[re]})")  # fmt: skip
    assert corrected == pytest.approx(SPHERE_CD[re], rel=0.15)
