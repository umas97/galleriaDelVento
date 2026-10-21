# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Comparing up to four studies (SPEC §11.4): the table of coefficients.

Each row gives a study's numbers, their difference in % from the first study,
and the conditions; a row whose simulated Reynolds number or reference length
differs from the first says so -- the coefficients are then not directly
comparable (SPEC §2.3). A series takes part with its first point; its curves
are compared on the page.

Studies of the 3D tunnel (SPEC §24.2 #7) compare with each other: Cd, Cl and
the side force Cs of the whole body, on their reference areas, which must
agree too. A 2D study next to a 3D one is never comparable: a section's
coefficient per metre of depth and a whole body's are different things.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from ..physics.planner import ReferenceKind
from .result import SimulationResult3D, Study

__all__ = ["MAX_COMPARED", "Comparison", "CompareRow", "compare"]

MAX_COMPARED = 4
#: Simulated Reynolds numbers this close count as the same.
RE_TOLERANCE = 0.02
#: Reference lengths this close count as the same.
LENGTH_TOLERANCE = 1e-3
#: Below this a coefficient is about zero: a difference in % from it says nothing.
SMALL_COEFFICIENT = 1e-3
NOT_COMPARABLE = "i coefficienti non sono direttamente confrontabili"

Coefficient = Literal["cd", "cl", "cm", "clcd", "st", "cs"]


class CompareRow(BaseModel):
    study_id: str
    name: str
    dimension: Literal["2d", "3d"]
    kind: Literal["single", "series"]
    points: int
    status: Literal["converged", "provisional", "unstable"] | None
    reynolds: str
    re_real: float | None
    re_sim: float | None
    reference_kind: ReferenceKind | None
    reference_length: float | None
    grid: str
    #: 2D: the incidence; 3D: the yaw and the pitch.
    angle_deg: float | None
    yaw_deg: float | None
    pitch_deg: float | None
    #: 3D: the area of the coefficients, m².
    reference_area: float | None
    speed: float | None
    values: dict[Coefficient, float | None]
    #: Difference from the first study, in % of its value (None where undefined).
    diff: dict[Coefficient, float | None]
    comparable: bool
    reasons: list[str]


class Comparison(BaseModel):
    rows: list[CompareRow]
    comparable: bool
    warning: str | None


def _differs(a: float, b: float, tolerance: float) -> bool:
    return abs(a - b) > tolerance * max(abs(a), abs(b), 1e-300)


def compare(studies: list[Study]) -> Comparison:
    if not 1 <= len(studies) <= MAX_COMPARED:
        raise ValueError(f"si confrontano da 1 a {MAX_COMPARED} studi")
    rows: list[CompareRow] = []
    first_values: dict[Coefficient, float | None] = {}
    first = None
    for index, study in enumerate(studies):
        point = study.points[0] if study.points else None
        result = point.result if point else None
        three = isinstance(result, SimulationResult3D)
        values: dict[Coefficient, float | None] = dict.fromkeys(
            ("cd", "cl", "cm", "clcd", "st", "cs"), None
        )
        if isinstance(result, SimulationResult3D):
            c3 = result.coefficients
            values.update(
                cd=c3.cd.mean if c3.cd else None,
                cl=c3.cl.mean if c3.cl else None,
                cs=c3.cs.mean if c3.cs else None,
            )
        elif result is not None:
            c = result.coefficients
            values.update(
                cd=c.cd.mean if c.cd else None,
                cl=c.cl.mean if c.cl else None,
                cm=c.cm.mean if c.cm else None,
                clcd=c.clcd,
                st=c.strouhal,
            )
        reasons: list[str] = []
        if index == 0:
            first, first_values = result, values
        elif result is None or first is None:
            reasons.append("nessun risultato da confrontare")
        elif result.dimension != first.dimension:
            reasons.append("uno studio 2D e uno 3D: coefficienti di natura diversa")
        else:
            if (
                isinstance(result, SimulationResult3D)
                and isinstance(first, SimulationResult3D)
                and _differs(result.plan.reference_area, first.plan.reference_area, RE_TOLERANCE)
            ):
                reasons.append("area di riferimento diversa dal primo studio")
            if _differs(result.plan.re_sim, first.plan.re_sim, RE_TOLERANCE):
                reasons.append("Re simulato diverso dal primo studio")
            if result.plan.reference_kind != first.plan.reference_kind or _differs(
                result.plan.reference_length, first.plan.reference_length, LENGTH_TOLERANCE
            ):
                reasons.append("lunghezza di riferimento diversa dal primo studio")
        diff: dict[Coefficient, float | None] = {}
        for key, value in values.items():
            base = first_values.get(key)
            diff[key] = (
                100.0 * (value - base) / abs(base)
                if value is not None and base is not None and abs(base) > SMALL_COEFFICIENT
                else None
            )
        rows.append(
            CompareRow(
                study_id=study.id,
                name=study.name,
                dimension=result.dimension if result else "2d",
                kind=study.kind,
                points=len(study.points),
                status=result.status if result else None,
                reynolds=result.plan.texts.reynolds if result else "",
                re_real=result.plan.re_real if result else None,
                re_sim=result.plan.re_sim if result else None,
                reference_kind=result.plan.reference_kind if result else None,
                reference_length=result.plan.reference_length if result else None,
                grid=result.plan.texts.grid if result else "",
                angle_deg=None if three or result is None else result.case.angle_deg,
                yaw_deg=result.case.yaw_deg if isinstance(result, SimulationResult3D) else None,
                pitch_deg=result.case.pitch_deg if isinstance(result, SimulationResult3D) else None,
                reference_area=(
                    result.plan.reference_area if isinstance(result, SimulationResult3D) else None
                ),
                speed=result.case.speed if result else None,
                values=values,
                diff=diff,
                comparable=not reasons,
                reasons=reasons,
            )
        )
    comparable = all(r.comparable for r in rows)
    warning = None if comparable else NOT_COMPARABLE
    return Comparison(rows=rows, comparable=comparable, warning=warning)
