# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The reference solver: the shader's algorithm on the CPU, in Numba (SPEC §10.8).

Same constants (``gdv.lattice``), same mask (``gdv.geometry.raster2d``), same
boundaries, float32 throughout, populations stored as deviations from the rest
weights. It validates the physics without a GPU (tests 21-24, 26) and is what
the shader (``frontend/src/sim2d/shaders/step.ts``) is compared against
(test 25): the two must stay the same algorithm.

One fused step in *pull* form: cell x gathers f_k(x) = f*_k(x − c_k) from the
post-collision state of the previous step, then collides (MRT with the
Smagorinsky subgrid model on the stress moments) and stores f*(x) and its
macroscopic values (δρ, ux, uy). Where x − c_k is not fluid:

- a solid cell (the body): halfway bounce-back, f_k(x) = f*_k̄(x);
- beyond the outlet (last column): zero gradient, the source column is clamped;
- below the floor: bounce-back, plus 6 w_k (c_k · u_wall) when the floor moves
  with the wind; above the top wall, or below without a floor: free slip,
  f_k(x) = f*_mirror(k)(x − cx_k, y);
- the inlet column is not collided: it holds the equilibrium at the inlet
  velocity with the density of its downstream neighbour.

The inlet velocity ramps up as U · ½(1 − cos(π t / T_ramp)). Over the outlet
sponge, with s going linearly from 0 to 1 across its columns, ν0 grows to
``sponge_factor`` times its value and, after the collision, the populations
move a fraction ``sponge_damping · s`` of the way from their equilibrium to the
equilibrium of the undisturbed stream (density 1, the row's inlet velocity, no
transverse velocity): an absorbing layer. It absorbs the chamber's transverse
acoustic mode, which otherwise resonates with vortex shedding, and it holds the
pressure level, which otherwise climbs without end when a wall has friction
(decisions of 2026-10-15, SPEC §9.3).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numba as nb
import numpy as np

from gdv import lattice

F32 = np.float32

_CX = lattice.C[:, 0].astype(np.int64)
_CY = lattice.C[:, 1].astype(np.int64)
_W = lattice.W.astype(F32)
_OPP = lattice.OPPOSITE.astype(np.int64)
_MIR = lattice.MIRROR_Y.astype(np.int64)

GROUND = {"none": 0, "fixed": 1, "moving": 2}


@dataclass
class LatticeCase:
    """What the solver needs, in lattice units (a ``CasePlan`` plus the mask)."""

    nx: int
    ny: int
    tau: float
    u_lat: float
    mask: np.ndarray  # uint8 (ny, nx)
    ramp_steps: int = 1000
    ground: str = "none"
    #: Inlet velocity per row as a fraction of u_lat (None = uniform).
    inlet_shape: np.ndarray | None = None
    #: First sponge column (None = no sponge).
    sponge_start: int | None = None
    sponge_factor: float = 10.0
    sponge_damping: float = 0.05
    #: Smagorinsky constant; 0 switches the subgrid model off.
    cs: float = lattice.CS_SMAGORINSKY

    @classmethod
    def from_plan(cls, plan, mask: np.ndarray) -> LatticeCase:
        shape = None
        if plan.inlet_profile == "boundary_layer":
            shape = inlet_shape(plan.ny, plan.inlet_exponent, plan.inlet_reference_cells)
        return cls(
            nx=plan.nx,
            ny=plan.ny,
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


def ramp(step: int, ramp_steps: int) -> float:
    """Fraction of the inlet speed at a step (the same double the shader gets)."""
    if ramp_steps <= 0 or step >= ramp_steps:
        return 1.0
    return 0.5 * (1.0 - math.cos(math.pi * step / ramp_steps))


def inlet_shape(ny: int, exponent: float, reference_cells: float) -> np.ndarray:
    """Power-law boundary layer over the floor: (z / z_ref)^exponent at the row centres."""
    z = (np.arange(ny, dtype=np.float64) + 0.5) / reference_cells
    return (z**exponent).astype(F32)


@nb.njit(cache=True, inline="always")
def _feq_dev(k, drho, ux, uy, cx, cy, w):
    rho = F32(1.0) + drho
    cu = F32(cx[k]) * ux + F32(cy[k]) * uy
    uu = ux * ux + uy * uy
    return w[k] * (drho + rho * (F32(3.0) * cu + F32(4.5) * cu * cu - F32(1.5) * uu))


@nb.njit(cache=True, inline="always")
def _moments(g, m):
    """m = M g, written out (``check_moments`` compares it with ``lattice.M``)."""
    sa = g[1] + g[2] + g[3] + g[4]
    sd = g[5] + g[6] + g[7] + g[8]
    m[0] = g[0] + sa + sd
    m[1] = F32(-4.0) * g[0] - sa + F32(2.0) * sd
    m[2] = F32(4.0) * g[0] - F32(2.0) * sa + sd
    ex = g[1] - g[3]
    ey = g[2] - g[4]
    dx_ = g[5] - g[6] - g[7] + g[8]
    dy_ = g[5] + g[6] - g[7] - g[8]
    m[3] = ex + dx_
    m[4] = F32(-2.0) * ex + dx_
    m[5] = ey + dy_
    m[6] = F32(-2.0) * ey + dy_
    m[7] = g[1] - g[2] + g[3] - g[4]
    m[8] = g[5] - g[6] + g[7] - g[8]


@nb.njit(cache=True, inline="always")
def _relax_back(g, d1, d2, d4, d6, d7, d8, out, j, i):
    """out = g − M⁻¹ Δm for the six relaxed moments, written out."""
    a = d1 / F32(36.0) + d2 / F32(18.0)
    b = d1 / F32(18.0) + d2 / F32(36.0)
    q4 = d4 / F32(6.0)
    q6 = d6 / F32(6.0)
    h4 = d4 / F32(12.0)
    h6 = d6 / F32(12.0)
    p7 = d7 / F32(4.0)
    p8 = d8 / F32(4.0)
    out[0, j, i] = g[0] - (d2 - d1) / F32(9.0)
    out[1, j, i] = g[1] - (-a - q4 + p7)
    out[2, j, i] = g[2] - (-a - q6 - p7)
    out[3, j, i] = g[3] - (-a + q4 + p7)
    out[4, j, i] = g[4] - (-a + q6 - p7)
    out[5, j, i] = g[5] - (b + h4 + h6 + p8)
    out[6, j, i] = g[6] - (b - h4 + h6 - p8)
    out[7, j, i] = g[7] - (b - h4 - h6 + p8)
    out[8, j, i] = g[8] - (b + h4 - h6 - p8)


@nb.njit(cache=True, parallel=True)
def _step(
    f, out, macro, macro_out, mask, uin, tau0, wall_u, ground, sponge_start, sponge_factor,
    damping, cs,
):  # fmt: skip
    ny, nx = mask.shape
    cx = _CX
    cy = _CY
    w = _W
    opp = _OPP
    mir = _MIR
    s_e = F32(lattice.S_E)
    s_eps = F32(lattice.S_EPS)
    s_q = F32(lattice.S_Q)
    half = F32(0.5)
    smag = F32(18.0) * F32(math.sqrt(2.0)) * cs * cs
    for j in nb.prange(ny):
        g = np.empty(9, dtype=np.float32)
        m = np.empty(9, dtype=np.float32)
        for i in range(nx):
            if mask[j, i]:
                for k in range(9):
                    out[k, j, i] = F32(0.0)
                macro_out[0, j, i] = F32(0.0)
                macro_out[1, j, i] = F32(0.0)
                macro_out[2, j, i] = F32(0.0)
                continue
            if i == 0:
                drho = F32(0.0) if mask[j, 1] else macro[0, j, 1]
                ux = uin[j]
                for k in range(9):
                    out[k, j, i] = _feq_dev(k, drho, ux, F32(0.0), cx, cy, w)
                macro_out[0, j, i] = drho
                macro_out[1, j, i] = ux
                macro_out[2, j, i] = F32(0.0)
                continue
            # --- stream (pull) with the boundaries ---
            for k in range(9):
                sx = i - cx[k]
                sy = j - cy[k]
                if sx > nx - 1:
                    sx = nx - 1
                if sy < 0 or sy >= ny:
                    if sy < 0 and ground != 0:
                        v = f[opp[k], j, i]
                        if ground == 2:
                            v += F32(6.0) * w[k] * F32(cx[k]) * wall_u
                        g[k] = v
                    elif mask[j, sx]:
                        g[k] = f[opp[k], j, i]
                    else:
                        g[k] = f[mir[k], j, sx]
                elif mask[sy, sx]:
                    g[k] = f[opp[k], j, i]
                else:
                    g[k] = f[k, sy, sx]
            # --- collide (MRT + Smagorinsky) ---
            _moments(g, m)
            drho = m[0]
            jx = m[3]
            jy = m[5]
            rho = F32(1.0) + drho
            jj = (jx * jx + jy * jy) / rho
            e_eq = F32(-2.0) * drho + F32(3.0) * jj
            eps_eq = drho - F32(3.0) * jj
            pxx_eq = (jx * jx - jy * jy) / rho
            pxy_eq = jx * jy / rho
            t0 = tau0
            sponge = F32(0.0)
            if i >= sponge_start:
                sponge = F32(i - sponge_start) / F32(nx - 1 - sponge_start)
                t0 = half + (tau0 - half) * (F32(1.0) + (sponge_factor - F32(1.0)) * sponge)
            tau = t0
            if cs > F32(0.0):
                tr = (m[1] - e_eq) / F32(3.0)
                d = m[7] - pxx_eq
                pxx = half * (tr + d)
                pyy = half * (tr - d)
                pxy = m[8] - pxy_eq
                qq = F32(math.sqrt(pxx * pxx + pyy * pyy + F32(2.0) * pxy * pxy))
                tau = half * (t0 + F32(math.sqrt(t0 * t0 + smag * qq / rho)))
            s_nu = F32(1.0) / tau
            _relax_back(
                g,
                s_e * (m[1] - e_eq),
                s_eps * (m[2] - eps_eq),
                s_q * (m[4] + jx),
                s_q * (m[6] + jy),
                s_nu * (m[7] - pxx_eq),
                s_nu * (m[8] - pxy_eq),
                out,
                j,
                i,
            )
            ux = jx / rho
            uy = jy / rho
            if sponge > F32(0.0) and damping > F32(0.0):
                # Absorbing layer: a fraction sig of the way to the equilibrium of
                # the undisturbed stream (density 1, the row's inlet velocity).
                sig = damping * sponge
                ut = uin[j]
                for k in range(9):
                    out[k, j, i] += sig * (
                        _feq_dev(k, F32(0.0), ut, F32(0.0), cx, cy, w)
                        - _feq_dev(k, drho, ux, uy, cx, cy, w)
                    )
                drho = drho - sig * drho
                jx = jx + sig * (ut - jx)
                jy = jy - sig * jy
                rho = F32(1.0) + drho
                ux = jx / rho
                uy = jy / rho
            macro_out[0, j, i] = drho
            macro_out[1, j, i] = ux
            macro_out[2, j, i] = uy


@nb.njit(cache=True)
def _run(
    f, f2, macro, m2, mask, shape, u_lat, ramp_steps, start, steps, tau0, ground,
    sponge_start, sponge_factor, damping, cs,
):  # fmt: skip
    uin = np.empty(shape.shape[0], dtype=np.float32)
    for n in range(steps):
        t = start + n
        r = 1.0
        if ramp_steps > 0 and t < ramp_steps:
            r = 0.5 * (1.0 - math.cos(math.pi * t / ramp_steps))
        u = u_lat * F32(r)
        for j in range(uin.shape[0]):
            uin[j] = u * shape[j]
        _step(
            f, f2, macro, m2, mask, uin, tau0, u, ground, sponge_start, sponge_factor, damping,
            cs,
        )  # fmt: skip
        f, f2 = f2, f
        macro, m2 = m2, macro
    return f, f2, macro, m2


@nb.njit(cache=True)
def _forces(f, mask, cx, cy, w, xr, yr):
    """Momentum exchange on the body links: Fx, Fy, Mz (about xr, yr, cell units),
    then the same sums with the rest populations alone (what a fluid at rest with
    unit density would push: zero unless the body touches a wall or the floor)."""
    ny, nx = mask.shape
    fx = 0.0
    fy = 0.0
    mz = 0.0
    bx = 0.0
    by = 0.0
    bz = 0.0
    for j in range(ny):
        for i in range(nx):
            if mask[j, i]:
                continue
            for k in range(1, 9):
                a = i + cx[k]
                b = j + cy[k]
                if a < 0 or a >= nx or b < 0 or b >= ny or not mask[b, a]:
                    continue
                p = 2.0 * (float(w[k]) + float(f[k, j, i]))
                lx = p * cx[k]
                ly = p * cy[k]
                fx += lx
                fy += ly
                rx = i + 0.5 + 0.5 * cx[k] - xr
                ry = j + 0.5 + 0.5 * cy[k] - yr
                mz += rx * ly - ry * lx
                rest = 2.0 * float(w[k])
                bx += rest * cx[k]
                by += rest * cy[k]
                bz += rx * rest * cy[k] - ry * rest * cx[k]
    return fx, fy, mz, bx, by, bz


@nb.njit(cache=True)
def _remask(f, macro, old, new, cx, cy, w):
    """A new body: cells turned solid are zeroed, cells freed get the equilibrium
    at the mean density and velocity of their fluid neighbours (SPEC §10.3)."""
    ny, nx = new.shape
    out = f.copy()
    mout = macro.copy()
    for j in range(ny):
        for i in range(nx):
            if new[j, i]:
                for k in range(9):
                    out[k, j, i] = F32(0.0)
                mout[0, j, i] = F32(0.0)
                mout[1, j, i] = F32(0.0)
                mout[2, j, i] = F32(0.0)
            elif old[j, i]:
                n = F32(0.0)
                sr = F32(0.0)
                su = F32(0.0)
                sv = F32(0.0)
                for k in range(1, 9):
                    a = i + cx[k]
                    b = j + cy[k]
                    if a < 0 or a >= nx or b < 0 or b >= ny or old[b, a]:
                        continue
                    n += F32(1.0)
                    sr += macro[0, b, a]
                    su += macro[1, b, a]
                    sv += macro[2, b, a]
                drho = F32(0.0)
                ux = F32(0.0)
                uy = F32(0.0)
                if n > F32(0.0):
                    drho = sr / n
                    ux = su / n
                    uy = sv / n
                for k in range(9):
                    out[k, j, i] = _feq_dev(k, drho, ux, uy, cx, cy, w)
                mout[0, j, i] = drho
                mout[1, j, i] = ux
                mout[2, j, i] = uy
    return out, mout


def check_moments(seed: int = 0) -> float:
    """Largest gap between the written-out collision and the one through ``lattice.M``."""
    rng = np.random.default_rng(seed)
    g = rng.normal(0, 0.01, 9).astype(F32)
    m = np.empty(9, F32)
    _moments(g, m)
    gap = float(np.abs(m - lattice.M @ g.astype(np.float64)).max())
    d = rng.normal(0, 0.01, 9)
    d[[0, 3, 5]] = 0.0
    out = np.empty((9, 1, 1), F32)
    _relax_back(g, *(F32(d[r]) for r in (1, 2, 4, 6, 7, 8)), out, 0, 0)
    expected = g.astype(np.float64) - lattice.MINV @ d
    return max(gap, float(np.abs(out[:, 0, 0] - expected).max()))


class Reference:
    """A running reference simulation."""

    def __init__(self, case: LatticeCase) -> None:
        self.case = case
        ny, nx = case.ny, case.nx
        assert case.mask.shape == (ny, nx)
        self.mask = np.ascontiguousarray(case.mask, dtype=np.uint8)
        self.f = np.zeros((9, ny, nx), dtype=F32)
        self.macro = np.zeros((3, ny, nx), dtype=F32)
        self._f2 = np.zeros_like(self.f)
        self._m2 = np.zeros_like(self.macro)
        self.shape = (
            np.ones(ny, dtype=F32) if case.inlet_shape is None else case.inlet_shape.astype(F32)
        )
        self.sponge_start = nx if case.sponge_start is None else case.sponge_start
        self.step_count = 0

    def run(self, steps: int) -> None:
        c = self.case
        self.f, self._f2, self.macro, self._m2 = _run(
            self.f,
            self._f2,
            self.macro,
            self._m2,
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

    def set_mask(self, mask: np.ndarray) -> None:
        new = np.ascontiguousarray(mask, dtype=np.uint8)
        self.f, self.macro = _remask(self.f, self.macro, self.mask, new, _CX, _CY, _W)
        self.mask = new

    def forces(self, xr: float = 0.0, yr: float = 0.0) -> tuple[float, float, float]:
        """Fx, Fy, Mz on the body, lattice units (Mz about (xr, yr), cells), relative
        to the undisturbed pressure ρ∞ / 3: a body standing on the floor is not
        pushed down by the pressure of the fluid at rest (SPEC §9.5)."""
        fx, fy, mz, bx, by, bz = _forces(self.f, self.mask, _CX, _CY, _W, xr, yr)
        rho = self.rho_inf()
        return fx - rho * bx, fy - rho * by, mz - rho * bz

    def rho_inf(self) -> float:
        """Undisturbed density: the mean over the fluid cells of column 1 (SPEC §9.5)."""
        fluid = self.mask[:, 1] == 0
        return float((1.0 + self.macro[0, fluid, 1].astype(np.float64)).mean())

    def coefficients(self, length: float, xr: float = 0.0, yr: float = 0.0):
        """Cd, Cl, Cm normalised with the measured ρ∞ (decision of 2026-10-15)."""
        fx, fy, mz = self.forces(xr, yr)
        q = 0.5 * self.rho_inf() * self.case.u_lat**2
        return fx / (q * length), fy / (q * length), -mz / (q * length * length)

    @property
    def rho(self) -> np.ndarray:
        return 1.0 + self.macro[0].astype(np.float64)

    @property
    def ux(self) -> np.ndarray:
        return self.macro[1]

    @property
    def uy(self) -> np.ndarray:
        return self.macro[2]

    def unstable(self) -> bool:
        """NaN anywhere, or a fluid density outside [0.7, 1.3] (SPEC §9.5)."""
        rho = self.rho[self.mask == 0]
        return bool(not np.isfinite(rho).all() or rho.min() < 0.7 or rho.max() > 1.3)
