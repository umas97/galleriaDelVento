# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 25: the shader against the reference solver (SPEC §10.8, §18).

500 steps on 256 × 96 in the system Chrome (``sim2d/selftest.ts``) and in
``tests/reference/lbm2d.py``, same case, same mask: the largest velocity gap,
relative to the largest velocity, stays below 10⁻³. Repeated with a moving
floor, and with the body moved half-way through (the live mask, SPEC §10.3).
Skipped -- saying why -- only when Chrome or the built interface is missing.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from gdv.geometry.raster2d import rasterize
from reference.lbm2d import LatticeCase, Reference
from synthetic import naca4

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

pytestmark = [pytest.mark.gpu, pytest.mark.browser]

NX, NY = 256, 96


def missing() -> str | None:
    if not any(shutil.which(b) for b in ("google-chrome", "google-chrome-stable")):
        return "Google Chrome non trovato"
    if shutil.which("node") is None:
        return "Node non trovato"
    if not (FRONTEND / "node_modules" / "playwright-core").is_dir():
        return "playwright-core non installato (cd frontend && npm install)"
    if not (ROOT / "backend" / "gdv" / "static" / "index.html").is_file():
        return "interfaccia non costruita (cd frontend && npm run build)"
    return None


def cylinder(cx: float, cy: float, d: float) -> np.ndarray:
    t = np.linspace(0, 2 * np.pi, 400, endpoint=False)
    ring = [(cx + d / 2 * math.cos(a), cy + d / 2 * math.sin(a)) for a in t]
    return rasterize([ring], NX, NY, 1.0)


def airfoil(x: float, y: float, angle: float) -> np.ndarray:
    a = math.radians(-angle)
    c, s = math.cos(a), math.sin(a)
    ring = [(x + px * c - py * s, y + px * s + py * c) for px, py in naca4("0012", 120, 60.0)]
    return rasterize([ring], NX, NY, 1.0)


def runs(mask: np.ndarray) -> list[int]:
    out: list[int] = []
    for k in np.flatnonzero(mask.ravel()):
        if out and out[-2] + out[-1] == k:
            out[-1] += 1
        else:
            out += [int(k), 1]
    return out


def params(ground: str) -> dict:
    return {
        "nx": NX,
        "ny": NY,
        "tau": 0.53,
        "uLat": 0.08,
        "rampSteps": 200,
        "ground": ground,
        "boundaryLayer": False,
        "inletExponent": 0.16,
        "inletReferenceCells": 50.0,
        "spongeStart": int(round(NX * 0.92)),
        "spongeFactor": 10.0,
        "spongeDamping": 0.05,
        "cs": 0.1,
    }


CASES = {
    "cylinder": {"ground": "none", "mask": cylinder(60, 48.3, 20)},
    "moving_floor": {"ground": "moving", "mask": airfoil(50, 14, 4.0)},
    "mask_change": {
        "ground": "none",
        "mask": airfoil(50, 45, -3.0),
        "change": (250, airfoil(53, 47, 6.0)),
    },
}
STEPS = 500


def reference(spec) -> Reference:
    p = params(spec["ground"])
    ref = Reference(
        LatticeCase(
            nx=NX, ny=NY, tau=p["tau"], u_lat=p["uLat"], mask=spec["mask"],
            ramp_steps=p["rampSteps"], ground=spec["ground"], sponge_start=p["spongeStart"],
            sponge_factor=p["spongeFactor"], sponge_damping=p["spongeDamping"], cs=p["cs"],
        )
    )  # fmt: skip
    if "change" in spec:
        at, mask = spec["change"]
        ref.run(at)
        ref.set_mask(mask)
        ref.run(STEPS - at)
    else:
        ref.run(STEPS)
    return ref


@pytest.fixture(scope="module")
def shader(tmp_path_factory):
    reason = missing()
    if reason:
        pytest.skip(reason)
    folder = tmp_path_factory.mktemp("shader")
    payload = []
    for spec in CASES.values():
        case = {"params": params(spec["ground"]), "mask": runs(spec["mask"]), "steps": STEPS}
        if "change" in spec:
            case["change"] = {"at": spec["change"][0], "mask": runs(spec["change"][1])}
        payload.append(case)
    source, result = folder / "in.json", folder / "out.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    done = subprocess.run(
        ["node", "tests/e2e/selftest.mjs", str(source), str(result)],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-4000:]
    return dict(zip(CASES, json.loads(result.read_text(encoding="utf-8")), strict=True))


@pytest.mark.parametrize("name", list(CASES))
def test_25_shader_matches_reference(name, shader):
    ref = reference(CASES[name])
    got = shader[name]
    ux = np.asarray(got["ux"], dtype=np.float64).reshape(NY, NX)
    uy = np.asarray(got["uy"], dtype=np.float64).reshape(NY, NX)
    scale = float(np.max(np.hypot(ref.ux, ref.uy)))
    gap = float(np.max(np.hypot(ux - ref.ux, uy - ref.uy)))
    assert np.isfinite(ux).all() and np.isfinite(uy).all()
    assert gap / scale < 1e-3, (gap / scale, got["renderer"])
