# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The physical planner: ``CaseSetup`` (metres, m/s, °C) → ``CasePlan`` (lattice) (SPEC §9).

The only place where Δx, Δt, τ and the simulated Reynolds number are decided
(SPEC §4, decision 4): the solver consumes a plan, the interface shows the
plan's numbers and texts.

**Frames.** The profile lives in its own coordinates (metres, x along the wind
at zero incidence). In the chamber (origin at the bottom-left corner, x
downstream, y up, the floor at y = 0) a profile point ``p`` sits at

    q = position + R(−incidence) · (p − pivot)

``pivot`` is the centre of the profile's box at zero incidence (for a 3D model:
of the box over every depth), so incidence turns the body about its middle;
positive incidence is nose up, a clockwise turn for a wind towards +x.

**Chamber (SPEC §9.2).** Sized on the extent of the body at the current
incidence -- for a 3D model on the extent over every depth (``envelope``), so
scrolling the depth never replans: 2 L upstream, 5 L downstream, a height that
keeps the blockage within the study type's limit with at least 3 H of clear
air above (and below, without a floor). A chamber passed in ``domain`` is kept
-- same grid, same flow -- unless the body no longer fits in it or blocks more
than 10% of it; then a new one is computed and ``resized`` says so.

**Grid.** The preset fixes the number of cells (SPEC §10.5); the aspect follows
the chamber. Sizes are multiples of 4 (the reduction pyramid of the forces) and
the chamber grows to a whole number of cells. A plan's chamber, passed back in,
gives the very same grid: the computation is iterated to a fixed point.

The blockage at the current incidence is not part of the plan: it changes with
every turn of the body, and a turn alone must not change the plan (test 18).
The interface measures it on the turned body against the plan's chamber.

**Similarity (SPEC §9.4).** ``ν_lat = U_lat · ν / (V · Δx)`` does not depend on
the reference length, so ``L_ref`` changes Re, T_c and the normalisation of the
coefficients, never the grid, τ, Δx or Δt (test 18). Below ``TAU_MIN`` the
viscosity is raised: the simulated Reynolds number is then lower than the real
one ("Similitudine parziale").
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..geometry.profile import ProfileDraft
from ..lattice import CS_SMAGORINSKY
from .fluids import FLUID_RANGES, Fluid, FluidProperties, properties

__all__ = [
    "BLOCKAGE_LIMIT",
    "CaseSetup",
    "CasePlan",
    "Domain",
    "ReferenceLength",
    "TAU_MIN",
    "TAU_MIN_FIXED_FLOOR",
    "U_LAT",
    "plan",
]

Point = tuple[float, float]
Resolution = Literal["bozza", "normale", "fine"]
Ground = Literal["none", "fixed", "moving"]
ReferenceKind = Literal["length_x", "chord", "frontal_height", "frontal_width", "height", "custom"]

#: Cells per preset (SPEC §10.5): the aspect ratio follows the chamber.
CELLS: dict[str, int] = {"bozza": 512 * 192, "normale": 1024 * 384, "fine": 2048 * 768}
#: Lattice velocity (lattice Mach 0.14), and the ceiling nothing may exceed (SPEC §9.4).
U_LAT = 0.08
U_LAT_MAX = 0.1
#: Smallest relaxation time, with the subgrid model on (SPEC §9.4), fixed on
#: 2026-10-15 by measuring on the GPU (30 000 steps a case): cylinder and NACA
#: 0012 at 0, 8 and 16° (the geometries of tests 22-24), a car over a moving
#: floor and a free square stay stable down to 0.5005; 0.502 keeps a margin of 4.
TAU_MIN = 0.502
#: With a fixed (no-slip) floor: a building on the floor with a boundary-layer
#: inlet diverges at 0.502 (|u| reaches 0.3 over the roof) and holds from 0.504.
TAU_MIN_FIXED_FLOOR = 0.504
#: Above this blockage the walls speed the flow up visibly (SPEC §9.2).
BLOCKAGE_LIMIT = 0.10
MACH_LIMIT = 0.3
#: Partial similarity: the simulated Reynolds number is below 95% of the real one.
SIMILARITY_RATIO = 0.95
UPSTREAM = 2.0  # body lengths
DOWNSTREAM = 5.0
DOWNSTREAM_MIN = 3.0
#: Below this simulated Reynolds number the body disturbs the flow far upstream
#: and the short chamber falsifies the numbers (cylinder at Re 20: Cd 2.82
#: instead of 2.24): the chamber is then longer (decision of 2026-10-15; the
#: values are provisional, set by measurement in Phase 3).
LOW_RE = 1000.0
UPSTREAM_LOW_RE = 5.0
DOWNSTREAM_LOW_RE = 10.0
CLEARANCE = 3.0  # body heights of free air above (and below)
#: A chamber at least this many body lengths tall, so that a thin plate at zero
#: incidence (H → 0) does not get a slit of a chamber. Provisional choice.
MIN_HEIGHT = 2.0
#: Smallest gap between a body and a *moving* floor, in cells. A body touching
#: the belt (or one cell above it) closes a wedge-shaped pocket that the belt
#: keeps pumping fluid into: a NACA 0012 on the belt went unstable within a
#: second, at one cell in 14 s; two cells held 40 s (GPU, Bozza, 2026-10-20).
#: Three, for a margin. A fixed floor can be touched (it holds).
MOVING_FLOOR_GAP_CELLS = 3
#: Boundary-layer inlet: power law (SPEC §9.1).
BL_EXPONENT = 0.16
BL_REFERENCE_HEIGHT = 10.0  # metres
#: Outlet sponge (SPEC §9.3): last 8% of the chamber, viscosity up to 10 times.
SPONGE_FRACTION = 0.08
SPONGE_FACTOR = 10.0
#: ...and there the transverse velocity is relaxed towards zero, at a rate per
#: step growing linearly to this value: it absorbs the chamber's transverse
#: acoustic mode, which resonates with vortex shedding (decision of 2026-10-15).
SPONGE_DAMPING = 0.05
RAMP_MIN_STEPS = 1000
GRID_MULTIPLE = 4
GRID_MIN = 32
GRID_MAX = 8192


class Domain(BaseModel):
    """The chamber, metres."""

    width_m: float = Field(gt=0.0)
    height_m: float = Field(gt=0.0)


class ReferenceLength(BaseModel):
    """What the coefficients are normalised by (SPEC §9.6).

    ``value_m`` set: that length (a "fissa" reference, or one typed by the
    user). Unset: measured on the profile at zero incidence -- along x for
    ``chord`` and ``length_x``, across the wind for the others.
    """

    kind: ReferenceKind
    value_m: float | None = Field(default=None, gt=0.0)


class CaseSetup(BaseModel):
    """A case as the user chose it: physical units (SPEC §9.1)."""

    #: The profile: a saved one, or the live section of a model (in memory).
    profile: ProfileDraft
    #: For a 3D model, the profile-plane box of the rotated model over every
    #: depth (min x, min y, max x, max y): the chamber is sized on it.
    envelope: tuple[float, float, float, float] | None = None
    #: Where the pivot sits in the chamber, metres; None = the planner's choice.
    position: Point | None = None
    fluid: Fluid = "aria"
    temperature_c: float = 20.0
    speed: float = Field(default=10.0, ge=0.1, le=120.0)
    angle_deg: float = Field(default=0.0, ge=-90.0, le=90.0)
    ground: Ground = "none"
    inlet_profile: Literal["uniform", "boundary_layer"] = "uniform"
    domain: Domain | None = None
    resolution: Resolution = "normale"
    reference_length: ReferenceLength = ReferenceLength(kind="chord")
    #: Blockage the chamber is sized for (study type, SPEC §6.5).
    max_blockage: float = Field(default=0.05, gt=0.0, le=0.2)
    #: "Riprova con Re simulato più basso": each retry halves the simulated Re.
    re_sim_scale: float = Field(default=1.0, gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _checks(self) -> CaseSetup:
        lo, hi = FLUID_RANGES[self.fluid]
        if not lo <= self.temperature_c <= hi:
            name = "dell'aria" if self.fluid == "aria" else "dell'acqua"
            raise ValueError(f"la temperatura {name} va da {lo:g} a {hi:g} °C")
        if self.inlet_profile == "boundary_layer" and self.ground == "none":
            raise ValueError("lo strato limite in ingresso richiede un pavimento")
        # A 3D model is sized on its envelope: its section may be empty here
        # (the plane does not cut the model at this depth).
        if self.envelope is None and not any(len(loop.points) >= 3 for loop in self.profile.loops):
            raise ValueError("il profilo non ha contorni")
        return self


class PlanTexts(BaseModel):
    """Ready-made Italian texts for the interface (SPEC §9.4 #7)."""

    reynolds: str
    mach: str
    grid: str


class CasePlan(BaseModel):
    """A case in lattice units, produced only by :func:`plan` (SPEC §5, §9.4)."""

    nx: int
    ny: int
    #: Cell size, metres; time step, seconds.
    dx: float
    dt: float
    width_m: float
    height_m: float
    #: Profile point the incidence turns about, and where it sits in the chamber.
    pivot: Point
    position: Point
    #: The chamber was recomputed because the body no longer fitted (SPEC §9.2).
    resized: bool
    u_lat: float
    tau: float
    nu_lat: float
    tau_min: float
    smagorinsky_cs: float
    re_real: float
    re_sim: float
    partial_similarity: bool
    mach: float
    mach_warning: bool
    reference_kind: ReferenceKind
    reference_length: float
    l_lat: float
    #: Moment reference point (profile coordinates, zero incidence): 25% of the
    #: chord for a chord reference, the centre of the box otherwise (SPEC §9.5);
    #: for a 3D model, of the box over every depth.
    moment_point: Point
    #: Convective time T_c = L_ref / V, in steps (SPEC §9.4 #6).
    tc_steps: float
    ramp_steps: int
    #: End of the start-up ramp + 3 T_c: averages begin here (SPEC §9.5).
    transient_steps: int
    #: Ceiling of a series point: ramp + 20 T_c (SPEC §11.3).
    max_steps: int
    ground: Ground
    #: Least distance between the body and the floor, metres (moving floor: a few cells).
    #: Default for plans saved before it existed.
    floor_gap_m: float = 0.0
    inlet_profile: Literal["uniform", "boundary_layer"]
    inlet_exponent: float
    #: Height where the boundary-layer inlet reaches the set speed, in cells.
    inlet_reference_cells: float
    sponge_start: int
    sponge_factor: float
    sponge_damping: float
    fluid: FluidProperties
    speed: float
    #: ½ ρ V², Pa; and the force per metre of depth that a coefficient of 1 means, N/m.
    dynamic_pressure: float
    force_per_coefficient: float
    texts: PlanTexts


# --- geometry -------------------------------------------------------------------


def _points(setup: CaseSetup) -> list[Point]:
    """What the chamber is sized on: the envelope's corners, or every profile point."""
    if setup.envelope is not None:
        x0, y0, x1, y1 = setup.envelope
        return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [p for loop in setup.profile.loops for p in loop.points]


def _box(points: list[Point]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _turn(points: list[Point], pivot: Point, angle_deg: float) -> list[Point]:
    """Points turned by the incidence about the pivot (positive = nose up = clockwise)."""
    a = -math.radians(angle_deg)
    c, s = math.cos(a), math.sin(a)
    px, py = pivot
    return [(px + c * (x - px) - s * (y - py), py + s * (x - px) + c * (y - py)) for x, y in points]


def _reference(setup: CaseSetup) -> float:
    if setup.reference_length.value_m is not None:
        return setup.reference_length.value_m
    points = [p for loop in setup.profile.loops for p in loop.points] or _points(setup)
    x0, y0, x1, y1 = _box(points)
    kind = setup.reference_length.kind
    return max(x1 - x0 if kind in ("chord", "length_x", "custom") else y1 - y0, 1e-9)


def _moment_point(setup: CaseSetup) -> Point:
    # On the envelope for a 3D model: one point for every section, so that a new
    # depth does not change the plan (test 18).
    x0, y0, x1, y1 = _box(_points(setup))
    if setup.reference_length.kind == "chord":
        return (x0 + 0.25 * (x1 - x0), (y0 + y1) / 2)
    return ((x0 + x1) / 2, (y0 + y1) / 2)


def _round_cells(value: float) -> int:
    n = int(round(value / GRID_MULTIPLE)) * GRID_MULTIPLE
    return min(GRID_MAX, max(GRID_MIN, n))


def _grid(width: float, height: float, cells: int) -> tuple[int, int, float]:
    """Cells across, cells up, cell size for a chamber; iterated to a fixed point."""
    for _ in range(8):
        nx = _round_cells(math.sqrt(cells * width / height))
        ny = _round_cells(cells / nx)
        # 12 significant digits: the chamber of a plan, passed back in, gives
        # back the same cell size to the last bit, not one ulp away.
        dx = float(f"{max(width / nx, height / ny):.12g}")
        if math.isclose(nx * dx, width, rel_tol=1e-12) and math.isclose(
            ny * dx, height, rel_tol=1e-12
        ):
            break
        width, height = nx * dx, ny * dx
    return nx, ny, dx


def _auto_chamber(
    box: tuple[float, float, float, float],
    setup: CaseSetup,
    floor_level: float,
    lengths: tuple[float, float],
) -> tuple[float, float]:
    x0, y0, x1, y1 = box
    length = max(x1 - x0, 1e-9)
    tall = max(y1 - y0, 1e-9)
    width = (lengths[0] + 1.0 + lengths[1]) * length
    if setup.ground == "none":
        height = max(tall / setup.max_blockage, (1 + 2 * CLEARANCE) * tall)
    else:
        top = y1 - floor_level
        height = max(tall / setup.max_blockage, top + CLEARANCE * tall)
    return width, max(height, MIN_HEIGHT * length)


def _default_position(
    box: tuple[float, float, float, float],
    pivot: Point,
    height: float,
    setup: CaseSetup,
    floor: float,
    upstream: float,
) -> Point:
    x0, y0, x1, y1 = box
    length = x1 - x0
    px = upstream * length - x0 + pivot[0]
    if setup.ground == "none":
        return (px, height / 2 - (y0 + y1) / 2 + pivot[1])
    return (px, pivot[1] - floor)


def _fits(
    box: tuple[float, float, float, float],
    pivot: Point,
    position: Point,
    width: float,
    height: float,
) -> bool:
    x0, y0, x1, y1 = box
    dx, dy = position[0] - pivot[0], position[1] - pivot[1]
    length = x1 - x0
    eps = 1e-9 * max(width, height)
    return (
        x0 + dx >= -eps
        and y0 + dy >= -eps
        and y1 + dy <= height + eps
        and width - (x1 + dx) >= DOWNSTREAM_MIN * length - eps
    )


def tau_min(setup: CaseSetup) -> float:
    return TAU_MIN_FIXED_FLOOR if setup.ground == "fixed" else TAU_MIN


def _similarity(
    setup: CaseSetup, nu: float, dx: float, height: float
) -> tuple[float, float, float]:
    """Lattice velocity, lattice viscosity and simulated Re on a grid of cell ``dx``."""
    u_lat = U_LAT
    if setup.inlet_profile == "boundary_layer":
        # The power law grows with height: the top of the chamber may not exceed U_LAT_MAX.
        top = (height / BL_REFERENCE_HEIGHT) ** BL_EXPONENT
        u_lat = min(U_LAT, U_LAT_MAX / max(top, 1.0))
    nu_lat = u_lat * nu / (setup.speed * dx)
    nu_lat = max(nu_lat, (tau_min(setup) - 0.5) / 3.0) / setup.re_sim_scale
    return u_lat, nu_lat, u_lat * (_reference(setup) / dx) / nu_lat


# --- texts -----------------------------------------------------------------------

_SUPERSCRIPT = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def _it(value: float, digits: int) -> str:
    text = f"{value:,.{digits}f}"
    return text.replace(",", " ").replace(".", ",").replace(" ", ".")


def reynolds_text(value: float) -> str:
    """4100000 → "4,1·10⁶"; small numbers plainly."""
    if value < 1000:
        return _it(value, 1 if value < 10 else 0)
    exponent = math.floor(math.log10(value))
    mantissa = value / 10**exponent
    if round(mantissa, 1) >= 10:
        mantissa /= 10
        exponent += 1
    return f"{_it(mantissa, 1)}·10{str(exponent).translate(_SUPERSCRIPT)}"


# --- the plan ----------------------------------------------------------------------


def plan(setup: CaseSetup) -> CasePlan:
    sized_on = _points(setup)
    zero = _box(sized_on)
    pivot = ((zero[0] + zero[2]) / 2, (zero[1] + zero[3]) / 2)
    box = _box(_turn(sized_on, pivot, setup.angle_deg))
    floor_level = min(0.0, box[1])
    cells = CELLS[setup.resolution]
    tall = box[3] - box[1]

    fluid = properties(setup.fluid, setup.temperature_c)
    speed = setup.speed

    def lengths_for(dx: float, height: float) -> tuple[float, float]:
        """The chamber's upstream and downstream lengths for the Re this grid simulates."""
        re_sim = _similarity(setup, fluid.kinematic_viscosity, dx, height)[2]
        return (UPSTREAM_LOW_RE, DOWNSTREAM_LOW_RE) if re_sim < LOW_RE else (UPSTREAM, DOWNSTREAM)

    def automatic() -> tuple[float, float, tuple[float, float]]:
        # The long chamber first: a coarser grid simulates a lower Re, so if even
        # the long chamber's grid stays below LOW_RE, the long chamber is the one.
        long = (UPSTREAM_LOW_RE, DOWNSTREAM_LOW_RE)
        width, height = _auto_chamber(box, setup, floor_level, long)
        _, _, dx = _grid(width, height, cells)
        if lengths_for(dx, height) == long:
            return width, height, long
        short = (UPSTREAM, DOWNSTREAM)
        return (*_auto_chamber(box, setup, floor_level, short), short)

    resized = False
    position = setup.position
    if setup.domain is not None:
        width, height = setup.domain.width_m, setup.domain.height_m
        _, _, dx = _grid(width, height, cells)
        lengths = lengths_for(dx, height)
        where = position or _default_position(box, pivot, height, setup, floor_level, lengths[0])
        if not _fits(box, pivot, where, width, height) or tall / height > BLOCKAGE_LIMIT:
            resized = True
            position = None
            width, height, lengths = automatic()
    else:
        width, height, lengths = automatic()
    nx, ny, dx = _grid(width, height, cells)
    width, height = nx * dx, ny * dx
    floor_gap = MOVING_FLOOR_GAP_CELLS * dx if setup.ground == "moving" else 0.0
    if position is None:
        position = _default_position(box, pivot, height, setup, floor_level, lengths[0])
        if setup.ground != "none":
            # At the real height the lowest point is box[1] - floor_level above the floor.
            lift = max(0.0, floor_gap - (box[1] - floor_level))
            position = (position[0], position[1] + lift)

    u_lat, nu_lat, re_sim = _similarity(setup, fluid.kinematic_viscosity, dx, height)
    inlet_reference_cells = BL_REFERENCE_HEIGHT / dx

    l_ref = _reference(setup)
    l_lat = l_ref / dx
    re_real = speed * l_ref / fluid.kinematic_viscosity
    tau = 3.0 * nu_lat + 0.5
    dt = dx * u_lat / speed
    tc_steps = l_lat / u_lat
    ramp = max(RAMP_MIN_STEPS, int(math.ceil(0.5 * tc_steps)))
    mach = speed / fluid.speed_of_sound
    partial = re_sim < SIMILARITY_RATIO * re_real

    texts = PlanTexts(
        reynolds=(
            f"Re reale {reynolds_text(re_real)} — Re simulato {reynolds_text(re_sim)}"
            if partial
            else f"Re {reynolds_text(re_real)}"
        ),
        mach=f"Mach {_it(mach, 3)}",
        grid=f"{nx} × {ny} celle da {_it(dx * 1000, 2) if dx < 1 else _it(dx, 3)}"
        + (" mm" if dx < 1 else " m"),
    )
    return CasePlan(
        nx=nx,
        ny=ny,
        dx=dx,
        dt=dt,
        width_m=width,
        height_m=height,
        pivot=pivot,
        position=position,
        resized=resized,
        u_lat=u_lat,
        tau=tau,
        nu_lat=nu_lat,
        tau_min=tau_min(setup),
        smagorinsky_cs=CS_SMAGORINSKY,
        re_real=re_real,
        re_sim=re_sim,
        partial_similarity=partial,
        mach=mach,
        mach_warning=mach > MACH_LIMIT,
        reference_kind=setup.reference_length.kind,
        reference_length=l_ref,
        l_lat=l_lat,
        moment_point=_moment_point(setup),
        tc_steps=tc_steps,
        ramp_steps=ramp,
        transient_steps=ramp + int(math.ceil(3 * tc_steps)),
        max_steps=ramp + int(math.ceil(20 * tc_steps)),
        ground=setup.ground,
        floor_gap_m=floor_gap,
        inlet_profile=setup.inlet_profile,
        inlet_exponent=BL_EXPONENT,
        inlet_reference_cells=inlet_reference_cells,
        sponge_start=int(round(nx * (1 - SPONGE_FRACTION))),
        sponge_factor=SPONGE_FACTOR,
        sponge_damping=SPONGE_DAMPING,
        fluid=fluid,
        speed=speed,
        dynamic_pressure=0.5 * fluid.density * speed**2,
        force_per_coefficient=0.5 * fluid.density * speed**2 * l_ref,
        texts=texts,
    )
