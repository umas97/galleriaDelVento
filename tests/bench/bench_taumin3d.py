# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The smallest stable τ of the 3D solver (SPEC §9.4, §24.3), on the real GPU.

Bodies planned by the 3D planner at a resolution (default Normale) -- a sphere
and a cube in free air, a box-shaped car over the moving floor, a building on
the fixed floor with the boundary-layer inlet -- run at each τ for a number of
steps (default 15 000) with the measurement every 200 steps, stopping at the
first NaN or density outside [0.7, 1.3] (SPEC §9.5).

    uv run python tests/bench/bench_taumin3d.py [--steps N] [--resolution r] [tau ...]
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "tests")]

from gdv.physics.planner3d import CaseSetup3D, plan3d  # noqa: E402
from test_shader_reference import runs  # noqa: E402


def body(shape: str, size: tuple[float, float, float], **extra) -> CaseSetup3D:
    lx, ly, lz = size
    area = math.pi * ly * lz / 4 if shape == "sphere" else ly * lz
    return CaseSetup3D(
        model_id=shape,
        name=shape,
        pivot=extra.pop("pivot", (0.0, 0.0, lz / 2)),
        model_size=size,
        body_box=(-lx / 2, -ly / 2, -lz / 2, lx / 2, ly / 2, lz / 2),
        frontal_area_m2=area,
        **extra,
    )


CASES = {
    "sfera": ("sphere", body("sphere", (1.0, 1.0, 1.0), speed=30.0)),
    "cubo": ("box", body("box", (1.0, 1.0, 1.0), speed=30.0)),
    "auto su nastro": (
        "box",
        body(
            "box",
            (4.5, 1.8, 1.4),
            speed=30.0,
            ground="moving",
            max_blockage=0.1,
            pivot=(0.0, 0.0, 0.85),
            reference_length={"kind": "length_x"},
        ),
    ),  # fmt: skip
    # The car with its underside on the belt, or one cell above it, instead of
    # the planner's gap (3 cells, measured in 2D).
    "auto a contatto del nastro": (
        "box",
        body(
            "box",
            (4.5, 1.8, 1.4),
            speed=30.0,
            ground="moving",
            max_blockage=0.1,
            pivot=(0.0, 0.0, 0.7),
            reference_length={"kind": "length_x"},
        ),
        0,
    ),  # fmt: skip
    "auto a una cella dal nastro": (
        "box",
        body(
            "box",
            (4.5, 1.8, 1.4),
            speed=30.0,
            ground="moving",
            max_blockage=0.1,
            pivot=(0.0, 0.0, 0.7),
            reference_length={"kind": "length_x"},
        ),
        1,
    ),  # fmt: skip
    "auto a due celle dal nastro": (
        "box",
        body(
            "box",
            (4.5, 1.8, 1.4),
            speed=30.0,
            ground="moving",
            max_blockage=0.1,
            pivot=(0.0, 0.0, 0.7),
            reference_length={"kind": "length_x"},
        ),
        2,
    ),  # fmt: skip
    "edificio, strato limite": (
        "box",
        body(
            "box",
            (20.0, 20.0, 30.0),
            speed=10.0,
            ground="fixed",
            inlet_profile="boundary_layer",
            pivot=(0.0, 0.0, 15.0),
            reference_length={"kind": "height"},
        ),
    ),  # fmt: skip
}


def voxels(shape: str, setup: CaseSetup3D, plan, gap_cells: int | None = None) -> np.ndarray:
    z, y, x = (np.mgrid[0 : plan.nz, 0 : plan.ny, 0 : plan.nx] + 0.5) * plan.dx
    ox, oy, oz = plan.offset
    if gap_cells is not None:  # the underside that many cells above the floor
        oz = -setup.body_box[2] + gap_cells * plan.dx
    x0, y0, z0, x1, y1, z1 = setup.body_box
    if shape == "sphere":
        r = (x1 - x0) / 2
        return (((x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2) < r * r).astype(np.uint8)
    inside = (x > ox + x0) & (x < ox + x1) & (y > oy + y0) & (y < oy + y1)
    return (inside & (z > oz + z0) & (z < oz + z1)).astype(np.uint8)


def lattice(plan, tau: float) -> dict:
    return {
        "nx": plan.nx,
        "ny": plan.ny,
        "nz": plan.nz,
        "tau": tau,
        "uLat": plan.u_lat,
        "rampSteps": plan.ramp_steps,
        "ground": plan.ground,
        "boundaryLayer": plan.inlet_profile == "boundary_layer",
        "inletExponent": plan.inlet_exponent,
        "inletReferenceCells": plan.inlet_reference_cells,
        "spongeStart": plan.sponge_start,
        "spongeFactor": plan.sponge_factor,
        "spongeDamping": plan.sponge_damping,
        "cs": plan.smagorinsky_cs,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("taus", nargs="*", type=float, default=[0.5005, 0.501, 0.502, 0.504])
    parser.add_argument("--steps", type=int, default=15_000)
    parser.add_argument("--resolution", default="normale")
    parser.add_argument("--only", default=None, help="cases by name, separated by semicolons")
    args = parser.parse_args()
    items = []
    for name, (shape, setup, *gap) in CASES.items():
        if args.only and name not in args.only.split(";"):
            continue
        setup = setup.model_copy(update={"resolution": args.resolution})
        plan = plan3d(setup)
        mask = runs(voxels(shape, setup, plan, *gap))
        grid = f"{plan.nx}×{plan.ny}×{plan.nz}"
        print(f"{name}: {grid}, τ del piano {plan.tau:.4f}, u_lat {plan.u_lat:.4f}")
        for tau in args.taus:
            items.append((name, tau, {
                "params": lattice(plan, tau), "mask": mask, "steps": args.steps,
                "measureEvery": 200, "fields": False, "stopWhenUnstable": True,
            }))  # fmt: skip
    with tempfile.TemporaryDirectory() as tmp:
        source, result = Path(tmp) / "in.json", Path(tmp) / "out.json"
        source.write_text(json.dumps({"mode": "test", "cases": [c for _, _, c in items]}))
        subprocess.run(
            ["node", "tests/e2e/selftest3d.mjs", str(source), str(result), "--gpu"],
            cwd=ROOT / "frontend",
            check=True,
        )
        out = json.loads(result.read_text())
    for (name, tau, _), got in zip(items, out, strict=True):
        samples = got["samples"]
        bad = [s for s in samples if s["nan"] > 0 or not 0.7 <= s["rhoMin"] <= s["rhoMax"] <= 1.3]
        last = samples[-1]
        verdict = f"INSTABILE al passo {bad[0]['step']}" if bad else "stabile"
        print(
            f"{name:26s} τ {tau:.4f}: {verdict:24s} passi {got['steps']:6d}, "
            f"ρ {last['rhoMin']:.3f}–{last['rhoMax']:.3f}, {got['ms'] / 1000:.0f} s"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
