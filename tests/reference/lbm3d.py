# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The 3D reference solver: the WGSL solver's algorithm on the CPU, in Numba (SPEC §24.4).

The D3Q19 counterpart of ``lbm2d.py``, and the same algorithm with one more
axis: same constants (``gdv.lattice3d``), float32 throughout, populations
stored as deviations from the rest weights. It validates the physics without
a GPU (tests 37-38) and is what the WGSL solver
(``frontend/src/sim3d/shaders.ts``) is compared against (test 39): the two must
stay the same algorithm.

One fused step in *pull* form: cell x gathers f_k(x) = f*_k(x − c_k) from the
post-collision state of the previous step, then collides (MRT with the
Smagorinsky subgrid model on the stress moments) and stores f*(x). Where
x − c_k is not fluid:

- below the floor (z < 0) with a floor: bounce-back, plus 6 w_k (c_k · u_wall)
  when the floor moves with the wind;
- otherwise, across a side wall (y), the ceiling, or the bottom without a
  floor: free slip -- each component of c_k that crosses a wall changes sign
  and the source stays on this side, f_k(x) = f*_k'(x') -- and if that source
  is solid, bounce-back;
- a solid cell (the body): halfway bounce-back, f_k(x) = f*_k̄(x);
- beyond the outlet (last plane): zero gradient, the source plane is clamped;
- the inlet plane (x = 0) is not collided: it holds the equilibrium at the
  inlet velocity with the density of its downstream neighbour (the sum of its
  populations).

The inlet velocity ramps up as U · ½(1 − cos(π t / T_ramp)), uniform or with
the boundary-layer shape of its row. Over the outlet sponge the viscosity grows
and the populations are drawn towards the undisturbed stream, exactly as in 2D
(SPEC §9.3).

The moments are computed with the nonzero entries of ``lattice3d.M`` and the
relaxation goes back through the nonzero entries of ``lattice3d.MINV`` (in
float32, in the order of the matrices), as the generated WGSL does. Here too
the products are written out from the matrices (:func:`_written_out`): loops
over the sparse entries run five times slower. Generated code cannot be cached
by Numba, so the 3D kernels compile once per session (a few seconds).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numba as nb
import numpy as np

from gdv import lattice3d

F32 = np.float32
Q = lattice3d.Q

_CX = lattice3d.C[:, 0].astype(np.int64)
_CY = lattice3d.C[:, 1].astype(np.int64)
_CZ = lattice3d.C[:, 2].astype(np.int64)
_W = lattice3d.W.astype(F32)
_OPP = lattice3d.OPPOSITE.astype(np.int64)
#: MIRROR[k, flags]: direction k with cy flipped (flags & 1) and cz flipped (flags & 2).
_MIR = lattice3d.MIRROR.astype(np.int64)

#: Rows of M that relax (density and momentum are conserved).
RELAXED = np.array([r for r in range(Q) if r not in (0, 3, 5, 7)], dtype=np.int64)


def _sparse(matrix: np.ndarray, columns: np.ndarray | None = None):
    """Row-wise nonzero entries (row pointers, column indices, float32 values)."""
    ptr, idx, val = [0], [], []
    for row in matrix:
        for k, v in enumerate(row):
            if v != 0.0 and (columns is None or k in columns):
                idx.append(k)
                val.append(v)
        ptr.append(len(idx))
    return np.array(ptr, np.int64), np.array(idx, np.int64), np.array(val, F32)


_M_PTR, _M_IDX, _M_VAL = _sparse(lattice3d.M)
_MI_PTR, _MI_IDX, _MI_VAL = _sparse(lattice3d.MINV, RELAXED)

GROUND = {"none": 0, "fixed": 1, "moving": 2}


def _written_out() -> dict:
    """``_moments(g, m)`` and ``_relax(g, dm, out, z, y, x)``, unrolled from the matrices."""
    lines = ["def _moments(g, m):"]
    for r in range(Q):
        entries = range(_M_PTR[r], _M_PTR[r + 1])
        terms = [f"F32({float(_M_VAL[e])!r}) * g[{_M_IDX[e]}]" for e in entries]
        lines.append(f"    m[{r}] = " + " + ".join(terms))
    lines.append("def _relax(g, dm, out, z, y, x):")
    for k in range(Q):
        entries = range(_MI_PTR[k], _MI_PTR[k + 1])
        terms = [f"F32({float(_MI_VAL[e])!r}) * dm[{_MI_IDX[e]}]" for e in entries]
        lines.append(f"    out[{k}, z, y, x] = g[{k}] - (" + " + ".join(terms) + ")")
    namespace = {"F32": F32}
    exec(compile("\n".join(lines), "<lbm3d written out>", "exec"), namespace)
    return {name: nb.njit(inline="always")(namespace[name]) for name in ("_moments", "_relax")}


_kernels = _written_out()
_moments = _kernels["_moments"]
_relax = _kernels["_relax"]


@dataclass
class LatticeCase3D:
    """What the solver needs, in lattice units (a ``CasePlan3D`` plus the voxels)."""

    nx: int
    ny: int
    nz: int
    tau: float
    u_lat: float
    mask: np.ndarray  # uint8 (nz, ny, nx)
    ramp_steps: int = 1000
    ground: str = "none"
    #: Inlet velocity per row (z) as a fraction of u_lat (None = uniform).
    inlet_shape: np.ndarray | None = None
    #: First sponge plane (None = no sponge).
    sponge_start: int | None = None
    sponge_factor: float = 10.0
    sponge_damping: float = 0.05
    #: Smagorinsky constant; 0 switches the subgrid model off.
    cs: float = lattice3d.CS_SMAGORINSKY

    @classmethod
    def from_plan(cls, plan, mask: np.ndarray) -> LatticeCase3D:
        shape = None
        if plan.inlet_profile == "boundary_layer":
            shape = inlet_shape(plan.nz, plan.inlet_exponent, plan.inlet_reference_cells)
        return cls(
            nx=plan.nx,
            ny=plan.ny,
            nz=plan.nz,
            tau=plan.tau,
            u_lat=plan.u_lat,
            mask=mask,
            ramp_steps=plan.ramp_steps,
            ground=plan.ground,
            inlet_shape=shape,
            sponge_start=plan.sponge_start,
            sponge_factor=plan.sponge_factor,
            sponge_damping=plan.sponge_damping,
            cs=plan.smagorinsky_cs,
        )


def inlet_shape(nz: int, exponent: float, reference_cells: float) -> np.ndarray:
    """Power-law boundary layer over the floor: (z / z_ref)^exponent at the row centres."""
    z = (np.arange(nz, dtype=np.float64) + 0.5) / reference_cells
    return (z**exponent).astype(F32)


@nb.njit(inline="always")
def _feq_dev(k, drho, ux, uy, uz, cx, cy, cz, w):
    rho = F32(1.0) + drho
    cu = F32(cx[k]) * ux + F32(cy[k]) * uy + F32(cz[k]) * uz
    uu = ux * ux + uy * uy + uz * uz
    return w[k] * (drho + rho * (F32(3.0) * cu + F32(4.5) * cu * cu - F32(1.5) * uu))


@nb.njit(parallel=True)
def _step(
    f, out, mask, uin, tau0, wall_u, ground, sponge_start, sponge_factor, damping, cs,
):  # fmt: skip
    nz, ny, nx = mask.shape
    cx = _CX
    cy = _CY
    cz = _CZ
    w = _W
    opp = _OPP
    mir = _MIR
    s_e = F32(lattice3d.S_E)
    s_eps = F32(lattice3d.S_EPS)
    s_q = F32(lattice3d.S_Q)
    s_pi = F32(lattice3d.S_PI)
    s_m = F32(lattice3d.S_M)
    half = F32(0.5)
    third = F32(1.0 / 3.0)
    two3 = F32(2.0 / 3.0)
    smag = F32(18.0) * F32(math.sqrt(2.0)) * cs * cs
    for zp in nb.prange(nz):
        z = np.int64(zp)  # the prange index is unsigned: sz = z must stay an integer
        g = np.empty(19, dtype=np.float32)
        m = np.empty(19, dtype=np.float32)
        dm = np.zeros(19, dtype=np.float32)
        for y in range(ny):
            for x in range(nx):
                if mask[z, y, x]:
                    for k in range(19):
                        out[k, z, y, x] = F32(0.0)
                    continue
                if x == 0:
                    drho = F32(0.0)
                    if not mask[z, y, 1]:
                        for k in range(19):
                            drho += f[k, z, y, 1]
                    ux = uin[z]
                    for k in range(19):
                        out[k, z, y, x] = _feq_dev(k, drho, ux, F32(0.0), F32(0.0), cx, cy, cz, w)
                    continue
                # --- stream (pull) with the boundaries ---
                for k in range(19):
                    sx = x - cx[k]
                    sy = y - cy[k]
                    sz = z - cz[k]
                    if sx > nx - 1:
                        sx = nx - 1
                    if sz < 0 and ground != 0:
                        v = f[opp[k], z, y, x]
                        if ground == 2:
                            v += F32(6.0) * w[k] * F32(cx[k]) * wall_u
                        g[k] = v
                        continue
                    # Free slip: mirror every component that crosses a wall.
                    flags = 0
                    if sy < 0 or sy >= ny:
                        flags |= 1
                        sy = y
                    if sz < 0 or sz >= nz:
                        flags |= 2
                        sz = z
                    if mask[sz, sy, sx]:
                        g[k] = f[opp[k], z, y, x]
                    else:
                        g[k] = f[mir[k, flags], sz, sy, sx]
                # --- collide (MRT + Smagorinsky) ---
                _moments(g, m)
                drho = m[0]
                jx = m[3]
                jy = m[5]
                jz = m[7]
                rho = F32(1.0) + drho
                jj = (jx * jx + jy * jy + jz * jz) / rho
                e_eq = F32(-11.0) * drho + F32(19.0) * jj
                eps_eq = F32(3.0) * drho - F32(5.5) * jj
                xx_eq = (F32(2.0) * jx * jx - jy * jy - jz * jz) / rho
                ww_eq = (jy * jy - jz * jz) / rho
                xy_eq = jx * jy / rho
                yz_eq = jy * jz / rho
                xz_eq = jx * jz / rho
                t0 = tau0
                sponge = F32(0.0)
                if x >= sponge_start:
                    sponge = F32(x - sponge_start) / F32(nx - 1 - sponge_start)
                    t0 = half + (tau0 - half) * (F32(1.0) + (sponge_factor - F32(1.0)) * sponge)
                tau = t0
                if cs > F32(0.0):
                    tr = (m[1] - e_eq) / F32(19.0)
                    pxx = (m[9] - xx_eq + tr) * third
                    pww = m[11] - ww_eq
                    pyy = half * (tr - pxx + pww)
                    pzz = half * (tr - pxx - pww)
                    pxy = m[13] - xy_eq
                    pyz = m[14] - yz_eq
                    pxz = m[15] - xz_eq
                    qq = F32(
                        math.sqrt(
                            pxx * pxx + pyy * pyy + pzz * pzz
                            + F32(2.0) * (pxy * pxy + pyz * pyz + pxz * pxz)
                        )
                    )  # fmt: skip
                    tau = half * (t0 + F32(math.sqrt(t0 * t0 + smag * qq / rho)))
                s_nu = F32(1.0) / tau
                dm[1] = s_e * (m[1] - e_eq)
                dm[2] = s_eps * (m[2] - eps_eq)
                dm[4] = s_q * (m[4] + two3 * jx)
                dm[6] = s_q * (m[6] + two3 * jy)
                dm[8] = s_q * (m[8] + two3 * jz)
                dm[9] = s_nu * (m[9] - xx_eq)
                dm[10] = s_pi * (m[10] + half * xx_eq)
                dm[11] = s_nu * (m[11] - ww_eq)
                dm[12] = s_pi * (m[12] + half * ww_eq)
                dm[13] = s_nu * (m[13] - xy_eq)
                dm[14] = s_nu * (m[14] - yz_eq)
                dm[15] = s_nu * (m[15] - xz_eq)
                dm[16] = s_m * m[16]
                dm[17] = s_m * m[17]
                dm[18] = s_m * m[18]
                _relax(g, dm, out, z, y, x)
                if sponge > F32(0.0) and damping > F32(0.0):
                    # Absorbing layer: a fraction sig of the way to the equilibrium of
                    # the undisturbed stream (density 1, the row's inlet velocity).
                    sig = damping * sponge
                    ut = uin[z]
                    ux = jx / rho
                    uy = jy / rho
                    uz = jz / rho
                    for k in range(19):
                        out[k, z, y, x] += sig * (
                            _feq_dev(k, F32(0.0), ut, F32(0.0), F32(0.0), cx, cy, cz, w)
                            - _feq_dev(k, drho, ux, uy, uz, cx, cy, cz, w)
                        )


@nb.njit
def _run(
    f, f2, mask, shape, u_lat, ramp_steps, start, steps, tau0, ground, sponge_start,
    sponge_factor, damping, cs,
):  # fmt: skip
    uin = np.empty(shape.shape[0], dtype=np.float32)
    for n in range(steps):
        t = start + n
        r = 1.0
        if ramp_steps > 0 and t < ramp_steps:
            r = 0.5 * (1.0 - math.cos(math.pi * t / ramp_steps))
        u = u_lat * F32(r)
        for z in range(uin.shape[0]):
            uin[z] = u * shape[z]
        _step(f, f2, mask, uin, tau0, u, ground, sponge_start, sponge_factor, damping, cs)
        f, f2 = f2, f
    return f, f2


@nb.njit(cache=True, parallel=True)
def _forces(f, mask, cx, cy, cz, w):
    """Momentum exchange on the body links, per z plane: Fx, Fy, Fz in lattice
    units, then Σ 2 w_k c_k over the same links (what a fluid at rest with unit
    density would push: zero unless the body touches a wall or the floor)."""
    nz, ny, nx = mask.shape
    out = np.zeros((nz, 6))
    for z in nb.prange(nz):
        for y in range(ny):
            for x in range(nx):
                if mask[z, y, x]:
                    continue
                for k in range(1, 19):
                    a = x + cx[k]
                    b = y + cy[k]
                    c = z + cz[k]
                    if a < 0 or a >= nx or b < 0 or b >= ny or c < 0 or c >= nz:
                        continue
                    if not mask[c, b, a]:
                        continue
                    p = 2.0 * (float(w[k]) + float(f[k, z, y, x]))
                    out[z, 0] += p * cx[k]
                    out[z, 1] += p * cy[k]
                    out[z, 2] += p * cz[k]
                    out[z, 3] += 2.0 * float(w[k]) * cx[k]
                    out[z, 4] += 2.0 * float(w[k]) * cy[k]
                    out[z, 5] += 2.0 * float(w[k]) * cz[k]
    return out


@nb.njit(cache=True, parallel=True)
def _macro(f, mask, cx, cy, cz):
    """(δρ, ux, uy, uz) per cell from the populations (zero in the body)."""
    _, nz, ny, nx = f.shape
    out = np.zeros((4, nz, ny, nx))
    for z in nb.prange(nz):
        for y in range(ny):
            for x in range(nx):
                if mask[z, y, x]:
                    continue
                d = 0.0
                jx = 0.0
                jy = 0.0
                jz = 0.0
                for k in range(19):
                    v = float(f[k, z, y, x])
                    d += v
                    jx += v * cx[k]
                    jy += v * cy[k]
                    jz += v * cz[k]
                rho = 1.0 + d
                out[0, z, y, x] = d
                out[1, z, y, x] = jx / rho
                out[2, z, y, x] = jy / rho
                out[3, z, y, x] = jz / rho
    return out


def check_moments(seed: int = 0) -> float:
    """Largest gap between the sparse float32 matrices and ``lattice3d.M``, ``MINV``."""
    rng = np.random.default_rng(seed)
    g = rng.normal(0, 0.01, Q)
    gap = 0.0
    for r in range(Q):
        got = sum(float(_M_VAL[e]) * g[_M_IDX[e]] for e in range(_M_PTR[r], _M_PTR[r + 1]))
        gap = max(gap, abs(got - float(lattice3d.M[r] @ g)))
    d = rng.normal(0, 0.01, Q)
    d[[0, 3, 5, 7]] = 0.0
    for k in range(Q):
        got = sum(float(_MI_VAL[e]) * d[_MI_IDX[e]] for e in range(_MI_PTR[k], _MI_PTR[k + 1]))
        gap = max(gap, abs(got - float(lattice3d.MINV[k] @ d)))
    return gap


class Reference3D:
    """A running 3D reference simulation."""

    def __init__(self, case: LatticeCase3D) -> None:
        self.case = case
        nz, ny, nx = case.nz, case.ny, case.nx
        assert case.mask.shape == (nz, ny, nx)
        self.mask = np.ascontiguousarray(case.mask, dtype=np.uint8)
        self.f = np.zeros((Q, nz, ny, nx), dtype=F32)
        self._f2 = np.zeros_like(self.f)
        self.shape = (
            np.ones(nz, dtype=F32) if case.inlet_shape is None else case.inlet_shape.astype(F32)
        )
        self.sponge_start = nx if case.sponge_start is None else case.sponge_start
        self.step_count = 0

    def run(self, steps: int) -> None:
        c = self.case
        self.f, self._f2 = _run(
            self.f,
            self._f2,
            self.mask,
            self.shape,
            F32(c.u_lat),
            c.ramp_steps,
            self.step_count,
            steps,
            F32(c.tau),
            GROUND[c.ground],
            self.sponge_start,
            F32(c.sponge_factor),
            F32(c.sponge_damping),
            F32(c.cs),
        )
        self.step_count += steps

    def forces(self) -> tuple[float, float, float]:
        """Fx, Fy, Fz on the body, lattice units, relative to the undisturbed
        pressure ρ∞ / 3: a body standing on the floor is not pushed down by
        the pressure of the air at rest (SPEC §9.5)."""
        sums = _forces(self.f, self.mask, _CX, _CY, _CZ, _W).sum(axis=0)
        rho = self.rho_inf()
        return tuple(float(sums[a] - rho * sums[3 + a]) for a in range(3))

    def macro(self) -> np.ndarray:
        """(δρ, ux, uy, uz) per cell, float64, shape (4, nz, ny, nx)."""
        return _macro(self.f, self.mask, _CX, _CY, _CZ)

    def rho_inf(self) -> float:
        """Undisturbed density: the mean over the fluid cells of plane x = 1 (SPEC §9.5)."""
        fluid = self.mask[:, :, 1] == 0
        drho = self.f[:, :, :, 1].astype(np.float64).sum(axis=0)
        return float((1.0 + drho[fluid]).mean())

    def coefficients(self, area: float) -> tuple[float, float, float]:
        """Cd, Cy, Cl on a reference area in cells², normalised with the measured ρ∞."""
        fx, fy, fz = self.forces()
        q = 0.5 * self.rho_inf() * self.case.u_lat**2
        return fx / (q * area), fy / (q * area), fz / (q * area)

    def unstable(self) -> bool:
        """NaN anywhere, or a fluid density outside [0.7, 1.3] (SPEC §9.5)."""
        rho = 1.0 + self.f.astype(np.float64).sum(axis=0)[self.mask == 0]
        return bool(not np.isfinite(rho).all() or rho.min() < 0.7 or rho.max() > 1.3)
