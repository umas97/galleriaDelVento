# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""From coefficients to real forces, per metre of depth (SPEC §9.5).

The GPU measures lattice forces and the interface turns them into
coefficients with the measured undisturbed density; what a coefficient means
in newtons depends only on the plan: ``F' = ½ ρ V² · L_ref · C`` (N/m), and
for the pitching moment one more ``L_ref`` (N·m/m). The backend computes the
real forces of a saved result itself, so a file never holds forces that
disagree with its coefficients.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .planner import CasePlan

__all__ = ["Coefficients", "Forces", "Stat", "real_forces"]


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
