# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Non-destructive mesh repairs (SPEC §6.3).

Every repair takes arrays and returns new arrays: the original file is never
involved. The order is fixed -- merge, degenerate faces, normals, holes, small
components -- because each step relies on the topology the previous one
cleaned up. Normal orientation and hole filling need shared vertices, so with
"merge" turned off they are skipped and the summary says why.

Hole filling is written here because ``trimesh.repair.fill_holes`` only closes
holes of three or four edges: each boundary loop is projected on its mean plane
(PCA) and triangulated by ear clipping, wound against the adjacent faces. A loop
whose projection self-intersects is left open and the summary says so.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
from pydantic import BaseModel
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import breadth_first_order, connected_components

from .mesh_import import (
    EdgeTable,
    boundary_loops,
    degenerate_mask,
    edge_table,
    merge_vertices,
    vertex_components,
)

__all__ = ["RepairOptions", "RepairSummary", "orient_faces", "repair", "triangulate_polygon"]

_log = logging.getLogger(__name__)

#: Holes with a perimeter below this fraction of the bounding-box diagonal are closed.
HOLE_PERIMETER_FRACTION = 0.05
#: Components with fewer than this fraction of the triangles are "small".
SMALL_COMPONENT_FRACTION = 0.001
#: Beyond this many vertices a hole is left open (ear clipping is quadratic).
MAX_HOLE_VERTICES = 1000


class RepairOptions(BaseModel):
    """The switches shown next to the report. Defaults per SPEC §6.3."""

    merge_vertices: bool = True
    remove_degenerate: bool = True
    fix_normals: bool = True
    fill_holes: bool = True
    remove_small_components: bool = False


class RepairSummary(BaseModel):
    triangles_before: int
    triangles_after: int
    vertices_after: int
    degenerate_removed: int = 0
    faces_flipped: int = 0
    holes_filled: int = 0
    holes_left_open: int = 0
    holes_open_reasons: list[str] = []
    components_removed: int = 0
    skipped: list[str] = []


@dataclass
class RepairedMesh:
    vertices: np.ndarray
    faces: np.ndarray
    summary: RepairSummary = field(default=None)  # type: ignore[assignment]


def _compact(vertices: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    used = np.zeros(len(vertices), dtype=bool)
    used[faces.ravel()] = True
    remap = np.cumsum(used) - 1
    return vertices[used], remap[faces]


# --- normals -------------------------------------------------------------------


def orient_faces(
    vertices: np.ndarray, faces: np.ndarray, table: EdgeTable | None = None
) -> tuple[np.ndarray, int, EdgeTable]:
    """Make the winding consistent across manifold edges, then outward per component.

    Faces sharing a manifold edge must traverse it in opposite directions. A BFS
    over the face graph (one virtual root joined to every component) gives each
    face a parent; the parity "flip relative to the root" is then accumulated
    along the tree by pointer jumping, all in numpy. A component whose signed
    volume is negative is turned inside out as a whole.
    """
    m = len(faces)
    if table is None:
        table = edge_table(faces, len(vertices))
    if m == 0:
        return faces, 0, table
    order = np.argsort(table.inverse)
    starts = np.concatenate(([0], np.cumsum(table.count)[:-1]))
    pairs = np.nonzero(table.count == 2)[0]
    e1, e2 = order[starts[pairs]], order[starts[pairs] + 1]
    f1, f2 = e1 // 3, e2 // 3
    keep = f1 != f2
    f1, f2, e1, e2 = f1[keep], f2[keep], e1[keep], e2[keep]
    # Same direction along the shared edge -> one of the two must be flipped.
    rel = (table.forward[e1] == table.forward[e2]).astype(np.int8)

    graph = coo_matrix((np.ones(len(f1), dtype=np.int8), (f1, f2)), shape=(m, m))
    _, labels = connected_components(graph, directed=False)
    _, roots = np.unique(labels, return_index=True)
    root = m  # virtual node joined to one face of every component
    rows = np.concatenate((f1, f2, np.full(len(roots), root)))
    cols = np.concatenate((f2, f1, roots))
    full = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(m + 1, m + 1))
    _, pred = breadth_first_order(full.tocsr(), root, directed=True, return_predecessors=True)

    # Relation of each face to its BFS parent, looked up by sorted pair keys.
    lo, hi = np.minimum(f1, f2), np.maximum(f1, f2)
    pair_key = lo.astype(np.int64) * (m + 1) + hi
    sort = np.argsort(pair_key)
    pair_key, pair_rel = pair_key[sort], rel[sort]
    nodes = np.arange(m)
    parent = pred[:m].astype(np.int64)
    parity = np.zeros(m + 1, dtype=np.int8)
    tree = parent != root
    t_lo = np.minimum(nodes[tree], parent[tree])
    t_hi = np.maximum(nodes[tree], parent[tree])
    where = np.searchsorted(pair_key, t_lo * (m + 1) + t_hi)
    parity[:m][tree] = pair_rel[np.minimum(where, len(pair_key) - 1)]
    ancestor = np.append(parent, root)
    ancestor[ancestor < 0] = root
    for _ in range(64):
        parity = parity ^ parity[ancestor]
        next_ancestor = ancestor[ancestor]
        if np.array_equal(next_ancestor, ancestor):
            break
        ancestor = next_ancestor
    flip = parity[:m].astype(bool)
    out = faces.copy()
    out[flip] = out[flip][:, ::-1]

    # Outward: a negative signed volume turns the whole component over.
    v0, v1, v2 = (vertices[out[:, i]] for i in range(3))
    volume = np.einsum("ij,ij->i", v0, np.cross(v1, v2))
    comp_volume = np.bincount(labels, weights=volume)
    inward = comp_volume[labels] < 0
    out[inward] = out[inward][:, ::-1]
    flip ^= inward
    flipped = int(np.count_nonzero(flip))
    return out, flipped, table.reoriented(out) if flipped else table


# --- holes ---------------------------------------------------------------------


def _segments_cross(p: np.ndarray) -> bool:
    """Does the closed polygon ``p`` (n, 2) have two non-adjacent edges that cross?"""
    n = len(p)
    if n < 4:
        return False
    a, b = p, np.roll(p, -1, axis=0)
    d = b - a
    for i in range(n):
        # Edges i+2 .. i-2 (cyclic) are the non-adjacent ones.
        j = (np.arange(i + 2, i + n - 1) % n) if i > 0 else np.arange(2, n - 1)
        if len(j) == 0:
            continue
        c1 = d[i, 0] * (a[j, 1] - a[i, 1]) - d[i, 1] * (a[j, 0] - a[i, 0])
        c2 = d[i, 0] * (b[j, 1] - a[i, 1]) - d[i, 1] * (b[j, 0] - a[i, 0])
        c3 = d[j, 0] * (a[i, 1] - a[j, 1]) - d[j, 1] * (a[i, 0] - a[j, 0])
        c4 = d[j, 0] * (b[i, 1] - a[j, 1]) - d[j, 1] * (b[i, 0] - a[j, 0])
        if np.any((c1 * c2 < 0) & (c3 * c4 < 0)):
            return True
    return False


def triangulate_polygon(p: np.ndarray) -> list[tuple[int, int, int]] | None:
    """Ear clipping of a simple counter-clockwise polygon ``p`` (n, 2).

    Returns triangles as index triples (counter-clockwise), or ``None`` if no ear
    can be found (the polygon is not simple).
    """
    n = len(p)
    if n < 3:
        return None
    idx = list(range(n))
    triangles: list[tuple[int, int, int]] = []

    def cross(o: int, a: int, b: int) -> float:
        return float(
            (p[a, 0] - p[o, 0]) * (p[b, 1] - p[o, 1]) - (p[a, 1] - p[o, 1]) * (p[b, 0] - p[o, 0])
        )

    def inside(pt: int, a: int, b: int, c: int) -> bool:
        return cross(a, b, pt) >= 0 and cross(b, c, pt) >= 0 and cross(c, a, pt) >= 0

    while len(idx) > 3:
        found = False
        k = len(idx)
        # Only reflex vertices can lie inside an ear.
        reflex = [idx[i] for i in range(k) if cross(idx[i - 1], idx[i], idx[(i + 1) % k]) <= 0]
        for i in range(k):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % k]
            if cross(a, b, c) <= 0:
                continue  # reflex or flat
            if any(inside(q, a, b, c) for q in reflex if q not in (a, b, c)):
                continue
            triangles.append((a, b, c))
            del idx[i]
            found = True
            break
        if not found:
            return None
    triangles.append((idx[0], idx[1], idx[2]))
    return triangles


def _walk_loop(edges: np.ndarray) -> list[int] | None:
    """Order the boundary edges (a, b) of one hole into a single cycle."""
    nxt: dict[int, int] = {}
    for a, b in edges.tolist():
        if a in nxt:
            return None  # a vertex where the boundary branches
        nxt[a] = b
    start = int(edges[0, 0])
    loop = [start]
    current = nxt[start]
    while current != start:
        if current not in nxt or len(loop) > len(edges):
            return None
        loop.append(current)
        current = nxt[current]
    return loop if len(loop) == len(edges) else None


def fill_holes(
    vertices: np.ndarray, faces: np.ndarray, max_perimeter: float, table: EdgeTable | None = None
) -> tuple[np.ndarray, int, list[str]]:
    """Close the holes smaller than ``max_perimeter``. Returns faces, count, open reasons."""
    if table is None:
        table = edge_table(faces, len(vertices))
    boundary, labels = boundary_loops(vertices, table)
    if len(boundary) == 0:
        return faces, 0, []
    lengths = np.linalg.norm(vertices[boundary[:, 0]] - vertices[boundary[:, 1]], axis=1)
    order = np.argsort(labels, kind="stable")
    labels_sorted = labels[order]
    cuts = np.nonzero(np.diff(labels_sorted))[0] + 1
    new_faces: list[np.ndarray] = []
    filled = 0
    reasons: list[str] = []
    for group in np.split(order, cuts):
        perimeter = float(lengths[group].sum())
        if perimeter >= max_perimeter:
            reasons.append("buco troppo grande per la chiusura automatica")
            continue
        if len(group) > MAX_HOLE_VERTICES:
            reasons.append("buco con troppi vertici")
            continue
        loop = _walk_loop(boundary[group])
        if loop is None:
            reasons.append("bordo del buco non semplice")
            continue
        # The fill traverses each boundary edge backwards: reverse the walk.
        ring = np.array(loop[::-1], dtype=np.int64)
        if len(ring) == 3:
            new_faces.append(ring.reshape(1, 3))
            filled += 1
            continue
        pts = vertices[ring]
        centre = pts.mean(axis=0)
        _, _, vt = np.linalg.svd(pts - centre, full_matrices=False)
        flat = (pts - centre) @ vt[:2].T
        x, y = flat[:, 0], flat[:, 1]
        signed = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))
        if signed < 0:
            flat[:, 1] = -flat[:, 1]  # mirror: same index order, now counter-clockwise
        if _segments_cross(flat):
            reasons.append("la proiezione del buco si auto-interseca")
            continue
        tris = triangulate_polygon(flat)
        if tris is None:
            reasons.append("la proiezione del buco si auto-interseca")
            continue
        new_faces.append(ring[np.array(tris, dtype=np.int64)])
        filled += 1
    if new_faces:
        faces = np.concatenate([faces, *new_faces])
    return faces, filled, reasons


# --- small components ----------------------------------------------------------


def remove_small_components(
    vertices: np.ndarray, faces: np.ndarray, fraction: float = SMALL_COMPONENT_FRACTION
) -> tuple[np.ndarray, int]:
    _, labels = vertex_components(len(vertices), faces[:, [0, 1, 1, 2]].reshape(-1, 2))
    face_labels = labels[faces[:, 0]]
    sizes = np.bincount(face_labels)
    small = sizes < fraction * len(faces)
    small_present = np.count_nonzero(small & (sizes > 0))
    keep = ~small[face_labels]
    return faces[keep], int(small_present)


# --- pipeline ------------------------------------------------------------------


def repair(
    raw_vertices: np.ndarray,
    raw_faces: np.ndarray,
    options: RepairOptions,
    merged: tuple[np.ndarray, np.ndarray] | None = None,
    table: EdgeTable | None = None,
) -> RepairedMesh:
    """Apply the chosen repairs.

    ``merged`` is ``merge_vertices(raw_*)`` and ``table`` its edge table, when the
    caller already has them (the import computes both for the report).
    """
    vertices = np.asarray(raw_vertices, dtype=np.float64)
    faces = np.asarray(raw_faces, dtype=np.int64)
    summary = RepairSummary(
        triangles_before=len(faces), triangles_after=len(faces), vertices_after=len(vertices)
    )
    diagonal = float(np.linalg.norm(np.ptp(vertices, axis=0)))
    if options.merge_vertices:
        vertices, faces = merged if merged is not None else merge_vertices(vertices, faces)
    if options.remove_degenerate:
        bad = degenerate_mask(vertices, faces, diagonal)
        summary.degenerate_removed = int(np.count_nonzero(bad))
        if summary.degenerate_removed:
            faces, table = faces[~bad], None
    topology_ok = options.merge_vertices
    if not topology_ok or (table is not None and len(table.directed) != 3 * len(faces)):
        table = None
    if options.fix_normals:
        if topology_ok:
            faces, summary.faces_flipped, table = orient_faces(vertices, faces, table)
        else:
            summary.skipped.append("normali: richiede l'unione dei vertici duplicati")
    if options.fill_holes:
        if topology_ok:
            faces, summary.holes_filled, reasons = fill_holes(
                vertices, faces, HOLE_PERIMETER_FRACTION * diagonal, table
            )
            summary.holes_left_open = len(reasons)
            summary.holes_open_reasons = sorted(set(reasons))
        else:
            summary.skipped.append("buchi: richiede l'unione dei vertici duplicati")
    if options.remove_small_components:
        faces, summary.components_removed = remove_small_components(vertices, faces)
    if len(faces) == 0:
        from .mesh_import import MeshError

        raise MeshError(
            "Dopo le riparazioni non resta nessun triangolo: la mesh è vuota",
            summary.model_dump_json(),
        )
    vertices, faces = _compact(vertices, faces)
    summary.triangles_after = len(faces)
    summary.vertices_after = len(vertices)
    _log.info("riparazione: %s", summary.model_dump())
    return RepairedMesh(vertices, faces, summary)
