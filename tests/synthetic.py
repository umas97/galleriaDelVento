# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic test fixtures, generated in code (SPEC §18): no personal files, ever."""

from __future__ import annotations

import numpy as np

CUBE_VERTICES = np.array(
    [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
    ],
    dtype=np.float64,
)
#: Outward (counter-clockwise seen from outside), two triangles per side.
CUBE_FACES = np.array(
    [
        [0, 2, 1],
        [0, 3, 2],  # bottom z=0
        [4, 5, 6],
        [4, 6, 7],  # top z=1
        [0, 1, 5],
        [0, 5, 4],  # y=0
        [2, 3, 7],
        [2, 7, 6],  # y=1
        [1, 2, 6],
        [1, 6, 5],  # x=1
        [3, 0, 4],
        [3, 4, 7],  # x=0
    ],
    dtype=np.int64,
)


def stl_binary(vertices: np.ndarray, faces: np.ndarray) -> bytes:
    tris = vertices[faces].astype("<f4")
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = (normals / np.where(lengths == 0, 1, lengths)).astype("<f4")
    record = np.dtype([("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("a", "<u2")])
    data = np.zeros(len(faces), dtype=record)
    data["n"], data["v"] = normals, tris
    header = b"synthetic binary stl".ljust(80, b" ")
    return header + len(faces).to_bytes(4, "little") + data.tobytes()


def stl_ascii(vertices: np.ndarray, faces: np.ndarray) -> bytes:
    lines = ["solid synthetic"]
    for tri in vertices[faces]:
        lines.append("  facet normal 0 0 0")
        lines.append("    outer loop")
        lines.extend(f"      vertex {x:.9g} {y:.9g} {z:.9g}" for x, y, z in tri)
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid synthetic")
    return ("\n".join(lines) + "\n").encode()


def obj_multi_object(vertices: np.ndarray, faces: np.ndarray, parts: int = 3) -> bytes:
    """The mesh split into ``parts`` OBJ objects, each with its own vertex block."""
    lines = ["# synthetic", "mtllib missing.mtl"]
    offset = 0
    for k, chunk in enumerate(np.array_split(faces, parts)):
        lines.append(f"o part{k}")
        lines.append("usemtl nothing")
        used = np.unique(chunk)
        local = {int(v): i for i, v in enumerate(used)}
        lines.extend(f"v {x:.9g} {y:.9g} {z:.9g}" for x, y, z in vertices[used])
        lines.extend("f " + " ".join(str(offset + local[int(v)] + 1) for v in tri) for tri in chunk)
        offset += len(used)
    return ("\n".join(lines) + "\n").encode()


def subdivided_cube(n: int = 10, size: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """A closed cube with ``n x n`` quads per side (shared vertices, outward)."""
    vertices: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    grid = np.linspace(0, size, n + 1)
    u, v = np.meshgrid(grid, grid, indexing="ij")
    u, v = u.ravel(), v.ravel()
    base = 0
    sides = [
        (lambda a, b: np.stack([a, b, np.zeros_like(a)], 1), True),  # z=0, outward -z
        (lambda a, b: np.stack([a, b, np.full_like(a, size)], 1), False),
        (lambda a, b: np.stack([a, np.zeros_like(a), b], 1), False),  # y=0, outward -y
        (lambda a, b: np.stack([a, np.full_like(a, size), b], 1), True),
        (lambda a, b: np.stack([np.zeros_like(a), a, b], 1), True),  # x=0, outward -x
        (lambda a, b: np.stack([np.full_like(a, size), a, b], 1), False),
    ]
    for make, flip in sides:
        vertices.append(make(u, v))
        idx = np.arange((n + 1) ** 2).reshape(n + 1, n + 1) + base
        a, b, c, d = idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]
        quads = np.stack([np.stack([a, b, c], -1), np.stack([a, c, d], -1)], -2).reshape(-1, 3)
        faces.append(quads[:, ::-1] if flip else quads)
        base += (n + 1) ** 2
    from gdv.geometry.mesh_import import merge_vertices

    return merge_vertices(np.concatenate(vertices), np.concatenate(faces))


def cube_with_hole(n: int = 10) -> tuple[np.ndarray, np.ndarray]:
    """A subdivided unit cube with the two triangles of one small top quad removed."""
    vertices, faces = subdivided_cube(n)
    centres = vertices[faces].mean(axis=1)
    target = np.array([0.5 + 0.5 / n, 0.5 + 0.5 / n, 1.0])
    hole = np.linalg.norm(centres - target, axis=1) < 0.6 / n
    assert hole.sum() == 2
    return vertices, faces[~hole]


def uv_sphere(
    radius: float = 1.0, rings: int = 48, segments: int = 96
) -> tuple[np.ndarray, np.ndarray]:
    """A closed UV sphere with outward faces."""
    theta = np.linspace(0, np.pi, rings + 1)[1:-1]
    phi = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    t, p = np.meshgrid(theta, phi, indexing="ij")
    ring = np.stack([np.sin(t) * np.cos(p), np.sin(t) * np.sin(p), np.cos(t)], -1).reshape(-1, 3)
    vertices = np.concatenate([[[0, 0, 1]], ring, [[0, 0, -1]]]) * radius
    faces = []
    for j in range(segments):
        jn = (j + 1) % segments
        faces.append([0, 1 + j, 1 + jn])
        for i in range(rings - 2):
            a, b = 1 + i * segments + j, 1 + i * segments + jn
            c, d = a + segments, b + segments
            faces.append([a, c, d])
            faces.append([a, d, b])
        last = 1 + (rings - 2) * segments
        faces.append([len(vertices) - 1, last + jn, last + j])
    return vertices, np.array(faces, dtype=np.int64)
