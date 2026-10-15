# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The D2Q9 lattice and its MRT collision: the one place these numbers live (SPEC §10.2).

``scripts/gen_lattice_ts.py`` writes ``frontend/src/sim2d/lattice.generated.ts``
from this module, the shader is built from that file, and the reference solver
of the tests (``tests/reference/lbm2d.py``) imports this one. Test 20 fails if
the generated file is stale.

Directions (Lallemand & Luo 2000 numbering), y up::

    6 2 5
    3 0 1
    7 4 8

Moments, rows of :data:`M`: density, energy e, energy squared ε, momentum jx,
energy flux qx, momentum jy, energy flux qy, and the two stress components
pxx = Πxx − Πyy and pxy = Πxy. The rows are orthogonal, so
``M⁻¹ = Mᵀ · diag(1 / |row|²)``.

Populations are stored as deviations from the rest weights (``f − w``, SPEC
§10.1): ``M · w`` is the equilibrium of a fluid at rest with unit density, so
the collision is the same affine map on deviations, with ``δρ = ρ − 1``.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "C",
    "CS_SMAGORINSKY",
    "M",
    "MINV",
    "MIRROR_Y",
    "OPPOSITE",
    "Q",
    "S_E",
    "S_EPS",
    "S_Q",
    "W",
]

Q = 9

#: Lattice velocities, one row per direction.
C = np.array(
    [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]],
    dtype=np.int64,
)

#: Rest weights.
W = np.array([4 / 9] + [1 / 9] * 4 + [1 / 36] * 4)

#: The direction pointing the other way (bounce-back).
OPPOSITE = np.array([0, 3, 4, 1, 2, 7, 8, 5, 6], dtype=np.int64)

#: The direction mirrored across a horizontal wall (free slip: cy changes sign).
MIRROR_Y = np.array([0, 1, 4, 3, 2, 8, 7, 6, 5], dtype=np.int64)

#: Moment matrix: m = M f.
M = np.array(
    [
        [1, 1, 1, 1, 1, 1, 1, 1, 1],  # rho
        [-4, -1, -1, -1, -1, 2, 2, 2, 2],  # e
        [4, -2, -2, -2, -2, 1, 1, 1, 1],  # epsilon
        [0, 1, 0, -1, 0, 1, -1, -1, 1],  # jx
        [0, -2, 0, 2, 0, 1, -1, -1, 1],  # qx
        [0, 0, 1, 0, -1, 1, 1, -1, -1],  # jy
        [0, 0, -2, 0, 2, 1, 1, -1, -1],  # qy
        [0, 1, -1, 1, -1, 0, 0, 0, 0],  # pxx
        [0, 0, 0, 0, 0, 1, -1, 1, -1],  # pxy
    ],
    dtype=np.float64,
)

MINV = M.T / (M * M).sum(axis=1)

# Relaxation rates of the moments that are not hydrodynamic (SPEC §10.1). The
# stress moments relax with s_nu = 1/tau, set per cell by the planner's tau and
# the subgrid model; density and momentum are conserved. Starting values from
# Lallemand & Luo (2000), tuned there for linear stability; confirmed or changed
# by measuring tests 21-25 (decision of 2026-10-15).
S_E = 1.64
S_EPS = 1.54
S_Q = 1.9

#: Smagorinsky constant of the subgrid model (SPEC §10.1).
CS_SMAGORINSKY = 0.1


def _check() -> None:
    assert np.allclose(MINV @ M, np.eye(Q))
    assert np.allclose(M @ W, [1, -2, 1, 0, 0, 0, 0, 0, 0])
    assert (C[OPPOSITE] == -C).all()
    assert (C[MIRROR_Y] == C * [1, -1]).all()


_check()
