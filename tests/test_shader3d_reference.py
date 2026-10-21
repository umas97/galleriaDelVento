# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 39: the WGSL solver against the 3D reference solver (SPEC §24.4).

500 steps on 32³ in the system Chrome (``sim3d/selftest.ts``, WebGPU on
SwiftShader) and in ``tests/reference/lbm3d.py``, same case, same voxels: the
largest velocity gap, relative to the largest velocity, stays below 10⁻³, and
the forces of the last measurement agree. Repeated over a moving floor, over
a fixed floor with the boundary-layer inlet, and with interpolated walls
(SPEC §24.8): a sphere at its true radius and a plate thinner than a cell.
Skipped -- saying why -- only when Chrome or the built interface is missing.
"""

from __future__ import annotations

import json
import subprocess

import numpy as np
import pytest

from gdv import lattice3d
from reference.lbm3d import LatticeCase3D, Q, Reference3D, inlet_shape, quantize, sphere_walls
from test_shader_reference import FRONTEND, missing, runs

pytestmark = [pytest.mark.gpu, pytest.mark.browser]

N = 32
STEPS = 500


def sphere(cx: float, cy: float, cz: float, r: float) -> np.ndarray:
    z, y, x = np.mgrid[0:N, 0:N, 0:N] + 0.5
    return (((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) < r * r).astype(np.uint8)


def block(x0, x1, y0, y1, z0, z1) -> np.ndarray:
    mask = np.zeros((N, N, N), np.uint8)
    mask[z0:z1, y0:y1, x0:x1] = 1
    return mask


def plate_walls(x0: float, y0: float, y1: float, z0: float, z1: float) -> np.ndarray:
    """A plate of no thickness at x = x0 (between cell centres), y0 < y < y1, z0 < z < z1:
    no solid cell, only the links that cross it."""
    walls = np.zeros((Q, N, N, N), np.uint8)
    z, y, x = np.mgrid[0:N, 0:N, 0:N] + 0.5
    for k in range(1, Q):
        cx, cy, cz = (float(v) for v in lattice3d.C[k])
        if cx == 0:
            continue
        s = (x - x0) / cx  # the link x → x − c_k meets the plane at x − s c_k
        py, pz = y - s * cy, z - s * cz
        hit = (s >= 0) & (s <= 1) & (py > y0) & (py < y1) & (pz > z0) & (pz < z1)
        walls[k][hit] = quantize(s[hit])
    return walls


def triples(walls: np.ndarray) -> list[int]:
    k, z, y, x = np.nonzero(walls)
    cells = x + N * (y + N * z)
    return np.stack([cells, k, walls[k, z, y, x]], axis=1).astype(int).ravel().tolist()


def params(ground: str, boundary_layer: bool = False) -> dict:
    return {
        "nx": N,
        "ny": N,
        "nz": N,
        "tau": 0.53,
        "uLat": 0.08,
        "rampSteps": 200,
        "ground": ground,
        "boundaryLayer": boundary_layer,
        "inletExponent": 0.16,
        "inletReferenceCells": 20.0,
        "spongeStart": int(round(N * 0.92)),
        "spongeFactor": 10.0,
        "spongeDamping": 0.05,
        "cs": 0.1,
    }


CASES = {
    "sphere": {"ground": "none", "mask": sphere(10, 16.3, 15.8, 5)},
    "sphere_walls": {
        "ground": "none",
        "mask": sphere(10, 16.3, 15.8, 5),
        "walls": sphere_walls(sphere(10, 16.3, 15.8, 5), (10, 16.3, 15.8), 5),
    },
    "thin_plate": {
        "ground": "none",
        "mask": np.zeros((N, N, N), np.uint8),
        "walls": plate_walls(12.3, 10.2, 22.6, 9.7, 21.4),
    },
    "moving_floor": {"ground": "moving", "mask": block(8, 16, 12, 21, 3, 9)},
    "fixed_floor_boundary_layer": {
        "ground": "fixed",
        "boundary_layer": True,
        "mask": block(10, 15, 9, 23, 0, 12),
    },
}


def reference(spec) -> Reference3D:
    p = params(spec["ground"], spec.get("boundary_layer", False))
    shape = None
    if p["boundaryLayer"]:
        shape = inlet_shape(N, p["inletExponent"], p["inletReferenceCells"])
    ref = Reference3D(
        LatticeCase3D(
            nx=N, ny=N, nz=N, tau=p["tau"], u_lat=p["uLat"], mask=spec["mask"],
            ramp_steps=p["rampSteps"], ground=spec["ground"], inlet_shape=shape,
            sponge_start=p["spongeStart"], sponge_factor=p["spongeFactor"],
            sponge_damping=p["spongeDamping"], cs=p["cs"], walls=spec.get("walls"),
        )
    )  # fmt: skip
    ref.run(STEPS)
    return ref


@pytest.fixture(scope="module")
def shader(tmp_path_factory):
    reason = missing()
    if reason:
        pytest.skip(reason)
    folder = tmp_path_factory.mktemp("shader3d")
    cases = [
        {
            "params": params(spec["ground"], spec.get("boundary_layer", False)),
            "mask": runs(spec["mask"]),
            **({"walls": triples(spec["walls"])} if "walls" in spec else {}),
            "steps": STEPS,
            "measureEvery": 100,
        }
        for spec in CASES.values()
    ]
    source, result = folder / "in.json", folder / "out.json"
    source.write_text(json.dumps({"mode": "test", "cases": cases}), encoding="utf-8")
    done = subprocess.run(
        ["node", "tests/e2e/selftest3d.mjs", str(source), str(result)],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-4000:]
    return dict(zip(CASES, json.loads(result.read_text(encoding="utf-8")), strict=True))


@pytest.mark.parametrize("name", list(CASES))
def test_39_shader_matches_reference(name, shader):
    ref = reference(CASES[name])
    got = shader[name]
    want = ref.macro()
    u = np.stack([np.asarray(got[k], np.float64).reshape(N, N, N) for k in ("ux", "uy", "uz")])
    assert np.isfinite(u).all()
    scale = float(np.max(np.linalg.norm(want[1:], axis=0)))
    gap = float(np.max(np.linalg.norm(u - want[1:], axis=0)))
    assert gap / scale < 1e-3, (gap / scale, got["adapter"])
    # The last measurement is of step 500: same forces, and a sane density range.
    last = got["samples"][-1]
    assert last["step"] == STEPS
    fx, fy, fz = ref.forces()
    assert last["fx"] == pytest.approx(fx, rel=1e-3, abs=1e-4)
    assert last["fz"] == pytest.approx(fz, rel=1e-3, abs=1e-4)
    assert last["fy"] == pytest.approx(fy, rel=1e-3, abs=1e-4)
    assert last["nan"] == 0
    assert last["rhoInf"] == pytest.approx(ref.rho_inf(), abs=1e-5)
    assert 0.9 < last["rhoMin"] <= last["rhoMax"] < 1.1
