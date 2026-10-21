# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The 3D planner: ``CaseSetup3D`` (metres, m/s, °C) → ``CasePlan3D`` (lattice) (SPEC §24.3).

The counterpart of :mod:`gdv.physics.planner` for the 3D tunnel, and like it the
only place where Δx, Δt, τ and the simulated Reynolds number of a 3D case are
decided (SPEC §4, decision 4). The similarity rules are the 2D ones (lattice
velocity, τ_min, ramp, transient, sponge); what changes is the chamber and the
grid.

**Frames.** The model lives in its library coordinates (metres, x along the
wind, y across, z up, the floor at z = 0). The case turns it about ``pivot``,
the centre of its box: pitch first (about y, positive nose up), then yaw
(about z, positive anticlockwise seen from above). A model point ``p`` sits in
the chamber (origin at the inlet, on the side wall y = 0, on the floor) at

    q = offset + R_z(yaw) · R_y(pitch) · (p − pivot)

The interface turns the mesh, measures the turned body -- its box relative to
the pivot and its frontal area, projected on the y–z plane -- and sends them:
geometry, not physics; the planner places the body and sizes the chamber on
them.

**Chamber.** 1.5 L upstream and 3 L downstream (shorter than in 2D, for the
cells: SPEC §24.3), and a cross-section with the same margin ``m`` on the
sides and above (and below, without a floor) such that the frontal area blocks
``max_blockage`` of it (8%, 10% for vehicles), with at least half the body's
largest frontal size (width or height) as margin: a thin plate or a wing does
not end up against the walls, while a long low body (a car) is not given a
margin out of its length (SPEC §24.8). With a floor the body keeps its real height (and rests
on the floor if a rotation takes it below); without, it sits in the middle.

**Grid.** The preset fixes the number of cells, the aspect follows the chamber;
sizes are even and the chamber grows to a whole number of cells.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..lattice3d import CS_SMAGORINSKY
from .fluids import FLUID_RANGES, Fluid, FluidProperties, properties
from .planner import (
    BL_EXPONENT,
    BL_REFERENCE_HEIGHT,
    MACH_LIMIT,
    MOVING_FLOOR_GAP_CELLS,
    RAMP_MIN_STEPS,
    SIMILARITY_RATIO,
    SPONGE_DAMPING,
    SPONGE_FACTOR,
    SPONGE_FRACTION,
    U_LAT,
    U_LAT_MAX,
    Ground,
    PlanTexts,
    ReferenceKind,
    ReferenceLength,
    Resolution,
    _it,
    reynolds_text,
)

__all__ = ["CELLS_3D", "TAU_MIN_3D", "CasePlan3D", "CaseSetup3D", "plan3d"]

Point3 = tuple[float, float, float]
Box3 = tuple[float, float, float, float, float, float]

#: Cells per preset (SPEC §24.3: about 0.5, 1.5 and 4 million; to be fixed by
#: measuring on the Iris Xe). The aspect follows the chamber.
CELLS_3D: dict[str, int] = {"bozza": 500_000, "normale": 1_500_000, "fine": 4_000_000}
#: Smallest relaxation time of the 3D solver, with the subgrid model on, whatever
#: the floor. Measured on the GPU on 2026-10-20 (Normale, 30 000 steps a case): a
#: sphere, a cube, a box-shaped car over the moving floor (2 or 3 cells above it,
#: or standing on it) and a building on the fixed floor with the boundary-layer
#: inlet all hold at 0.5005; 0.502 keeps the 2D margin of 4. The building that
#: needs 0.504 in 2D holds here: the D3Q19 rates of d'Humières damp more.
TAU_MIN_3D = 0.502
UPSTREAM_3D = 1.5  # body lengths
DOWNSTREAM_3D = 3.0
#: Least margin around the body, as a fraction of its largest frontal size.
MARGIN_MIN = 0.5
GRID_MULTIPLE_3D = 2
GRID_MIN_3D = 16
GRID_MAX_3D = 2048


class CaseSetup3D(BaseModel):
    """A 3D case as the user chose it: physical units (SPEC §24.2)."""

    #: The model in the library (for the record, SPEC §2.3) and its name.
    model_id: str
    name: str
    #: Centre of the model's box, library coordinates: the rotations turn about it.
    pivot: Point3
    #: Extent of the model before the case's rotations (length x, width y, height z), m.
    model_size: Point3
    #: Box of the turned body relative to the pivot: (x0, y0, z0, x1, y1, z1), m.
    body_box: Box3
    #: Frontal area of the turned body, projected on the y–z plane, m².
    frontal_area_m2: float = Field(gt=0.0)
    yaw_deg: float = Field(default=0.0, ge=-180.0, le=180.0)
    pitch_deg: float = Field(default=0.0, ge=-90.0, le=90.0)
    fluid: Fluid = "aria"
    temperature_c: float = 20.0
    speed: float = Field(default=10.0, ge=0.1, le=120.0)
    ground: Ground = "none"
    inlet_profile: Literal["uniform", "boundary_layer"] = "uniform"
    resolution: Resolution = "normale"
    #: The length of the Reynolds number and of the convective time (SPEC §9.6),
    #: measured on the model before the case's rotations.
    reference_length: ReferenceLength = ReferenceLength(kind="frontal_height")
    #: The area of the coefficients; None = the frontal area (SPEC §24.2 #5).
    reference_area_m2: float | None = Field(default=None, gt=0.0)
    #: Area blockage the chamber is sized for (SPEC §24.3: 8%, 10% for vehicles).
    max_blockage: float = Field(default=0.08, gt=0.0, le=0.2)
    #: "Riprova con Re simulato più basso": each retry halves the simulated Re.
    re_sim_scale: float = Field(default=1.0, gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _checks(self) -> CaseSetup3D:
        lo, hi = FLUID_RANGES[self.fluid]
        if not lo <= self.temperature_c <= hi:
            name = "dell'aria" if self.fluid == "aria" else "dell'acqua"
            raise ValueError(f"la temperatura {name} va da {lo:g} a {hi:g} °C")
        if self.inlet_profile == "boundary_layer" and self.ground == "none":
            raise ValueError("lo strato limite in ingresso richiede un pavimento")
        x0, y0, z0, x1, y1, z1 = self.body_box
        if not (x1 > x0 and y1 > y0 and z1 > z0) or min(self.model_size) <= 0:
            raise ValueError("il modello ha dimensioni nulle")
        if self.frontal_area_m2 > (y1 - y0) * (z1 - z0) * (1 + 1e-6):
            raise ValueError("l'area frontale supera l'ingombro del modello")
        return self


class CasePlan3D(BaseModel):
    """A 3D case in lattice units, produced only by :func:`plan3d` (SPEC §24.3)."""

    nx: int
    ny: int
    nz: int
    #: Cell size, metres; time step, seconds.
    dx: float
    dt: float
    length_m: float
    width_m: float
    height_m: float
    #: Where the pivot sits in the chamber, metres.
    offset: Point3
    yaw_deg: float
    pitch_deg: float
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
    #: The area of the coefficients, m², and in cells².
    reference_area: float
    a_lat: float
    #: Frontal area over the chamber's cross-section.
    blockage: float
    #: What the measured coefficients are multiplied by to be those of the body
    #: in open air (SPEC §24.6): the continuity correction (1 − A/C)², with A the
    #: reference area (the voxels' frontal area once known) -- the flow passes a
    #: blocking body faster, at U / (1 − A/C).
    blockage_correction: float
    #: Convective time T_c = L_ref / V, in steps (SPEC §9.4 #6).
    tc_steps: float
    ramp_steps: int
    #: End of the start-up ramp + 3 T_c: averages begin here (SPEC §9.5).
    transient_steps: int
    #: Ceiling of a run: ramp + 20 T_c (SPEC §11.3).
    max_steps: int
    ground: Ground
    #: Least distance between the body and a moving floor, metres.
    floor_gap_m: float
    inlet_profile: Literal["uniform", "boundary_layer"]
    inlet_exponent: float
    #: Height where the boundary-layer inlet reaches the set speed, in cells.
    inlet_reference_cells: float
    sponge_start: int
    sponge_factor: float
    sponge_damping: float
    fluid: FluidProperties
    speed: float
    #: ½ ρ V², Pa; and the force that a coefficient of 1 means, N.
    dynamic_pressure: float
    force_per_coefficient: float
    #: GPU memory of the populations (two copies, float32), MB.
    memory_mb: float
    texts: PlanTexts


def _reference(setup: CaseSetup3D) -> float:
    if setup.reference_length.value_m is not None:
        return setup.reference_length.value_m
    length, width, height = setup.model_size
    kind = setup.reference_length.kind
    if kind in ("chord", "length_x", "custom"):
        return length
    return width if kind == "frontal_width" else height


def _round_cells(value: float) -> int:
    n = int(round(value / GRID_MULTIPLE_3D)) * GRID_MULTIPLE_3D
    return min(GRID_MAX_3D, max(GRID_MIN_3D, n))


def _grid(size: tuple[float, float, float], cells: int) -> tuple[int, int, int, float]:
    """Cells along x, y, z and the cell size for a chamber; iterated to a fixed point."""
    lx, ly, lz = size
    for _ in range(8):
        h = (lx * ly * lz / cells) ** (1 / 3)
        nx, ny, nz = (_round_cells(v / h) for v in (lx, ly, lz))
        dx = float(f"{max(lx / nx, ly / ny, lz / nz):.12g}")
        if all(math.isclose(n * dx, v, rel_tol=1e-12) for n, v in ((nx, lx), (ny, ly), (nz, lz))):
            break
        lx, ly, lz = nx * dx, ny * dx, nz * dx
    return nx, ny, nz, dx


def _margin(width: float, top: float, area: float, setup: CaseSetup3D) -> float:
    """The margin m around the body that brings the blockage down to ``max_blockage``.

    Without a floor the cross-section is (width + 2m)(height + 2m); with one,
    (width + 2m)(top + m), ``top`` being the body's top above the floor.
    """
    target = area / setup.max_blockage
    if setup.ground == "none":
        a, b, c = 4.0, 2.0 * (width + top), width * top - target
    else:
        a, b, c = 2.0, width + 2.0 * top, width * top - target
    return max(0.0, (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)) if c < 0 else 0.0


def plan3d(setup: CaseSetup3D) -> CasePlan3D:
    x0, y0, z0, x1, y1, z1 = setup.body_box
    length, width, tall = x1 - x0, y1 - y0, z1 - z0
    fluid = properties(setup.fluid, setup.temperature_c)
    speed = setup.speed

    # Height of the body's lowest point above the floor at its real height; a body
    # turned below the floor rests on it. Over the moving floor it stays the 2D's
    # 3 cells above (one cell went unstable within a second in 3D too; two held).
    lowest = setup.pivot[2] + z0
    floor_level = min(0.0, lowest)
    top = setup.pivot[2] + z1 - floor_level if setup.ground != "none" else tall
    margin = max(
        _margin(width, top, setup.frontal_area_m2, setup),
        MARGIN_MIN * max(width, tall),
    )
    size = (
        (UPSTREAM_3D + 1.0 + DOWNSTREAM_3D) * length,
        width + 2 * margin,
        tall + 2 * margin if setup.ground == "none" else top + margin,
    )
    nx, ny, nz, dx = _grid(size, CELLS_3D[setup.resolution])
    chamber = (nx * dx, ny * dx, nz * dx)

    floor_gap = MOVING_FLOOR_GAP_CELLS * dx if setup.ground == "moving" else 0.0
    ox = UPSTREAM_3D * length - x0
    oy = chamber[1] / 2 - (y0 + y1) / 2
    if setup.ground == "none":
        oz = chamber[2] / 2 - (z0 + z1) / 2
    else:
        lift = max(0.0, floor_gap - (lowest - floor_level))
        oz = setup.pivot[2] - floor_level + lift

    u_lat = U_LAT
    if setup.inlet_profile == "boundary_layer":
        # The power law grows with height: the ceiling may not exceed U_LAT_MAX.
        ceiling = (chamber[2] / BL_REFERENCE_HEIGHT) ** BL_EXPONENT
        u_lat = min(U_LAT, U_LAT_MAX / max(ceiling, 1.0))
    nu_lat = u_lat * fluid.kinematic_viscosity / (speed * dx)
    nu_lat = max(nu_lat, (TAU_MIN_3D - 0.5) / 3.0) / setup.re_sim_scale
    l_ref = _reference(setup)
    l_lat = l_ref / dx
    re_sim = u_lat * l_lat / nu_lat
    re_real = speed * l_ref / fluid.kinematic_viscosity
    tau = 3.0 * nu_lat + 0.5
    tc_steps = l_lat / u_lat
    ramp = max(RAMP_MIN_STEPS, int(math.ceil(0.5 * tc_steps)))
    area = setup.reference_area_m2 or setup.frontal_area_m2
    mach = speed / fluid.speed_of_sound
    partial = re_sim < SIMILARITY_RATIO * re_real
    cells = nx * ny * nz
    if dx < 0.01:
        cell_text = f"{_it(dx * 1000, 1)} mm"
    elif dx < 1:
        cell_text = f"{_it(dx * 100, 1)} cm"
    else:
        cell_text = f"{_it(dx, 2)} m"

    texts = PlanTexts(
        reynolds=(
            f"Re reale {reynolds_text(re_real)} — Re simulato {reynolds_text(re_sim)}"
            if partial
            else f"Re {reynolds_text(re_real)}"
        ),
        mach=f"Mach {_it(mach, 3)}",
        grid=f"{nx} × {ny} × {nz} celle da {cell_text}",
    )
    return CasePlan3D(
        nx=nx,
        ny=ny,
        nz=nz,
        dx=dx,
        dt=dx * u_lat / speed,
        length_m=chamber[0],
        width_m=chamber[1],
        height_m=chamber[2],
        offset=(ox, oy, oz),
        yaw_deg=setup.yaw_deg,
        pitch_deg=setup.pitch_deg,
        u_lat=u_lat,
        tau=tau,
        nu_lat=nu_lat,
        tau_min=TAU_MIN_3D,
        smagorinsky_cs=CS_SMAGORINSKY,
        re_real=re_real,
        re_sim=re_sim,
        partial_similarity=partial,
        mach=mach,
        mach_warning=mach > MACH_LIMIT,
        reference_kind=setup.reference_length.kind,
        reference_length=l_ref,
        l_lat=l_lat,
        reference_area=area,
        a_lat=area / dx**2,
        blockage=setup.frontal_area_m2 / (chamber[1] * chamber[2]),
        blockage_correction=(1.0 - min(area / (chamber[1] * chamber[2]), 0.5)) ** 2,
        tc_steps=tc_steps,
        ramp_steps=ramp,
        transient_steps=ramp + int(math.ceil(3 * tc_steps)),
        max_steps=ramp + int(math.ceil(20 * tc_steps)),
        ground=setup.ground,
        floor_gap_m=floor_gap,
        inlet_profile=setup.inlet_profile,
        inlet_exponent=BL_EXPONENT,
        inlet_reference_cells=BL_REFERENCE_HEIGHT / dx,
        sponge_start=int(round(nx * (1 - SPONGE_FRACTION))),
        sponge_factor=SPONGE_FACTOR,
        sponge_damping=SPONGE_DAMPING,
        fluid=fluid,
        speed=speed,
        dynamic_pressure=0.5 * fluid.density * speed**2,
        force_per_coefficient=0.5 * fluid.density * speed**2 * area,
        memory_mb=2 * 19 * 4 * cells / 1e6,
        texts=texts,
    )
