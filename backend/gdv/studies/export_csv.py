# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""CSV exports (SPEC §11.5): coefficient history, Cp along the contour, series points.

Every file opens with ``#`` comment lines carrying the conditions (SPEC §2.3).
The default is what an Italian spreadsheet reads: ``;`` between columns and a
decimal comma; with ``,`` between columns the decimals take a point.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Literal

import numpy as np

from .conditions import STATUS_TEXT, conditions_lines
from .result import Study

__all__ = ["Separator", "history_csv", "contour_csv", "series_csv"]

Separator = Literal[";", ","]

_PARAMETER = {
    "angle": "incidenza_gradi",
    "speed": "velocita_m_s",
    "depth": "profondita_frazione",
}


def _cell(value: object, sep: Separator) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, (float, np.floating)):
        text = f"{float(value):.7g}"
        return text.replace(".", ",") if sep == ";" else text
    text = str(value)
    return f'"{text}"' if sep in text or '"' in text else text


def _write(
    header: Iterable[str], columns: Sequence[str], rows: Iterable[Sequence[object]], sep: Separator
) -> bytes:
    out = [f"# {line}" for line in header]
    out.append(sep.join(columns))
    out += [sep.join(_cell(v, sep) for v in row) for row in rows]
    # A BOM, so that spreadsheets read the accents right.
    return ("﻿" + "\r\n".join(out) + "\r\n").encode("utf-8")


def history_csv(study: Study, k: int, history: dict[str, np.ndarray], sep: Separator) -> bytes:
    """Cd, Cl, Cm per sample; for a 3D result Cd, Cl, Cs, corrected for the blockage."""
    result = study.points[k].result
    dt = result.plan.dt
    last = "cs" if "cs" in history else "cm"
    rows = zip(
        history["step"].tolist(),
        (history["step"] * dt).tolist(),
        history["cd"].tolist(),
        history["cl"].tolist(),
        history[last].tolist(),
        strict=True,
    )
    columns = ["passo", "tempo_s", "Cd", "Cl", last.capitalize()]
    return _write(conditions_lines(study, result), columns, rows, sep)


def contour_csv(study: Study, k: int, contour: dict[str, np.ndarray], sep: Separator) -> bytes:
    result = study.points[k].result
    order = np.argsort(contour["s"])
    rows = (
        (
            float(contour["xc"][i]),
            float(contour["s"][i]),
            "dorso" if contour["upper"][i] else "ventre",
            float(contour["cp"][i]),
        )
        for i in order
    )
    header = conditions_lines(study, result) + [
        "Cp medio nel tempo sulle celle fluide a contatto del corpo; s = arco dal bordo "
        "d'uscita in senso antiorario, frazione del perimetro"
    ]
    return _write(header, ["x_c", "s", "superficie", "Cp"], rows, sep)


def series_csv(study: Study, sep: Separator) -> bytes:
    if study.series is None or not study.points:
        raise ValueError("lo studio non è una serie con punti")
    parameter = study.series.parameter
    columns = [_PARAMETER[parameter]]
    if parameter == "depth":
        columns.append("profondita_m")
    columns += [
        "Re_reale", "Re_simulato", "stato", "Cd", "Cd_dev", "Cl", "Cl_dev", "Cm", "Cm_dev",
        "Cl_Cd", "St", "resistenza_N_m", "portanza_N_m", "momento_Nm_m", "L_ref_m", "passi",
    ]  # fmt: skip
    rows = []
    for point in study.points:
        r = point.result
        c = r.coefficients
        f = r.forces_real
        source = r.case.profile.source
        row: list[object] = [point.value]
        if parameter == "depth":
            row.append(getattr(source, "depth_m", None))
        row += [
            r.plan.re_real, r.plan.re_sim, STATUS_TEXT[r.status],
            c.cd.mean if c.cd else None, c.cd.std if c.cd else None,
            c.cl.mean if c.cl else None, c.cl.std if c.cl else None,
            c.cm.mean if c.cm else None, c.cm.std if c.cm else None,
            c.clcd, c.strouhal, f.drag, f.lift, f.moment, r.plan.reference_length, point.steps,
        ]  # fmt: skip
        rows.append(row)
    header = conditions_lines(study, study.points[0].result)
    header[-3:-3] = [
        f"Serie di {len(study.points)} punti su {len(study.series.values)} previsti; "
        "condizioni del primo punto, Re e lunghezza di riferimento di ogni punto nelle colonne"
    ]
    if parameter == "depth":
        header.append(
            "Coefficienti di sezioni 2D indipendenti: non sono una distribuzione 3D lungo l'oggetto"
        )
    return _write(header, columns, rows, sep)
