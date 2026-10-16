# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The conditions of a result as Italian lines (SPEC §2.3), for every file that
leaves the program: CSV comments, the VTK header. No number without them."""

from __future__ import annotations

from ..geometry.profile import EditorSource, Section3DSource
from ..physics.planner import reynolds_text
from .result import SimulationResult, Study

__all__ = ["STATUS_TEXT", "conditions_lines", "it_number", "section_text"]

STATUS_TEXT = {"converged": "convergente", "provisional": "provvisorio", "unstable": "non valido"}
_FLUID = {"aria": "aria", "acqua": "acqua"}
_GROUND = {"none": "nessuno", "fixed": "fisso", "moving": "mobile"}
_REFERENCE = {
    "chord": "corda",
    "length_x": "lunghezza lungo x",
    "frontal_height": "altezza frontale",
    "frontal_width": "larghezza frontale",
    "height": "altezza",
    "custom": "personalizzata",
}


def it_number(value: float, digits: int = 4) -> str:
    """A number with ``digits`` significant digits and a decimal comma."""
    return f"{value:.{digits}g}".replace(".", ",")


def section_text(result: SimulationResult) -> str | None:
    """Where a model's section was cut (SPEC §2.3), or None for other profiles."""
    source = result.case.profile.source
    if isinstance(source, EditorSource):
        source = source.origin
    if not isinstance(source, Section3DSource):
        return None
    plane = "verticale" if source.plane == "vertical" else "orizzontale"
    return (
        f"Sezione {plane} del modello «{source.model_name}» a profondità "
        f"{it_number(source.depth_m)} m ({it_number(source.depth_fraction * 100, 3)}%), "
        f"rollio {it_number(source.roll_deg, 3)}°, beccheggio {it_number(source.tilt_deg, 3)}°"
    )


def conditions_lines(study: Study, result: SimulationResult) -> list[str]:
    case, plan = result.case, result.plan
    lines = [
        f"galleriaDelVento {result.app_version} — studio «{study.name}»",
        f"Profilo: «{case.profile.name}»",
    ]
    section = section_text(result)
    if section:
        lines.append(section)
        lines.append(
            "Sezione 2D: si comporta come un oggetto infinitamente esteso nella profondità; "
            "i coefficienti non sono quelli dell'oggetto 3D intero"
        )
    lines += [
        f"Fluido: {_FLUID[case.fluid]} a {it_number(case.temperature_c, 3)} °C; "
        f"velocità {it_number(case.speed)} m/s; incidenza {it_number(case.angle_deg, 3)}°; "
        f"pavimento {_GROUND[case.ground]}",
        f"Re reale {reynolds_text(plan.re_real)}; Re simulato {reynolds_text(plan.re_sim)}"
        + ("; similitudine parziale" if plan.partial_similarity else ""),
        f"Lunghezza di riferimento: {_REFERENCE[plan.reference_kind]} "
        f"{it_number(plan.reference_length)} m",
        f"Griglia: {plan.texts.grid}; tau {it_number(plan.tau, 5)}; "
        f"camera {it_number(plan.width_m)} × {it_number(plan.height_m)} m",
        f"Stato: {STATUS_TEXT[result.status]}",
        "Forze per metro di profondità (N/m)",
    ]
    if plan.mach_warning:
        lines.append("Oltre Mach 0,3: la comprimibilità non è considerata")
    return lines
