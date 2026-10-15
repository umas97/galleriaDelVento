# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 6 and the mesh report: STL binary/ASCII and OBJ give the same mesh (SPEC §6.1-6.3)."""

from __future__ import annotations

import numpy as np
import pytest

from gdv.geometry import mesh_binary
from gdv.geometry.mesh_import import (
    MAX_TRIANGLES,
    MeshError,
    analyse,
    detect_format,
    load_mesh,
    merge_vertices,
    propose_units,
)
from synthetic import (
    CUBE_FACES,
    CUBE_VERTICES,
    cube_with_hole,
    obj_multi_object,
    stl_ascii,
    stl_binary,
    subdivided_cube,
)


def canonical(vertices: np.ndarray, faces: np.ndarray) -> set[tuple[tuple[float, ...], ...]]:
    """A mesh as a set of triangles (rotation of each triangle normalised)."""
    v, f = merge_vertices(vertices, faces)
    out = set()
    for tri in np.round(v[f], 6):
        rows = [tuple(map(float, r)) for r in tri]
        k = rows.index(min(rows))
        out.add(tuple(rows[k:] + rows[:k]))
    return out


def test_6_three_formats_of_the_same_cube_give_the_same_mesh():
    meshes = [
        load_mesh(stl_binary(CUBE_VERTICES, CUBE_FACES)),
        load_mesh(stl_ascii(CUBE_VERTICES, CUBE_FACES)),
        load_mesh(obj_multi_object(CUBE_VERTICES, CUBE_FACES, parts=3)),
    ]
    assert [m.fmt for m in meshes] == ["stl", "stl", "obj"]
    reference = canonical(CUBE_VERTICES, CUBE_FACES)
    for mesh in meshes:
        assert len(mesh.faces) == 12
        assert canonical(mesh.vertices, mesh.faces) == reference


@pytest.mark.parametrize(("extent", "units"), [(0.5, "m"), (50, "cm"), (500, "mm")])
def test_6_units_proposal(extent, units):
    assert propose_units(extent) == units
    mesh = load_mesh(stl_binary(CUBE_VERTICES * extent, CUBE_FACES))
    assert propose_units(max(analyse(mesh.vertices, mesh.faces).extents)) == units


@pytest.mark.parametrize(
    ("extent", "units"), [(20, "m"), (20.001, "cm"), (200, "cm"), (200.1, "mm")]
)
def test_units_proposal_boundaries(extent, units):
    assert propose_units(extent) == units


def test_format_is_recognised_from_content_not_name():
    assert detect_format(stl_binary(CUBE_VERTICES, CUBE_FACES)[:4096], 84 + 50 * 12) == "stl"
    assert detect_format(stl_ascii(CUBE_VERTICES, CUBE_FACES), 10) == "stl"
    assert detect_format(obj_multi_object(CUBE_VERTICES, CUBE_FACES), 10) == "obj"
    assert detect_format(b"<svg xmlns='http://www.w3.org/2000/svg'/>", 40) is None


def test_a_binary_stl_whose_header_starts_with_solid_is_still_binary():
    data = stl_binary(CUBE_VERTICES, CUBE_FACES)
    data = b"solid facet trap".ljust(80, b" ") + data[80:]
    assert len(load_mesh(data).faces) == 12


@pytest.mark.parametrize("payload", [b"hello world, not a mesh", b"\x00" * 300, b"<svg/>"])
def test_garbage_is_not_a_valid_file(payload):
    with pytest.raises(MeshError) as info:
        load_mesh(payload)
    assert info.value.message == "Il file non sembra un STL/OBJ valido"
    assert info.value.technical


def test_a_broken_ascii_stl_is_reported_with_details():
    with pytest.raises(MeshError) as info:
        load_mesh(b"solid x\n facet normal 0 0 0\n outer loop\n vertex 1 2\n")
    assert (
        info.value.message in ("Il file non sembra un STL/OBJ valido",)
        or "vuota" in info.value.message
    )


def test_too_many_triangles_says_the_real_number():
    count = 3_400_000
    header = b" " * 80 + count.to_bytes(4, "little")
    data = header + b"\x00" * (50 * count)
    with pytest.raises(MeshError) as info:
        load_mesh(data)
    assert info.value.message == (
        "3,4 milioni di triangoli: il limite è 2 milioni; decima il modello in Blender"
    )
    assert MAX_TRIANGLES == 2_000_000


def test_report_of_a_closed_cube():
    mesh = load_mesh(stl_binary(CUBE_VERTICES, CUBE_FACES))
    report = analyse(mesh.vertices, mesh.faces)
    assert report.triangles == 12
    assert report.vertices == 8
    assert report.duplicate_vertices == 36 - 8
    assert report.watertight
    assert report.holes == 0
    assert report.components == 1
    assert report.non_manifold_edges == 0
    assert report.inconsistent_normal_edges == 0
    assert report.degenerate_faces == 0
    assert report.extents == (1.0, 1.0, 1.0)


def test_report_finds_holes_flips_degenerates_and_components():
    vertices, faces = cube_with_hole(10)  # hole perimeter 0.4
    faces = faces.copy()
    faces[5] = faces[5][::-1]  # one flipped face: its three edges become inconsistent
    second = vertices + [3, 0, 0]
    degenerate = np.array([[0, 0, 1]])
    all_v = np.concatenate([vertices, second])
    all_f = np.concatenate([faces, faces + len(vertices), degenerate])
    report = analyse(all_v, all_f)
    assert report.holes == 2
    assert report.largest_hole_perimeter == pytest.approx(0.4)
    assert not report.watertight
    assert report.components == 2
    assert report.inconsistent_normal_edges == 6
    assert report.degenerate_faces == 1


def test_non_manifold_edges_are_counted():
    v, f = subdivided_cube(2)
    fin = np.array([[f[0, 0], f[0, 1], len(v)]])
    report = analyse(np.concatenate([v, [[5.0, 5.0, 5.0]]]), np.concatenate([f, fin]))
    assert report.non_manifold_edges == 1


def test_mesh_binary_round_trip():
    v, f = subdivided_cube(4)
    data = mesh_binary.encode(v, f, {"model_id": "abc"})
    assert len(data) == mesh_binary.HEADER_BYTES + 12 * len(v) + 12 * len(f)
    decoded = mesh_binary.decode(data)
    np.testing.assert_allclose(decoded.vertices, v.astype(np.float32))
    np.testing.assert_array_equal(decoded.faces, f)
    assert decoded.header["model_id"] == "abc"
    assert decoded.header["bbox_max"] == [1.0, 1.0, 1.0]


def test_mesh_binary_rejects_other_versions():
    data = bytearray(mesh_binary.encode(*subdivided_cube(2)))
    data[: mesh_binary.HEADER_BYTES] = b'{"format":"gdv-mesh","version":99}'.ljust(
        mesh_binary.HEADER_BYTES
    )
    assert mesh_binary.read_header(bytes(data)) is None
    with pytest.raises(ValueError):
        mesh_binary.decode(bytes(data))
