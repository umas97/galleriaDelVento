# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""The binary mesh format the frontend downloads (``mesh.bin``, ``vista.bin``; SPEC §7.2).

Layout, little-endian, every block 4-byte aligned so the browser can view it with
``Float32Array``/``Uint32Array`` without copying:

* a JSON header of exactly :data:`HEADER_BYTES` bytes, padded with spaces:
  ``{"format": "gdv-mesh", "version": 1, "vertices": n, "triangles": m,
  "bbox_min": [...], "bbox_max": [...], "units": "m"}``;
* ``n * 3`` float32 -- vertex positions;
* ``m * 3`` uint32 -- triangle indices.

The frontend parser is ``frontend/src/lib/meshBinary.ts``; both sides check
``format`` and ``version``, and a file of another version is regenerated from
the original (SPEC §14.2).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import numpy as np

__all__ = ["FORMAT", "HEADER_BYTES", "VERSION", "MeshBinary", "decode", "encode"]

FORMAT = "gdv-mesh"
VERSION = 1
HEADER_BYTES = 1024


@dataclass
class MeshBinary:
    vertices: np.ndarray  # (n, 3) float32
    faces: np.ndarray  # (m, 3) uint32
    header: dict[str, Any]


def encode(vertices: np.ndarray, faces: np.ndarray, extra: dict[str, Any] | None = None) -> bytes:
    v = np.ascontiguousarray(vertices, dtype="<f4")
    f = np.ascontiguousarray(faces, dtype="<u4")
    header: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "vertices": int(len(v)),
        "triangles": int(len(f)),
        "bbox_min": [float(x) for x in v.min(axis=0)] if len(v) else [0.0, 0.0, 0.0],
        "bbox_max": [float(x) for x in v.max(axis=0)] if len(v) else [0.0, 0.0, 0.0],
        "units": "m",
    }
    if extra:
        header.update(extra)
    raw = json.dumps(header, separators=(",", ":")).encode("ascii")
    if len(raw) > HEADER_BYTES:
        raise ValueError("intestazione della mesh troppo lunga")
    return raw.ljust(HEADER_BYTES, b" ") + v.tobytes() + f.tobytes()


def read_header(data: bytes) -> dict[str, Any] | None:
    """The header, or ``None`` if ``data`` is not a mesh of the current version."""
    if len(data) < HEADER_BYTES:
        return None
    try:
        header = json.loads(data[:HEADER_BYTES].decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(header, dict):
        return None
    if header.get("format") != FORMAT or header.get("version") != VERSION:
        return None
    return header


def decode(data: bytes) -> MeshBinary:
    header = read_header(data)
    if header is None:
        raise ValueError("mesh binaria di un altro formato o di un'altra versione")
    n, m = int(header["vertices"]), int(header["triangles"])
    expected = HEADER_BYTES + 12 * n + 12 * m
    if len(data) != expected:
        raise ValueError(f"mesh binaria troncata: {len(data)} byte invece di {expected}")
    vertices = np.frombuffer(data, dtype="<f4", count=3 * n, offset=HEADER_BYTES).reshape(n, 3)
    faces = np.frombuffer(data, dtype="<u4", count=3 * m, offset=HEADER_BYTES + 12 * n)
    return MeshBinary(vertices, faces.reshape(m, 3), header)
