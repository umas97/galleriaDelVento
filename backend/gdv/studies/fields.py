# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The time-averaged fields of a result (SPEC §11.1): from the GPU's sums to files.

The interface accumulates, on the GPU, one sample every 8 steps of
(δρ, u_x, u_y) in lattice units, with the count in the fourth channel, and
sends the sums as they are -- float32 RGBA, row by row from the bottom of the
chamber -- followed by the body's mask (one byte per cell). Here they become
the mean fields, normalised so that float16 holds them:

* ``u``, ``v``   velocity on the speed V (real value: · V, m/s);
* ``cp``         (p − p∞) / (½ ρ V²), with p − p∞ = (ρ − ρ∞)/3 in lattice units;
* ``vorticity``  ∂v/∂x − ∂u/∂y on V / L_ref (real value: · V / L_ref, 1/s).

Solid cells hold zeros (the mask says where they are). The vorticity uses
central differences, one-sided at the edges of the chamber, with the solid
cells at rest.

A 3D result (SPEC §24.2 #7) sends, per cell and x fastest, the sums of (δρ,
u_x, u_y, u_z) -- float32 -- then the voxels (one byte per cell); the number of
samples comes with the point (the same for every cell: the body does not
change during a 3D case). They become ``u``, ``v``, ``w`` on V and ``cp``,
shape (nz, ny, nx); no vorticity (ParaView derives it from the velocity).
"""

from __future__ import annotations

import numpy as np

from ..errors import AppError
from ..physics.planner import CasePlan
from ..physics.planner3d import CasePlan3D

__all__ = [
    "FIELD_LIMIT",
    "FieldSet",
    "decode",
    "decode3d",
    "normalise",
    "normalise3d",
    "raw_size",
    "raw_size3d",
    "scales",
    "scales3d",
]

#: float16 stops at 65 504: normalised values are clipped well inside it.
FIELD_LIMIT = 60_000.0

FieldSet = dict[str, np.ndarray]


def raw_size(nx: int, ny: int) -> int:
    return nx * ny * 17


def decode(blob: bytes, nx: int, ny: int) -> tuple[np.ndarray, np.ndarray]:
    """The sums (ny, nx, 4) float32 and the mask (ny, nx) uint8 of an upload."""
    if len(blob) != raw_size(nx, ny):
        raise AppError(
            "I campi medi non corrispondono alla griglia del caso",
            f"{len(blob)} byte invece di {raw_size(nx, ny)} per {nx}×{ny}",
        )
    sums = np.frombuffer(blob, dtype="<f4", count=nx * ny * 4).reshape(ny, nx, 4)
    mask = np.frombuffer(blob, dtype=np.uint8, offset=nx * ny * 16).reshape(ny, nx)
    if not np.isfinite(sums).all():
        raise AppError("I campi medi contengono valori non numerici", "NaN o infinito nelle somme")
    return sums, mask


def raw_size3d(nx: int, ny: int, nz: int) -> int:
    return nx * ny * nz * 17


def decode3d(blob: bytes, nx: int, ny: int, nz: int) -> tuple[np.ndarray, np.ndarray]:
    """The sums (nz, ny, nx, 4) float32 and the voxels (nz, ny, nx) uint8 of a 3D upload."""
    n = nx * ny * nz
    if len(blob) != raw_size3d(nx, ny, nz):
        raise AppError(
            "I campi medi non corrispondono alla griglia del caso",
            f"{len(blob)} byte invece di {raw_size3d(nx, ny, nz)} per {nx}×{ny}×{nz}",
        )
    sums = np.frombuffer(blob, dtype="<f4", count=n * 4).reshape(nz, ny, nx, 4)
    mask = np.frombuffer(blob, dtype=np.uint8, offset=n * 16).reshape(nz, ny, nx)
    if not np.isfinite(sums).all():
        raise AppError("I campi medi contengono valori non numerici", "NaN o infinito nelle somme")
    return sums, mask


def normalise3d(
    sums: np.ndarray, mask: np.ndarray, samples: int, rho_inf: float, plan: CasePlan3D
) -> FieldSet:
    """Mean 3D fields, normalised, float16; plus ``solid`` (uint8)."""
    fluid = mask == 0
    mean = sums / np.float32(max(samples, 1))
    u_lat = plan.u_lat
    q = 0.5 * rho_inf * u_lat * u_lat
    rho = 1.0 + mean[..., 0]

    def half(a: np.ndarray) -> np.ndarray:
        return np.clip(np.where(fluid, a, 0.0), -FIELD_LIMIT, FIELD_LIMIT).astype(np.float16)

    return {
        "u": half(mean[..., 1] / u_lat),
        "v": half(mean[..., 2] / u_lat),
        "w": half(mean[..., 3] / u_lat),
        "cp": half((rho - rho_inf) / 3.0 / q),
        "solid": (mask != 0).astype(np.uint8),
    }


def scales3d(plan: CasePlan3D) -> dict[str, tuple[str, float]]:
    speed = ("m/s", plan.speed)
    return {"u": speed, "v": speed, "w": speed, "cp": ("", 1.0)}


def normalise(sums: np.ndarray, mask: np.ndarray, rho_inf: float, plan: CasePlan) -> FieldSet:
    """Mean fields, normalised, float16; plus ``solid`` (uint8)."""
    count = sums[..., 3]
    fluid = (mask == 0) & (count > 0)
    safe = np.where(count > 0, count, 1.0)
    drho = np.where(fluid, sums[..., 0] / safe, 0.0)
    ux = np.where(fluid, sums[..., 1] / safe, 0.0)
    uy = np.where(fluid, sums[..., 2] / safe, 0.0)
    u_lat = plan.u_lat
    q = 0.5 * rho_inf * u_lat * u_lat
    cp = np.where(fluid, (1.0 + drho - rho_inf) / 3.0 / q, 0.0)
    # Lattice vorticity (per step); on V / L_ref it is ω · L_lat / U_lat.
    dvdx = np.gradient(uy, axis=1)
    dudy = np.gradient(ux, axis=0)
    vorticity = np.where(fluid, (dvdx - dudy) * plan.l_lat / u_lat, 0.0)

    def half(a: np.ndarray) -> np.ndarray:
        return np.clip(a, -FIELD_LIMIT, FIELD_LIMIT).astype(np.float16)

    return {
        "u": half(ux / u_lat),
        "v": half(uy / u_lat),
        "cp": half(cp),
        "vorticity": half(vorticity),
        "solid": (mask != 0).astype(np.uint8),
    }


def scales(plan: CasePlan) -> dict[str, tuple[str, float]]:
    """Unit and factor of the real value of each field."""
    return {
        "u": ("m/s", plan.speed),
        "v": ("m/s", plan.speed),
        "cp": ("", 1.0),
        "vorticity": ("1/s", plan.speed / plan.reference_length),
    }
