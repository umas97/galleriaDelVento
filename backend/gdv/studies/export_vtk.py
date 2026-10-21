# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""VTK exports for ParaView (SPEC §11.5), written by hand: no dependency.

* ``.vti`` (ImageData): the time-averaged fields on the cell centres of the
  chamber -- velocity (m/s, a vector), Cp, pressure difference (Pa), vorticity
  (1/s) and the body's mask -- in real units, metres, origin at the bottom-left
  corner of the chamber; for a 3D result (SPEC §24.2 #7) the whole chamber,
  without the vorticity (ParaView's Gradient filter gives it);
* ``.vtp`` (PolyData): the sampled outline with its mean Cp, as one polyline
  ordered along the perimeter.

Both are XML with the binary data appended raw (``encoding="raw"``, 64-bit
little-endian block headers). The conditions (SPEC §2.3) open the file as an
XML comment.
"""

from __future__ import annotations

from xml.sax.saxutils import quoteattr

import numpy as np

from .conditions import conditions_lines
from .result import FieldRef, FieldRef3D, Study

__all__ = ["contour_vtp", "fields_vti", "fields_vti3d"]


def _comment(lines: list[str]) -> str:
    # "--" may not appear inside an XML comment.
    body = "\n".join("  " + line.replace("--", "—") for line in lines)
    return f"<!--\n{body}\n-->\n"


class _Appended:
    """Blocks of appended raw data and their offsets."""

    def __init__(self) -> None:
        self.blocks: list[bytes] = []
        self.offset = 0

    def add(self, array: np.ndarray) -> int:
        data = np.ascontiguousarray(array).astype(array.dtype.newbyteorder("<")).tobytes()
        at = self.offset
        block = np.uint64(len(data)).tobytes() + data
        self.blocks.append(block)
        self.offset += len(block)
        return at

    def section(self) -> bytes:
        head = b'  <AppendedData encoding="raw">\n   _'
        return head + b"".join(self.blocks) + b"\n  </AppendedData>\n"


_TYPES = {
    np.dtype(np.float32): "Float32",
    np.dtype(np.uint8): "UInt8",
    np.dtype(np.int8): "Int8",
    np.dtype(np.int64): "Int64",
}


def _array(data: _Appended, name: str, array: np.ndarray, components: int = 1) -> str:
    offset = data.add(array)
    return (
        f'        <DataArray type="{_TYPES[array.dtype]}" Name={quoteattr(name)} '
        f'NumberOfComponents="{components}" format="appended" offset="{offset}"/>\n'
    )


def _document(kind: str, header: list[str], body: str, data: _Appended) -> bytes:
    head = (
        '<?xml version="1.0"?>\n'
        + _comment(header)
        + f'<VTKFile type="{kind}" version="1.0" byte_order="LittleEndian" header_type="UInt64">\n'
    )
    return head.encode("utf-8") + body.encode("utf-8") + data.section() + b"</VTKFile>\n"


def fields_vti(study: Study, k: int, refs: list[FieldRef], arrays: dict[str, np.ndarray]) -> bytes:
    result = study.points[k].result
    by_name = {r.name: r for r in refs}
    ref = refs[0]
    nx, ny, dx = ref.nx, ref.ny, ref.dx

    def real(name: str) -> np.ndarray:
        return (arrays[name].astype(np.float32) * np.float32(by_name[name].scale)).ravel()

    u, v = real("u"), real("v")
    velocity = np.stack([u, v, np.zeros_like(u)], axis=1)
    cp = real("cp")
    data = _Appended()
    arrays_xml = (
        _array(data, "velocita_m_s", velocity, 3)
        + _array(data, "Cp", cp)
        + _array(data, "pressione_Pa", (cp * np.float32(result.plan.dynamic_pressure)))
        + _array(data, "vorticita_1_s", real("vorticity"))
        + _array(data, "solido", arrays["solid"].astype(np.uint8).ravel())
    )
    extent = f"0 {nx - 1} 0 {ny - 1} 0 0"
    half = dx / 2
    body = (
        f'  <ImageData WholeExtent="{extent}" Origin="{half!r} {half!r} 0" '
        f'Spacing="{dx!r} {dx!r} {dx!r}">\n'
        f'    <Piece Extent="{extent}">\n'
        '      <PointData Scalars="Cp" Vectors="velocita_m_s">\n'
        + arrays_xml
        + "      </PointData>\n    </Piece>\n  </ImageData>\n"
    )
    header = conditions_lines(study, result) + [
        f"Campi medi nel tempo su {ref.samples} campioni, centri delle celle, metri",
    ]
    return _document("ImageData", header, body, data)


def fields_vti3d(
    study: Study, k: int, refs: list[FieldRef3D], arrays: dict[str, np.ndarray]
) -> bytes:
    result = study.points[k].result
    by_name = {r.name: r for r in refs}
    ref = refs[0]
    nx, ny, nz, dx = ref.nx, ref.ny, ref.nz, ref.dx

    def real(name: str) -> np.ndarray:
        # (nz, ny, nx), x fastest: VTK's point order.
        return (arrays[name].astype(np.float32) * np.float32(by_name[name].scale)).ravel()

    velocity = np.stack([real("u"), real("v"), real("w")], axis=1)
    cp = real("cp")
    data = _Appended()
    arrays_xml = (
        _array(data, "velocita_m_s", velocity, 3)
        + _array(data, "Cp", cp)
        + _array(data, "pressione_Pa", (cp * np.float32(result.plan.dynamic_pressure)))
        + _array(data, "solido", arrays["solid"].astype(np.uint8).ravel())
    )
    extent = f"0 {nx - 1} 0 {ny - 1} 0 {nz - 1}"
    half = dx / 2
    body = (
        f'  <ImageData WholeExtent="{extent}" Origin="{half!r} {half!r} {half!r}" '
        f'Spacing="{dx!r} {dx!r} {dx!r}">\n'
        f'    <Piece Extent="{extent}">\n'
        '      <PointData Scalars="Cp" Vectors="velocita_m_s">\n'
        + arrays_xml
        + "      </PointData>\n    </Piece>\n  </ImageData>\n"
    )
    header = conditions_lines(study, result) + [
        f"Campi medi nel tempo su {ref.samples} campioni, centri delle celle, metri; "
        "origine nell'angolo della camera all'ingresso, sul pavimento",
    ]
    return _document("ImageData", header, body, data)


def contour_vtp(study: Study, k: int, contour: dict[str, np.ndarray]) -> bytes:
    result = study.points[k].result
    dx = result.plan.dx
    order = np.argsort(contour["s"])
    n = len(order)
    points = np.zeros((n, 3), dtype=np.float32)
    points[:, 0] = contour["x"][order] * dx
    points[:, 1] = contour["y"][order] * dx
    data = _Appended()
    points_xml = _array(data, "Points", points, 3)
    point_data = (
        _array(data, "Cp", contour["cp"][order].astype(np.float32))
        + _array(data, "x_c", contour["xc"][order].astype(np.float32))
        + _array(data, "s", contour["s"][order].astype(np.float32))
        + _array(data, "dorso", contour["upper"][order].astype(np.int8))
    )
    closed = np.append(np.arange(n, dtype=np.int64), 0) if n else np.zeros(0, dtype=np.int64)
    lines_xml = _array(data, "connectivity", closed) + _array(
        data, "offsets", np.array([len(closed)] if n else [], dtype=np.int64)
    )
    body = (
        "  <PolyData>\n"
        f'    <Piece NumberOfPoints="{n}" NumberOfVerts="0" NumberOfLines="{1 if n else 0}" '
        'NumberOfStrips="0" NumberOfPolys="0">\n'
        '      <PointData Scalars="Cp">\n' + point_data + "      </PointData>\n"
        "      <Points>\n" + points_xml + "      </Points>\n"
        "      <Lines>\n" + lines_xml + "      </Lines>\n"
        "    </Piece>\n  </PolyData>\n"
    )
    header = conditions_lines(study, result) + [
        "Cp medio sul contorno, coordinate della camera in metri",
    ]
    return _document("PolyData", header, body, data)
