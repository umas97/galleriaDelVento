# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""From coefficients to real forces: per metre of depth in 2D (SPEC §9.5), on
the whole body in 3D (SPEC §24.2 #5).

The GPU measures lattice forces and the interface turns them into
coefficients with the measured undisturbed density; what a coefficient means
in newtons depends only on the plan: ``F' = ½ ρ V² · L_ref · C`` (N/m), and
for the pitching moment one more ``L_ref`` (N·m/m). The backend computes the
real forces of a saved result itself, so a file never holds forces that
disagree with its coefficients.

In 3D the coefficients are on the reference area (the voxels' frontal area)
and corrected for the chamber's blockage, as the plan says (SPEC §24.6):
those of the body in open air; the forces in N follow from them,
``F = ½ ρ V² · A_ref · C``. The coefficient measured in the chamber is kept
next to the corrected Cd.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .planner import CasePlan
from .planner3d import CasePlan3D

__all__ = [
    "Coefficients",
    "Coefficients3D",
    "Forces",
    "Forces3D",
    "Stat",
    "real_forces",
    "real_forces3d",
]


class Stat(BaseModel):
    """Mean and standard deviation over the averaging window."""

    model_config = ConfigDict(allow_inf_nan=False)

    mean: float
    std: float


class Coefficients(BaseModel):
    """What the averaging window gave (SPEC §9.5). Null where there is no number yet."""

    model_config = ConfigDict(allow_inf_nan=False)

    cd: Stat | None
    cl: Stat | None
    #: Pitching moment about the plan's moment point, positive nose up.
    cm: Stat | None
    clcd: float | None
    strouhal: float | None
    regime: Literal["steady", "periodic"] | None
    #: Relative change of the mean Cd between the last two windows (or groups).
    change: float | None
    #: Steps averaged (negative while waiting for the transient to end).
    averaged_steps: int
    #: Measured undisturbed density, lattice units (the normalisation).
    rho_inf: float


class Forces(BaseModel):
    """Real forces per metre of depth (SPEC §2.3): drag and lift in N/m, moment in N·m/m."""

    model_config = ConfigDict(allow_inf_nan=False)

    drag: float | None
    lift: float | None
    moment: float | None
    unit: Literal["N/m"] = "N/m"


def real_forces(coefficients: Coefficients, plan: CasePlan) -> Forces:
    per = plan.force_per_coefficient
    c = coefficients
    return Forces(
        drag=c.cd.mean * per if c.cd else None,
        lift=c.cl.mean * per if c.cl else None,
        moment=c.cm.mean * per * plan.reference_length if c.cm else None,
    )


class Coefficients3D(BaseModel):
    """The whole body's numbers (SPEC §24.2 #5): drag along x, lift along +z, side
    force along +y, corrected for the blockage; null where there is no number yet."""

    model_config = ConfigDict(allow_inf_nan=False)

    cd: Stat | None
    cl: Stat | None
    cs: Stat | None
    #: Cd as measured in the chamber, before the blockage correction.
    cd_measured: Stat | None
    #: The factor applied, (1 − A/C)² (the plan's).
    blockage_correction: float
    regime: Literal["steady", "periodic"] | None
    change: float | None
    averaged_steps: int
    rho_inf: float


class Forces3D(BaseModel):
    """Real forces on the whole body (SPEC §2.3), N: in open air, from the corrected
    coefficients."""

    model_config = ConfigDict(allow_inf_nan=False)

    drag: float | None
    lift: float | None
    side: float | None
    unit: Literal["N"] = "N"


def real_forces3d(coefficients: Coefficients3D, plan: CasePlan3D) -> Forces3D:
    per = plan.force_per_coefficient
    c = coefficients
    return Forces3D(
        drag=c.cd.mean * per if c.cd else None,
        lift=c.cl.mean * per if c.cl else None,
        side=c.cs.mean * per if c.cs else None,
    )
