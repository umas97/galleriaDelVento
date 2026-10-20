# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The D3Q19 lattice and its MRT collision: the one place these numbers live (SPEC §24.3).

The 3D counterpart of :mod:`gdv.lattice`. ``scripts/gen_lattice_ts.py`` also
writes ``frontend/src/sim3d/lattice3d.generated.ts`` from this module, the WGSL
solver is generated from that file, and the reference solver of the tests
(``tests/reference/lbm3d.py``) imports this one. Test 35 fails if the generated
file is stale.

Frame of the tunnel (SPEC §6.4): x downstream, y across (depth), z up.
Directions: the rest one, the six faces, the twelve edges, in opposite pairs
(1, 2), (3, 4), ... so that ``OPPOSITE[k] = k ± 1``.

Moments, rows of :data:`M` (d'Humières, Ginzburg, Krafczyk, Lallemand & Luo,
"Multiple-relaxation-time lattice Boltzmann models in three dimensions",
Phil. Trans. R. Soc. A 360, 2002): density ρ; energy e = Σ(19c² − 30)f; energy
squared ε = Σ(21c⁴ − 53c² + 24)/2 f; momentum j and energy flux
q = Σ(5c² − 9)c f per axis; the stress components 3pxx = Σ(3cx² − c²)f and
pww = Σ(cy² − cz²)f with their fourth-order companions πxx, πww
(× (3c² − 5)); the shear stresses pxy, pyz, pxz; and the third-order moments
m. The rows are orthogonal, so ``M⁻¹ = Mᵀ · diag(1 / |row|²)``.

Equilibria are the moments of the usual second-order equilibrium
``w ρ (1 + 3 c·u + 9/2 (c·u)² − 3/2 u²)`` -- the same choice as the 2D solver
(so that the collision is BGK when every rate is the same) -- written out in
:func:`equilibrium_moments` and checked against ``M · feq``.

Populations are stored as deviations from the rest weights (``f − w``): ``M w``
is the equilibrium of a fluid at rest with unit density, so the collision is
the same affine map on deviations, with ``δρ = ρ − 1``.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "C",
    "CS_SMAGORINSKY",
    "M",
    "MINV",
    "MIRROR",
    "OPPOSITE",
    "Q",
    "REST_MOMENTS",
    "S_E",
    "S_EPS",
    "S_M",
    "S_PI",
    "S_Q",
    "W",
    "equilibrium_moments",
]

Q = 19

#: Lattice velocities, one row per direction.
C = np.array(
    [
        [0, 0, 0],
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
        [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
        [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
    ],
    dtype=np.int64,
)  # fmt: skip

#: Rest weights.
W = np.array([1 / 3] + [1 / 18] * 6 + [1 / 36] * 12)

#: The direction pointing the other way (bounce-back).
OPPOSITE = np.array([0] + [k + 1 if k % 2 else k - 1 for k in range(1, Q)], dtype=np.int64)


def _mirror() -> np.ndarray:
    out = np.zeros((Q, 4), dtype=np.int64)
    for k in range(Q):
        for flags in range(4):
            c = C[k] * [1, -1 if flags & 1 else 1, -1 if flags & 2 else 1]
            out[k, flags] = int(np.flatnonzero((c == C).all(axis=1))[0])
    return out


#: Free slip on the walls: ``MIRROR[k, flags]`` is direction k with cy changed in
#: sign when ``flags & 1`` (a side wall) and cz when ``flags & 2`` (ceiling, floor).
MIRROR = _mirror()


def _moment_rows() -> np.ndarray:
    cx, cy, cz = (C[:, a].astype(np.float64) for a in range(3))
    c2 = cx * cx + cy * cy + cz * cz
    one = np.ones(Q)
    xx = 3 * cx * cx - c2
    ww = cy * cy - cz * cz
    return np.array(
        [
            one,  # rho
            19 * c2 - 30,  # e
            (21 * c2 * c2 - 53 * c2 + 24) / 2,  # epsilon
            cx,  # jx
            (5 * c2 - 9) * cx,  # qx
            cy,  # jy
            (5 * c2 - 9) * cy,  # qy
            cz,  # jz
            (5 * c2 - 9) * cz,  # qz
            xx,  # 3 pxx
            (3 * c2 - 5) * xx,  # 3 pixx
            ww,  # pww
            (3 * c2 - 5) * ww,  # piww
            cx * cy,  # pxy
            cy * cz,  # pyz
            cx * cz,  # pxz
            (cy * cy - cz * cz) * cx,  # mx
            (cz * cz - cx * cx) * cy,  # my
            (cx * cx - cy * cy) * cz,  # mz
        ]
    )


#: Moment matrix: m = M f.
M = _moment_rows()

MINV = M.T / (M * M).sum(axis=1)

#: Moments of the rest state (density 1, at rest): M · W.
REST_MOMENTS = M @ W

# Relaxation rates of the moments that are not hydrodynamic: those of
# d'Humières et al. (2002), chosen there for linear stability. The stress
# moments (3pxx, pww, pxy, pyz, pxz) relax with s_nu = 1/tau, set per cell by
# the planner's tau and the subgrid model; density and momentum are conserved.
S_E = 1.19
S_EPS = 1.4
S_Q = 1.2
S_PI = 1.4
S_M = 1.98

#: Smagorinsky constant of the subgrid model, the same as in 2D (SPEC §10.1).
CS_SMAGORINSKY = 0.1


def equilibrium_moments(rho: float, j: np.ndarray) -> np.ndarray:
    """The 19 equilibrium moments of a cell with density ``rho`` and momentum ``j``."""
    jx, jy, jz = j
    jj = (jx * jx + jy * jy + jz * jz) / rho
    xx = (2 * jx * jx - jy * jy - jz * jz) / rho
    ww = (jy * jy - jz * jz) / rho
    return np.array(
        [
            rho,
            -11 * rho + 19 * jj,
            3 * rho - 5.5 * jj,
            jx,
            -2 / 3 * jx,
            jy,
            -2 / 3 * jy,
            jz,
            -2 / 3 * jz,
            xx,
            -0.5 * xx,
            ww,
            -0.5 * ww,
            jx * jy / rho,
            jy * jz / rho,
            jx * jz / rho,
            0.0,
            0.0,
            0.0,
        ]
    )


def _feq(rho: float, u: np.ndarray) -> np.ndarray:
    cu = C @ u
    return W * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (u @ u))


def _check() -> None:
    assert np.allclose(MINV @ M, np.eye(Q))
    assert (C[OPPOSITE] == -C).all()
    assert (C[MIRROR[:, 3]] == C * [1, -1, -1]).all()
    assert np.isclose(W.sum(), 1.0)
    # Second- and fourth-order isotropy of the weights.
    assert np.allclose(np.einsum("k,ki,kj->ij", W, C, C), np.eye(3) / 3)
    assert np.isclose((W * C[:, 0] ** 4).sum(), 1 / 3)
    assert np.isclose((W * C[:, 0] ** 2 * C[:, 1] ** 2).sum(), 1 / 9)
    assert np.allclose(REST_MOMENTS, equilibrium_moments(1.0, np.zeros(3)))
    rng = np.random.default_rng(1)
    for _ in range(4):
        rho, u = 1 + rng.normal(0, 0.05), rng.normal(0, 0.05, 3)
        assert np.allclose(M @ _feq(rho, u), equilibrium_moments(rho, rho * u))


_check()
