# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 11: SVG and DXF import, and export plus re-import (SPEC §7.3, §7.4, §11.5).

Every drawing is written here, in code. Expected areas and perimeters come from
the shapes' definitions (or, for free curves, from sampling them densely),
never from the importer itself.
"""

from __future__ import annotations

import io
import math

import numpy as np
import pytest

from gdv.errors import AppError
from gdv.geometry.drawing import to_draft
from gdv.geometry.dxf_import import parse_dxf
from gdv.geometry.profile import EditorSource, normalise, signed_area, validate
from gdv.geometry.profile_export import to_dxf, to_svg
from gdv.geometry.svg_import import parse_svg
from synthetic import naca4

TOL = 0.005  # 0.5% (SPEC §18, test 11)


def perimeter(points: np.ndarray) -> float:
    return float(np.hypot(*(np.roll(points, -1, axis=0) - points).T).sum())


def by_centre(loops: list[np.ndarray], centre: tuple[float, float]) -> np.ndarray:
    return min(loops, key=lambda p: float(np.hypot(*(p.mean(axis=0) - centre))))


def svg(body: str, size: str = 'width="200mm" height="100mm" viewBox="0 0 200 100"') -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" {size}>{body}</svg>'.encode()


# --- SVG ---------------------------------------------------------------------------


def cubic(p0, p1, p2, p3, t):
    t = t[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def quad(p0, p1, p2, t):
    t = t[:, None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t**2 * p2


def curved_reference() -> np.ndarray:
    """The path "M 0 0 L 40 0 C 50 0 50 30 40 30 L 0 30 Q -10 15 0 0 Z", sampled densely."""
    t = np.linspace(0, 1, 20001)[1:]
    a = np.array
    return np.concatenate(
        [
            a([[0.0, 0.0]]),
            a([[40.0, 0.0]]),
            cubic(a([40.0, 0]), a([50.0, 0]), a([50.0, 30]), a([40.0, 30]), t),
            a([[0.0, 30.0]]),
            quad(a([0.0, 30]), a([-10.0, 15]), a([0.0, 0]), t)[:-1],
        ]
    )


def in_mm(drawing) -> list[np.ndarray]:
    assert drawing.units == "mm"
    return [p * drawing.metres_per_unit * 1000 for p in drawing.loops]


# One shape per file: the flattening tolerance is relative to the whole drawing
# (SPEC §7.3), so a shape much smaller than its drawing is measured coarser.


def test_svg_rect_with_transforms():
    body = (
        '<g transform="translate(20,20)"><rect width="20" height="10" transform="rotate(30)"/></g>'
    )
    (rect,) = in_mm(parse_svg(svg(body)))
    assert abs(signed_area(rect)) == pytest.approx(200, rel=TOL)
    assert perimeter(rect) == pytest.approx(60, rel=TOL)
    # Turned by 30° about the drawing origin, then moved by (20, 20); y flipped.
    assert rect.mean(axis=0) == pytest.approx((26.16, -29.33), abs=0.01)


def test_svg_circle():
    (circle,) = in_mm(parse_svg(svg('<circle cx="80" cy="50" r="10"/>')))
    assert abs(signed_area(circle)) == pytest.approx(math.pi * 100, rel=TOL)
    assert perimeter(circle) == pytest.approx(2 * math.pi * 10, rel=TOL)


def test_svg_path_with_curves():
    body = '<path d="M 0 0 L 40 0 C 50 0 50 30 40 30 L 0 30 Q -10 15 0 0 Z"/>'
    (curved,) = in_mm(parse_svg(svg(body)))
    ref = curved_reference()
    assert abs(signed_area(curved)) == pytest.approx(abs(signed_area(ref)), rel=TOL)
    assert perimeter(curved) == pytest.approx(perimeter(ref), rel=TOL)


def test_svg_shapes_together_are_separate_loops():
    body = (
        '<rect x="0" y="0" width="20" height="10"/><circle cx="80" cy="50" r="10"/>'
        '<path transform="translate(120,30)" d="M 0 0 L 40 0 C 50 0 50 30 40 30 Z"/>'
    )
    drawing = parse_svg(svg(body))
    assert len(drawing.loops) == 3 and drawing.open_discarded == 0


def test_svg_y_axis_is_flipped():
    (rect,) = in_mm(parse_svg(svg('<rect x="10" y="10" width="20" height="5"/>')))
    ys = rect[:, 1]
    assert ys.max() == pytest.approx(-10) and ys.min() == pytest.approx(-15)


def test_svg_without_physical_units_asks_for_the_scale():
    drawing = parse_svg(svg('<rect width="20" height="10"/>', size='viewBox="0 0 100 100"'))
    assert drawing.units is None and drawing.metres_per_unit is None
    drawing = parse_svg(svg('<rect width="20" height="10"/>', size='width="300px"'))
    assert drawing.metres_per_unit is None


def test_open_strokes_close_below_half_a_percent_and_are_counted_otherwise():
    # Drawing size 200: 0.5% is 1 unit.
    body = (
        '<rect x="0" y="0" width="200" height="1" fill="none"/>'
        '<path d="M 10 10 L 50 10 L 50 50 L 10 50 L 10 10.6"/>'  # gap 0.6 -> closed
        '<polyline points="100,10 140,10 140,50 100,50 100,12"/>'  # gap 2 -> discarded
        '<line x1="0" y1="90" x2="10" y2="90"/>'  # ignored
    )
    drawing = parse_svg(svg(body))
    assert len(drawing.loops) == 2
    assert drawing.open_discarded == 1


def test_svg_polygon_ellipse_and_subpaths():
    body = (
        '<polygon points="0,0 30,0 30,30"/>'
        '<ellipse cx="100" cy="50" rx="20" ry="10"/>'
        '<path d="M 150 10 h 20 v 20 h -20 z M 155 15 v 10 h 10 v -10 z"/>'
    )
    areas = sorted(abs(signed_area(p)) for p in in_mm(parse_svg(svg(body))))
    assert areas == pytest.approx(sorted([450, math.pi * 200, 400, 100]), rel=TOL)


def test_not_an_svg():
    with pytest.raises(AppError) as info:
        parse_svg(b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='0'/>")
    assert info.value.status == 422


# --- DXF ---------------------------------------------------------------------------


def dxf_bytes(build, units: int = 4) -> bytes:
    import ezdxf

    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = units  # ezdxf.new() would say metres
    build(doc, doc.modelspace())
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue().encode()


def test_dxf_loose_pieces_are_chained_and_measured():
    def build(doc, msp):
        # A "D": straight bottom, a half circle of radius 15 on the right, top and left.
        msp.add_lwpolyline([(0, 0), (40, 0)])
        msp.add_arc((40, 15), 15, -90, 90)
        msp.add_line((40, 30), (0, 30))
        msp.add_line((0, 30), (0, 0))
        # A closed spline through 64 points of an ellipse, a = 12, b = 6.
        t = np.linspace(0, 2 * np.pi, 65)
        fit = [(100 + 12 * math.cos(a), 15 + 6 * math.sin(a)) for a in t]
        msp.add_spline(fit_points=fit)

    drawing = parse_dxf(dxf_bytes(build))
    assert drawing.units == "mm" and drawing.metres_per_unit == 1e-3
    assert drawing.open_discarded == 0 and len(drawing.loops) == 2
    d = by_centre(drawing.loops, (25, 15))
    assert abs(signed_area(d)) == pytest.approx(40 * 30 + math.pi * 15**2 / 2, rel=TOL)
    assert perimeter(d) == pytest.approx(110 + math.pi * 15, rel=TOL)
    ellipse = by_centre(drawing.loops, (100, 15))
    assert abs(signed_area(ellipse)) == pytest.approx(math.pi * 12 * 6, rel=TOL)


def test_dxf_blocks_are_exploded_and_hidden_layers_ignored():
    def build(doc, msp):
        block = doc.blocks.new("RUOTA")
        block.add_circle((0, 0), 5)
        msp.add_blockref("RUOTA", (20, 0))
        msp.add_blockref("RUOTA", (60, 0))
        doc.layers.add("SPENTO").off()
        doc.layers.add("CONGELATO").freeze()
        msp.add_circle((100, 0), 5, dxfattribs={"layer": "SPENTO"})
        msp.add_circle((120, 0), 5, dxfattribs={"layer": "CONGELATO"})
        msp.add_text("quota", dxfattribs={"insert": (0, 20)})
        msp.add_lwpolyline([(0, 30), (10, 30), (10, 40)])  # open: discarded

    drawing = parse_dxf(dxf_bytes(build, units=0))
    assert drawing.units is None and drawing.metres_per_unit is None
    centres = sorted(round(float(p.mean(axis=0)[0])) for p in drawing.loops)
    assert centres == [20, 60]
    assert drawing.open_discarded == 1


def test_not_a_dxf():
    with pytest.raises(AppError):
        parse_dxf(b"0\nSECTION\n2\nNONSENSE\n")


# --- export and re-import ------------------------------------------------------------


def profile_with_hole():
    from gdv.geometry.profile import from_arrays

    outer = naca4("2412", 80, 0.8)
    hole = np.array([[0.2, 0.0], [0.3, 0.0], [0.3, 0.02], [0.2, 0.02]])[::-1]
    return normalise(from_arrays([outer, hole], name="Ala àccentata", source=EditorSource()))


@pytest.mark.parametrize("fmt", ["dxf", "svg"])
def test_export_and_reimport_give_the_same_profile(fmt):
    original = profile_with_hole()
    data = to_dxf(original) if fmt == "dxf" else to_svg(original)
    drawing = parse_dxf(data) if fmt == "dxf" else parse_svg(data)
    assert drawing.metres_per_unit is not None
    again = normalise(
        to_draft(drawing, scale=drawing.metres_per_unit, name="x", sha256="0" * 64, file_name="f")
    )
    assert validate(again).valid
    assert len(again.loops) == len(original.loops)
    for a, b in zip(original.loops, again.loops, strict=True):
        pa, pb = np.asarray(a.points), np.asarray(b.points)
        assert pa.shape == pb.shape
        assert np.abs(pa - pb).max() < 1e-8
