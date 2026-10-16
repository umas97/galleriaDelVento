# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Comparing up to four studies (SPEC §11.4): the table of coefficients.

Each row gives a study's numbers, their difference in % from the first study,
and the conditions; a row whose simulated Reynolds number or reference length
differs from the first says so -- the coefficients are then not directly
comparable (SPEC §2.3). A series takes part with its first point; its curves
are compared on the page.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from ..physics.planner import ReferenceKind
from .result import Study

__all__ = ["MAX_COMPARED", "Comparison", "CompareRow", "compare"]

MAX_COMPARED = 4
#: Simulated Reynolds numbers this close count as the same.
RE_TOLERANCE = 0.02
#: Reference lengths this close count as the same.
LENGTH_TOLERANCE = 1e-3
#: Below this a coefficient is about zero: a difference in % from it says nothing.
SMALL_COEFFICIENT = 1e-3
NOT_COMPARABLE = "i coefficienti non sono direttamente confrontabili"

Coefficient = Literal["cd", "cl", "cm", "clcd", "st"]


class CompareRow(BaseModel):
    study_id: str
    name: str
    kind: Literal["single", "series"]
    points: int
    status: Literal["converged", "provisional", "unstable"] | None
    reynolds: str
    re_real: float | None
    re_sim: float | None
    reference_kind: ReferenceKind | None
    reference_length: float | None
    grid: str
    angle_deg: float | None
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
        c = result.coefficients if result else None
        values: dict[Coefficient, float | None] = {
            "cd": c.cd.mean if c and c.cd else None,
            "cl": c.cl.mean if c and c.cl else None,
            "cm": c.cm.mean if c and c.cm else None,
            "clcd": c.clcd if c else None,
            "st": c.strouhal if c else None,
        }
        reasons: list[str] = []
        if index == 0:
            first, first_values = result, values
        elif result is None or first is None:
            reasons.append("nessun risultato da confrontare")
        else:
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
                kind=study.kind,
                points=len(study.points),
                status=result.status if result else None,
                reynolds=result.plan.texts.reynolds if result else "",
                re_real=result.plan.re_real if result else None,
                re_sim=result.plan.re_sim if result else None,
                reference_kind=result.plan.reference_kind if result else None,
                reference_length=result.plan.reference_length if result else None,
                grid=result.plan.texts.grid if result else "",
                angle_deg=result.case.angle_deg if result else None,
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
