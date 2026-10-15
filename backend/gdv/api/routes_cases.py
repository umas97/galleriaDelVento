# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The planner over HTTP: ``POST /api/cases/plan`` (SPEC §9.4).

Every plan is logged with its setup (SPEC §15), without the profile's points:
they would drown the log and say nothing the name does not.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from ..physics.planner import CasePlan, CaseSetup, plan

__all__ = ["router"]

router = APIRouter(prefix="/api", tags=["cases"])

_log = logging.getLogger(__name__)


@router.post("/cases/plan")
def plan_case(setup: CaseSetup) -> CasePlan:
    result = plan(setup)
    summary = setup.model_dump(exclude={"profile"})
    _log.info(
        "caso pianificato: «%s» %s → %d×%d, dx=%.4g m, tau=%.5f, Re reale %.3g, Re sim %.3g%s",
        setup.profile.name,
        summary,
        result.nx,
        result.ny,
        result.dx,
        result.tau,
        result.re_real,
        result.re_sim,
        " (camera ridimensionata)" if result.resized else "",
    )
    return result
