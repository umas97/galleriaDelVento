# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Repairs (SPEC §6.3); test 7 is in test_models_api.py with the library files."""

from __future__ import annotations

import numpy as np
import pytest

from gdv.geometry.mesh_import import analyse, merge_vertices
from gdv.geometry.mesh_repair import (
    RepairOptions,
    orient_faces,
    remove_small_components,
    repair,
    triangulate_polygon,
)
from synthetic import cube_with_hole, subdivided_cube, uv_sphere


def signed_volume(v: np.ndarray, f: np.ndarray) -> float:
    return float(np.einsum("ij,ij->i", v[f[:, 0]], np.cross(v[f[:, 1]], v[f[:, 2]])).sum() / 6)


def test_fixtures_are_closed_and_outward():
    for v, f in (subdivided_cube(6), uv_sphere(1.0, 24, 48)):
        report = analyse(v, f)
        assert report.watertight
        assert report.inconsistent_normal_edges == 0
        assert signed_volume(v, f) > 0


def test_a_small_hole_is_closed_with_coherent_normals():
    # Perimeter 4/60 = 0.067, below 5% of the diagonal (0.087).
    v, f = cube_with_hole(60)
    assert analyse(v, f).holes == 1
    fixed = repair(v, f, RepairOptions())
    report = analyse(fixed.vertices, fixed.faces)
    assert report.watertight
    assert report.inconsistent_normal_edges == 0
    assert fixed.summary.holes_filled == 1
    assert signed_volume(fixed.vertices, fixed.faces) == pytest.approx(1.0)


def test_a_big_hole_stays_open_and_the_summary_says_why():
    v, f = subdivided_cube(4)
    top = v[f].mean(axis=1)[:, 2] > 0.999
    fixed = repair(v, f[~top], RepairOptions())
    assert fixed.summary.holes_filled == 0
    assert fixed.summary.holes_left_open == 1
    assert "troppo grande" in fixed.summary.holes_open_reasons[0]


def test_hole_filling_on_a_dense_sphere():
    v, f = uv_sphere(1.0, 256, 512)
    centres = v[f].mean(axis=1)
    hole = np.linalg.norm(centres - [1.0, 0.0, 0.0], axis=1) < 0.012  # a small disc
    assert hole.sum() > 4
    fixed = repair(v, f[~hole], RepairOptions())
    assert fixed.summary.holes_filled == 1
    assert analyse(fixed.vertices, fixed.faces).watertight


def test_random_flips_and_an_inside_out_mesh_are_reoriented():
    v, f = uv_sphere(1.0, 24, 48)
    rng = np.random.default_rng(1)
    bad = f.copy()
    flip = rng.random(len(f)) < 0.3
    bad[flip] = bad[flip][:, ::-1]
    for broken in (bad, f[:, ::-1]):
        out, flipped, _ = orient_faces(v, broken)
        assert flipped > 0
        assert analyse(v, out).inconsistent_normal_edges == 0
        assert signed_volume(v, out) > 0


def test_components_are_oriented_independently():
    v1, f1 = subdivided_cube(3)
    v2, f2 = uv_sphere(0.5, 12, 24)
    v = np.concatenate([v1, v2 + 3])
    f = np.concatenate([f1[:, ::-1], f2 + len(v1)])
    out, _, _ = orient_faces(v, f)
    assert signed_volume(v[: len(v1)], out[: len(f1)]) > 0
    assert signed_volume(v, out[len(f1) :]) > 0


def test_degenerate_faces_and_duplicates_are_removed():
    v, f = subdivided_cube(3)
    tris = v[f].reshape(-1, 3)  # unmerged: every triangle has its own vertices
    faces = np.arange(len(tris)).reshape(-1, 3)
    faces = np.concatenate([faces, [[0, 0, 1]]])
    fixed = repair(tris, faces, RepairOptions())
    assert fixed.summary.degenerate_removed == 1
    assert len(fixed.vertices) == len(merge_vertices(v, f)[0])
    assert analyse(fixed.vertices, fixed.faces).watertight


def test_small_components_are_removed_only_when_asked():
    v, f = uv_sphere(1.0, 96, 192)
    speck_v, speck_f = subdivided_cube(1, size=0.01)
    all_v = np.concatenate([v, speck_v + 5])
    all_f = np.concatenate([f, speck_f + len(v)])
    assert len(speck_f) < 0.001 * len(all_f)
    kept = repair(all_v, all_f, RepairOptions())
    assert analyse(kept.vertices, kept.faces).components == 2
    cut = repair(all_v, all_f, RepairOptions(remove_small_components=True))
    assert cut.summary.components_removed == 1
    assert analyse(cut.vertices, cut.faces).components == 1
    faces, removed = remove_small_components(all_v, all_f)
    assert removed == 1 and len(faces) == len(f)


def test_topological_repairs_need_merged_vertices():
    v, f = cube_with_hole(6)
    fixed = repair(
        v[f].reshape(-1, 3),
        np.arange(len(f) * 3).reshape(-1, 3),
        RepairOptions(merge_vertices=False),
    )
    assert len(fixed.summary.skipped) == 2
    assert fixed.summary.holes_filled == 0


def test_ear_clipping_of_a_concave_polygon():
    # An L shape, counter-clockwise.
    p = np.array([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], dtype=float)
    tris = triangulate_polygon(p)
    assert tris is not None and len(tris) == 4
    area = sum(
        0.5 * ((p[b] - p[a])[0] * (p[c] - p[a])[1] - (p[b] - p[a])[1] * (p[c] - p[a])[0])
        for a, b, c in tris
    )
    assert area == pytest.approx(3.0)
