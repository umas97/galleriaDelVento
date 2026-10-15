# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Where a model sits in the tunnel frame: scale, base orientation, floor (SPEC §6.2, §6.4).

Tunnel frame: x downstream (wind), y lateral (depth), z up; metres.

    v_tunnel = scale * R @ v_file + t

``R`` is a signed permutation matrix (a composition of 90-degree turns, so it is
exact in integers). ``t`` centres the bounding box in x and y; in z it centres
the model, or with "Appoggia al pavimento" puts its lowest point at the chosen
ground clearance.
"""

from __future__ import annotations

import numpy as np
from pydantic import BaseModel, Field, field_validator

__all__ = ["Floor", "IDENTITY", "Placement", "apply", "rotated_extents"]

IDENTITY: list[list[int]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]


class Floor(BaseModel):
    enabled: bool = False
    clearance_m: float = Field(default=0.0, ge=0.0, le=100.0)


class Placement(BaseModel):
    scale: float = Field(gt=0.0)  # metres per file unit
    rotation: list[list[int]] = IDENTITY
    floor: Floor = Floor()

    @field_validator("rotation")
    @classmethod
    def _proper_rotation(cls, value: list[list[int]]) -> list[list[int]]:
        r = np.asarray(value)
        if r.shape != (3, 3) or not np.isin(r, (-1, 0, 1)).all():
            raise ValueError("la rotazione deve essere una matrice 3x3 di 0 e ±1")
        if not (np.abs(r).sum(axis=0) == 1).all() or not (np.abs(r).sum(axis=1) == 1).all():
            raise ValueError("la rotazione deve essere una composizione di quarti di giro")
        if round(float(np.linalg.det(r))) != 1:
            raise ValueError("la rotazione non può essere uno specchio")
        return value


def rotated_extents(
    extents_file: tuple[float, float, float], rotation: list[list[int]]
) -> np.ndarray:
    """Bounding-box extents along the tunnel axes, still in file units."""
    return np.abs(np.asarray(rotation, dtype=np.float64)) @ np.asarray(extents_file)


def apply(vertices: np.ndarray, placement: Placement) -> np.ndarray:
    """File-unit vertices -> tunnel-frame metres (float64)."""
    r = np.asarray(placement.rotation, dtype=np.float64)
    out = (vertices @ r.T) * placement.scale
    lo, hi = out.min(axis=0), out.max(axis=0)
    shift = -(lo + hi) / 2
    if placement.floor.enabled:
        shift[2] = placement.floor.clearance_m - lo[2]
    out += shift
    return out
