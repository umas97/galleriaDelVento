# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic finished cases, as the interface would send them (SPEC §11).

A NACA 0012 is planned by the real planner; the coefficients, history,
contour and field sums are made up but consistent: the field sums describe a
known flow (u = U·(1 + 0.1·x/W), v = 0.05·U·y/H, δρ = 0.003·x/W, 50 samples a
cell), so the tests can check every conversion against it.
"""

from __future__ import annotations

import json
import struct
import zlib
from typing import Any

import numpy as np

from gdv.geometry.profile import ProfileDraft
from gdv.physics.planner import CaseSetup, Domain, plan
from synthetic import naca4

SAMPLES = 50


def png(width: int = 4, height: int = 3) -> bytes:
    """A small valid PNG (grey)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\x00" + b"\x80" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def parts(**named: bytes | dict | list) -> bytes:
    """The study upload container of routes_studies."""
    out = [b"GDV1"]
    for name, value in named.items():
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        key = name.encode()
        out += [struct.pack("<I", len(key)), key, struct.pack("<Q", len(data)), data]
    return b"".join(out)


def naca_draft(name: str = "NACA 0012", chord: float = 1.0, source: dict | None = None) -> dict:
    return {
        "name": name,
        "loops": [{"points": naca4("0012", 80, chord).tolist()}],
        "source": source or {"kind": "editor", "derived_from": None, "origin": None},
        "spline": None,
    }


def setup(
    *,
    angle: float = 0.0,
    speed: float = 15.0,
    resolution: str = "bozza",
    draft: dict | None = None,
) -> CaseSetup:
    return CaseSetup(
        profile=ProfileDraft.model_validate(draft or naca_draft()),
        speed=speed,
        angle_deg=angle,
        resolution=resolution,  # type: ignore[arg-type]
    )


def field_sums(nx: int, ny: int, u_lat: float) -> tuple[np.ndarray, np.ndarray]:
    """Sums (ny, nx, 4) of a known flow, and a mask with a solid block."""
    x = (np.arange(nx) + 0.5) / nx
    y = (np.arange(ny) + 0.5) / ny
    xx, yy = np.meshgrid(x, y)
    mean = np.stack([0.003 * xx, u_lat * (1 + 0.1 * xx), 0.05 * u_lat * yy, np.ones_like(xx)], -1)
    mask = np.zeros((ny, nx), dtype=np.uint8)
    mask[ny // 2 - 2 : ny // 2 + 2, nx // 4 : nx // 4 + 8] = 1
    return (mean * SAMPLES).astype(np.float32), mask


def point(
    *,
    angle: float = 0.0,
    speed: float = 15.0,
    status: str = "converged",
    value: float | None = None,
    draft: dict | None = None,
    resolution: str = "bozza",
    cd: float = 0.05,
    cl: float | None = None,
) -> dict[str, Any]:
    """A point upload (the parts ``point``, ``fields`` and two views)."""
    case = setup(angle=angle, speed=speed, resolution=resolution, draft=draft)
    p = plan(case)
    case = case.model_copy(
        update={"position": p.position, "domain": Domain(width_m=p.width_m, height_m=p.height_m)}
    )
    cl = 0.1 * angle if cl is None else cl
    steps = list(range(8, 8 * 401, 8))
    rng = np.random.default_rng(abs(int(angle * 10 + speed * 7)))
    stat = lambda m: {"mean": m, "std": 0.001}  # noqa: E731
    numbers = status != "transient"
    upload = {
        "value": value,
        "case": case.model_dump(mode="json"),
        "plan": p.model_dump(mode="json"),
        "status": status,
        "coefficients": {
            "cd": stat(cd) if numbers else None,
            "cl": stat(cl) if numbers else None,
            "cm": stat(-0.01) if numbers else None,
            "clcd": cl / cd if numbers else None,
            "strouhal": None,
            "regime": "steady",
            "change": 0.001,
            "averaged_steps": 2000,
            "rho_inf": 1.0004,
        },
        "history": {
            "every": 8,
            "step": steps,
            "cd": (cd + 0.001 * rng.standard_normal(len(steps))).tolist(),
            "cl": (cl + 0.001 * rng.standard_normal(len(steps))).tolist(),
            "cm": [-0.01] * len(steps),
        },
        "contour": {
            "chord": True,
            "xc": [0.0, 0.25, 0.5, 1.0, 0.5, 0.25],
            "s": [0.5, 0.35, 0.25, 0.0, 0.75, 0.65],
            "upper": [True, True, True, True, False, False],
            "cp": [1.0, -0.6, -0.3, 0.1, -0.2, -0.4],
            "x": [100.0, 105.0, 110.0, 120.0, 110.0, 105.0],
            "y": [64.0, 66.0, 66.0, 64.0, 62.0, 62.0],
        },
        "mean": {"samples": SAMPLES, "rho_inf": 1.0} if status != "unstable" else None,
        "steps": 3200,
        "elapsed_s": 4.5,
    }
    sums, mask = field_sums(p.nx, p.ny, p.u_lat)
    return {
        "point": upload,
        "fields": sums.astype("<f4").tobytes() + mask.tobytes(),
        "velocita": png(),
        "cp": png(),
    }


def meta(name: str = "Studio di prova", series: dict | None = None, **extra: Any) -> dict:
    return {"name": name, "notes": "", "profile_name": "NACA 0012", "series": series, **extra}


# --- a 3D case (SPEC §24.2 #7) ------------------------------------------------------------


def setup3d(*, speed: float = 20.0, yaw: float = 0.0, d: float = 0.2):
    """A sphere of diameter d on its own in the 3D tunnel, Bozza."""
    from gdv.physics.planner3d import CaseSetup3D

    return CaseSetup3D(
        model_id="sfera3d", name="Sfera", pivot=(0.0, 0.0, 0.5), model_size=(d, d, d),
        body_box=(-d / 2, -d / 2, -d / 2, d / 2, d / 2, d / 2),
        frontal_area_m2=float(np.pi * d * d / 4), speed=speed, yaw_deg=yaw, resolution="bozza",
    )  # fmt: skip


def field_sums3d(nx: int, ny: int, nz: int, u_lat: float) -> tuple[np.ndarray, np.ndarray]:
    """Sums (nz, ny, nx, 4) of a known flow -- δρ = 0.003 x/L, u = U (1 + 0.1 x/L),
    v = 0, w = 0.05 U z/H -- and a solid block."""
    x = (np.arange(nx) + 0.5) / nx
    z = (np.arange(nz) + 0.5) / nz
    zz, _, xx = np.meshgrid(z, np.zeros(ny), x, indexing="ij")
    mean = np.stack([0.003 * xx, u_lat * (1 + 0.1 * xx), np.zeros_like(xx), 0.05 * u_lat * zz], -1)
    mask = np.zeros((nz, ny, nx), dtype=np.uint8)
    mask[nz // 2 - 2 : nz // 2 + 2, ny // 2 - 2 : ny // 2 + 2, nx // 4 : nx // 4 + 4] = 1
    return (mean * SAMPLES).astype(np.float32), mask


def point3d(
    *, speed: float = 20.0, yaw: float = 0.0, status: str = "converged", cd: float = 0.5
) -> dict[str, Any]:
    """A 3D point upload: the parts ``point``, ``fields`` and the three pictures."""
    from gdv.physics.planner3d import plan3d

    case = setup3d(speed=speed, yaw=yaw)
    p = plan3d(case)
    factor = p.blockage_correction
    steps = list(range(8, 8 * 201, 8))
    stat = lambda m: {"mean": m, "std": 0.002}  # noqa: E731
    numbers = status != "unstable"
    upload = {
        "dimension": "3d",
        "value": None,
        "case": case.model_dump(mode="json"),
        "plan": p.model_dump(mode="json"),
        "status": status,
        "coefficients": {
            "cd": stat(cd) if numbers else None,
            "cl": stat(0.01) if numbers else None,
            "cs": stat(-0.02) if numbers else None,
            "cd_measured": stat(cd / factor) if numbers else None,
            "blockage_correction": factor,
            "regime": "steady",
            "change": 0.002,
            "averaged_steps": 1600,
            "rho_inf": 1.0003,
        },
        "history": {
            "every": 8,
            "step": steps,
            "cd": [cd] * len(steps),
            "cl": [0.01] * len(steps),
            "cs": [-0.02] * len(steps),
        },
        "mean": {"samples": SAMPLES, "rho_inf": 1.0} if numbers else None,
        "steps": 1600,
        "elapsed_s": 12.0,
    }
    sums, mask = field_sums3d(p.nx, p.ny, p.nz, p.u_lat)
    return {
        "point": upload,
        "fields": sums.astype("<f4").tobytes() + mask.tobytes(),
        "vista": png(),
        "piano": png(),
        "superficie": png(),
    }


def meta3d(name: str = "Sfera 3D") -> dict:
    return {
        "name": name, "notes": "", "profile_id": None, "profile_name": "Sfera",
        "model_id": "sfera3d", "model_name": "Sfera", "series": None,
    }  # fmt: skip
