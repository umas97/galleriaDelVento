# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""STL/OBJ bytes -> triangle mesh, its units proposal and its report (SPEC §6.1-6.3).

The format is recognised from the *content*, never from the extension: a binary
STL is identified by its exact size, an ASCII STL by ``solid``/``facet``, an OBJ
by its ``v``/``f`` records. Binary STL -- the common case, and the big one -- is
read straight into numpy; ASCII STL and OBJ go through trimesh (OBJ groups and
objects are merged into one mesh, materials ignored).

Everything here is pure: arrays in, arrays out. Nothing is written to disk.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Literal

import numpy as np
from pydantic import BaseModel
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from ..errors import AppError

__all__ = [
    "MAX_TRIANGLES",
    "MAX_UPLOAD_BYTES",
    "MeshError",
    "MeshReport",
    "RawMesh",
    "analyse",
    "analyse_with_table",
    "detect_format",
    "edge_table",
    "load_mesh",
    "merge_vertices",
    "propose_units",
]

_log = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_TRIANGLES = 2_000_000

MeshFormat = Literal["stl", "obj"]
Units = Literal["mm", "cm", "m", "in"]

#: Metres per file unit.
UNIT_SCALE: dict[str, float] = {"mm": 1e-3, "cm": 1e-2, "m": 1.0, "in": 0.0254}

#: Vertices closer than this fraction of the diagonal are the same vertex.
MERGE_TOLERANCE = 1e-6

_STL_RECORD = np.dtype([("normal", "<f4", (3,)), ("v", "<f4", (3, 3)), ("attr", "<u2")])


class MeshError(AppError):
    """A file that cannot become a mesh. ``message`` is for the user, ``technical`` for Dettagli."""

    status = 422


@dataclass
class RawMesh:
    vertices: np.ndarray  # (n, 3) float64, file units
    faces: np.ndarray  # (m, 3) int64
    fmt: MeshFormat


def _italian_millions(count: int) -> str:
    return f"{count / 1e6:.1f}".replace(".", ",")


def too_many_triangles(count: int) -> MeshError:
    return MeshError(
        f"{_italian_millions(count)} milioni di triangoli: il limite è "
        f"{MAX_TRIANGLES // 1_000_000} milioni; decima il modello in Blender",
        f"triangles={count} limit={MAX_TRIANGLES}",
    )


def binary_stl_count(head: bytes, size: int) -> int | None:
    """Triangle count if ``head``/``size`` describe a binary STL, else ``None``."""
    if size < 84 or len(head) < 84:
        return None
    count = int.from_bytes(head[80:84], "little")
    return count if 84 + 50 * count == size else None


def detect_format(head: bytes, size: int) -> MeshFormat | None:
    """Recognise STL (binary or ASCII) or OBJ from the first bytes and the size."""
    if binary_stl_count(head, size) is not None:
        return "stl"
    text = head[:4096].decode("latin-1", errors="replace")
    stripped = text.lstrip().lower()
    if stripped.startswith("solid") and "facet" in stripped:
        return "stl"
    for line in text.splitlines():
        token = line.strip().split(" ", 1)[0]
        if token in ("v", "vn", "vt", "f", "o", "g", "mtllib", "usemtl", "s"):
            return "obj"
    return None


def _load_binary_stl(data: bytes) -> RawMesh:
    count = int.from_bytes(data[80:84], "little")
    records = np.frombuffer(data, dtype=_STL_RECORD, count=count, offset=84)
    vertices = records["v"].reshape(-1, 3).astype(np.float64)
    faces = np.arange(count * 3, dtype=np.int64).reshape(-1, 3)
    return RawMesh(vertices, faces, "stl")


def _load_with_trimesh(data: bytes, fmt: MeshFormat) -> RawMesh:
    import trimesh  # heavy: imported only when a file arrives

    kwargs = {"skip_materials": True} if fmt == "obj" else {}
    loaded = trimesh.load(io.BytesIO(data), file_type=fmt, force="mesh", process=False, **kwargs)
    if not isinstance(loaded, trimesh.Trimesh):
        raise MeshError("Il file non contiene una mesh di triangoli", type(loaded).__name__)
    return RawMesh(
        np.asarray(loaded.vertices, dtype=np.float64),
        np.asarray(loaded.faces, dtype=np.int64),
        fmt,
    )


def load_mesh(data: bytes) -> RawMesh:
    """Parse STL or OBJ bytes. Raises :class:`MeshError` with an Italian message."""
    fmt = detect_format(data[:4096], len(data))
    if fmt is None:
        raise MeshError(
            "Il file non sembra un STL/OBJ valido",
            "formato non riconosciuto dal contenuto (né STL binario, né STL ASCII, né OBJ)",
        )
    count = binary_stl_count(data[:84], len(data))
    if count is not None and count > MAX_TRIANGLES:
        raise too_many_triangles(count)
    try:
        mesh = _load_binary_stl(data) if count is not None else _load_with_trimesh(data, fmt)
    except MeshError:
        raise
    except Exception as exc:  # noqa: BLE001 - any parser failure is "not a valid file"
        _log.info("lettura mesh fallita: %r", exc)
        raise MeshError("Il file non sembra un STL/OBJ valido", repr(exc)) from exc
    if len(mesh.faces) == 0 or len(mesh.vertices) == 0:
        raise MeshError("Il file non contiene triangoli: la mesh è vuota", f"format={fmt}")
    if len(mesh.faces) > MAX_TRIANGLES:
        raise too_many_triangles(len(mesh.faces))
    if not np.all(np.isfinite(mesh.vertices)):
        raise MeshError(
            "Il file non sembra un STL/OBJ valido", "coordinate non finite (NaN o infinito)"
        )
    return mesh


def propose_units(extent: float) -> Units:
    """Unit proposal from the largest bounding-box extent ``E`` (SPEC §6.2)."""
    if extent > 200:
        return "mm"
    if extent > 20:
        return "cm"
    return "m"


def merge_vertices(vertices: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Merge coincident vertices (quantised at 1e-6 of the diagonal); drop unused ones.

    Each quantised coordinate fits in 20 bits, so one int64 key holds a vertex and
    a single argsort groups the duplicates.
    """
    if len(vertices) == 0:
        return vertices, faces
    lo = vertices.min(axis=0)
    diag = float(np.linalg.norm(vertices.max(axis=0) - lo)) or 1.0
    q = np.floor((vertices - lo) / (diag * MERGE_TOLERANCE) + 0.5).astype(np.int64)
    key = (q[:, 0] << 40) | (q[:, 1] << 20) | q[:, 2]
    used = np.zeros(len(vertices), dtype=bool)
    used[faces.ravel()] = True
    candidates = np.nonzero(used)[0]
    order = candidates[np.argsort(key[candidates])]
    sorted_key = key[order]
    first = np.ones(len(order), dtype=bool)
    first[1:] = sorted_key[1:] != sorted_key[:-1]
    group = np.cumsum(first) - 1
    remap = np.full(len(vertices), -1, dtype=np.int64)
    remap[order] = group
    merged = vertices[order[first]]
    return merged, remap[faces]


@dataclass
class EdgeTable:
    """Undirected edges of a mesh, grouped: the base of every topological check."""

    key: np.ndarray  # (u,) sorted unique undirected keys lo*nv+hi
    count: np.ndarray  # (u,) how many face-edges use each
    inverse: np.ndarray  # (3m,) face-edge -> unique edge
    directed: np.ndarray  # (3m, 2) face-edges as (a, b)
    forward: np.ndarray  # (3m,) a < b

    def reoriented(self, faces: np.ndarray) -> EdgeTable:
        """The same table after some faces were flipped (undirected edges unchanged)."""
        directed = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
        forward = directed[:, 0] < directed[:, 1]
        return EdgeTable(self.key, self.count, self.inverse, directed, forward)


def edge_table(faces: np.ndarray, n_vertices: int) -> EdgeTable:
    directed = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    a, b = directed[:, 0], directed[:, 1]
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    key, inverse, count = np.unique(
        lo * np.int64(n_vertices) + hi, return_inverse=True, return_counts=True
    )
    return EdgeTable(key, count, inverse, directed, a < b)


class MeshReport(BaseModel):
    """What the user is shown after import (SPEC §6.3). Counts refer to the merged mesh."""

    triangles: int
    vertices: int
    watertight: bool
    non_manifold_edges: int
    degenerate_faces: int
    duplicate_vertices: int
    inconsistent_normal_edges: int
    components: int
    holes: int
    largest_hole_perimeter: float  # file units
    extents: tuple[float, float, float]  # file units, file axes
    diagonal: float  # file units


def face_areas(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v0, v1, v2 = (vertices[faces[:, i]] for i in range(3))
    return 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)


def degenerate_mask(vertices: np.ndarray, faces: np.ndarray, diagonal: float) -> np.ndarray:
    """Faces with a repeated vertex or an area below (1e-7 of the diagonal)^2."""
    repeated = (
        (faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2]) | (faces[:, 2] == faces[:, 0])
    )
    return repeated | (face_areas(vertices, faces) <= (diagonal * 1e-7) ** 2)


def vertex_components(n_vertices: int, edges: np.ndarray) -> tuple[int, np.ndarray]:
    graph = coo_matrix(
        (np.ones(len(edges), dtype=np.int8), (edges[:, 0], edges[:, 1])),
        shape=(n_vertices, n_vertices),
    )
    return connected_components(graph, directed=False)


def boundary_loops(vertices: np.ndarray, table: EdgeTable) -> tuple[np.ndarray, np.ndarray]:
    """Boundary face-edges (as (a, b)) and the hole label of each."""
    boundary = table.directed[table.count[table.inverse] == 1]
    if len(boundary) == 0:
        return boundary, np.zeros(0, dtype=np.int64)
    _, labels = vertex_components(len(vertices), boundary)
    return boundary, labels[boundary[:, 0]]


def _distinct(values: np.ndarray) -> int:
    """How many distinct non-negative integers (``np.unique`` is slow on big arrays)."""
    return int(np.count_nonzero(np.bincount(values))) if len(values) else 0


def analyse(
    raw_vertices: np.ndarray,
    raw_faces: np.ndarray,
    merged: tuple[np.ndarray, np.ndarray] | None = None,
) -> MeshReport:
    """The mesh report. ``raw_*`` are as read from the file (unmerged); ``merged``, if
    given, is ``merge_vertices(raw_*)`` already computed."""
    return analyse_with_table(raw_vertices, raw_faces, merged)[0]


def analyse_with_table(
    raw_vertices: np.ndarray,
    raw_faces: np.ndarray,
    merged: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[MeshReport, EdgeTable]:
    """:func:`analyse`, also returning the edge table of the merged mesh for reuse."""
    vertices, faces = merged if merged is not None else merge_vertices(raw_vertices, raw_faces)
    lo, hi = raw_vertices.min(axis=0), raw_vertices.max(axis=0)
    extents = hi - lo
    diagonal = float(np.linalg.norm(extents))
    used = _distinct(raw_faces.ravel())
    degenerate = degenerate_mask(vertices, faces, diagonal)
    # A face with a repeated vertex has an edge from a vertex to itself: it would
    # count as a hole. Topology is judged without such faces.
    faces = faces[
        (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])
    ]
    table = edge_table(faces, len(vertices))
    manifold = table.count == 2
    same_way = np.bincount(table.inverse, weights=table.forward, minlength=len(table.key))
    inconsistent = int(np.count_nonzero(manifold & (same_way != 1)))
    boundary, hole_labels = boundary_loops(vertices, table)
    holes, largest = 0, 0.0
    if len(boundary):
        lengths = np.linalg.norm(vertices[boundary[:, 0]] - vertices[boundary[:, 1]], axis=1)
        perimeters = np.bincount(hole_labels, weights=lengths)
        holes, largest = _distinct(hole_labels), float(perimeters.max())
    _, labels = vertex_components(len(vertices), faces[:, [0, 1, 1, 2]].reshape(-1, 2))
    components = _distinct(labels[faces[:, 0]])
    non_manifold = int(np.count_nonzero(table.count > 2))
    report = MeshReport(
        triangles=len(raw_faces),
        vertices=len(vertices),
        watertight=bool(len(boundary) == 0 and non_manifold == 0),
        non_manifold_edges=non_manifold,
        degenerate_faces=int(np.count_nonzero(degenerate)),
        duplicate_vertices=int(used - len(vertices)),
        inconsistent_normal_edges=inconsistent,
        components=components,
        holes=holes,
        largest_hole_perimeter=largest,
        extents=(float(extents[0]), float(extents[1]), float(extents[2])),
        diagonal=diagonal,
    )
    return report, table
