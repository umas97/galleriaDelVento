# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""DXF drawings into loops (SPEC §7.4).

From the model space: ``LWPOLYLINE``, ``POLYLINE``, ``LINE``, ``ARC``,
``CIRCLE``, ``ELLIPSE`` and ``SPLINE``; block references are exploded (nested
ones too); entities on layers that are off or frozen, texts and dimensions are
ignored. Loose pieces are chained by coincident endpoints (1e-6 of the
drawing's size). Units come from ``$INSUNITS`` when the file sets them.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from typing import Any

import numpy as np

from ..errors import AppError
from .drawing import Drawing
from .polylines import chain

__all__ = ["INSUNITS", "parse_dxf"]

#: $INSUNITS code -> (name, metres per unit). 0 means "unitless": ask the user.
INSUNITS: dict[int, tuple[str, float]] = {
    1: ("in", 0.0254),
    2: ("ft", 0.3048),
    4: ("mm", 1e-3),
    5: ("cm", 1e-2),
    6: ("m", 1.0),
    7: ("km", 1e3),
    14: ("dm", 0.1),
}
CURVES = {"LWPOLYLINE", "POLYLINE", "LINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}
FLATTEN_FRACTION = 5e-4
JOIN_FRACTION = 1e-6
MAX_BLOCK_DEPTH = 8


def _not_dxf(technical: str) -> AppError:
    return AppError("Il file non sembra un DXF valido", technical, status=422)


def _visible_curves(doc: Any, entities: Any, depth: int = 0) -> Iterator[Any]:
    for entity in entities:
        layer = doc.layers.get(entity.dxf.get("layer", "0"))
        if layer is not None and (layer.is_off() or layer.is_frozen()):
            continue
        kind = entity.dxftype()
        if kind == "INSERT" and depth < MAX_BLOCK_DEPTH:
            yield from _visible_curves(doc, entity.virtual_entities(), depth + 1)
        elif kind in CURVES:
            yield entity


def parse_dxf(data: bytes) -> Drawing:
    from ezdxf import recover
    from ezdxf.path import make_path

    try:
        doc, _auditor = recover.read(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - any reader failure is "not a DXF"
        raise _not_dxf(f"{type(exc).__name__}: {exc}") from exc

    paths = []
    for entity in _visible_curves(doc, doc.modelspace()):
        try:
            path = make_path(entity)
        except (TypeError, ValueError):
            continue
        if len(path) or path.has_curves:
            paths.append(path)
    vertices = [np.array([(v.x, v.y) for v in p.control_vertices()]) for p in paths]
    vertices = [v for v in vertices if len(v)]
    if not vertices:
        raise AppError("Il disegno non contiene forme", "nessuna entità geometrica", status=422)
    allv = np.concatenate(vertices)
    size = float(max(allv.max(axis=0) - allv.min(axis=0)))
    if not size > 0:
        raise AppError("Il disegno non contiene forme", "estensione nulla", status=422)

    pieces = []
    for path in paths:
        points = np.array([(v.x, v.y) for v in path.flattening(FLATTEN_FRACTION * size)])
        if len(points) >= 2:
            pieces.append(points)
    loops, open_left = chain(pieces, JOIN_FRACTION * size)

    code = int(doc.header.get("$INSUNITS", 0) or 0)
    name, metres = INSUNITS.get(code, (None, None))
    return Drawing(
        format="dxf",
        loops=loops,
        open_discarded=len(open_left),
        units=name,
        metres_per_unit=metres,
        size=size,
    )
