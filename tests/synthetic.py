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


def naca4(code: str = "0012", n: int = 100, chord: float = 1.0) -> np.ndarray:
    """A NACA 4-digit profile, closed trailing edge, CCW, last point not repeated.

    Cosine spacing; starts at the trailing edge, runs over the upper surface to
    the leading edge and back along the lower one.
    """
    m, p, t = int(code[0]) / 100, int(code[1]) / 10, int(code[2:]) / 100
    beta = np.linspace(0, np.pi, n + 1)
    x = (1 - np.cos(beta)) / 2
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1036 * x**4)
    if m > 0:
        yc = np.where(
            x < p, m / p**2 * (2 * p * x - x**2), m / (1 - p) ** 2 * (1 - 2 * p + 2 * p * x - x**2)
        )
        dyc = np.where(x < p, 2 * m / p**2 * (p - x), 2 * m / (1 - p) ** 2 * (p - x))
    else:
        yc = np.zeros_like(x)
        dyc = np.zeros_like(x)
    theta = np.arctan(dyc)
    xu, yu = x - yt * np.sin(theta), yc + yt * np.cos(theta)
    xl, yl = x + yt * np.sin(theta), yc - yt * np.cos(theta)
    upper = np.stack([xu, yu], 1)[::-1]  # TE -> LE
    lower = np.stack([xl, yl], 1)[1:-1]  # LE -> TE, both ends excluded
    return np.concatenate([upper, lower]) * chord


# --- photographed sketches (SPEC §8, tests 13-16) --------------------------------------

#: The drawn sheet before it is photographed: A4 landscape at about 5 px/mm.
SHEET_PX = (1400, 990)


def on_sheet(loop: np.ndarray, *, centre=(0.5, 0.5), width=0.6) -> np.ndarray:
    """``loop`` (metres, y up) placed on the sheet: its x extent is ``width`` of the
    sheet's width, its box centred at ``centre`` (fractions); sheet pixels, y down."""
    lo, hi = loop.min(axis=0), loop.max(axis=0)
    scale = width * SHEET_PX[0] / (hi[0] - lo[0])
    mid = (lo + hi) / 2
    out = (loop - mid) * scale * np.array([1.0, -1.0])
    return out + np.array([centre[0] * SHEET_PX[0], centre[1] * SHEET_PX[1]])


def ellipse(rx: float, ry: float, n: int = 400) -> np.ndarray:
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([rx * np.cos(a), ry * np.sin(a)], 1)


def _densify(points: np.ndarray, closed: bool) -> np.ndarray:
    p = np.concatenate([points, points[:1]]) if closed else points
    out = [p[0]]
    for a, b in zip(p[:-1], p[1:], strict=True):
        n = max(1, int(np.ceil(np.hypot(*(b - a)))))
        out.extend(a + (b - a) * (np.arange(1, n + 1)[:, None] / n))
    return np.array(out)


def _wobble(
    rng: np.random.Generator,
    n: int,
    waves: int,
    cycles: tuple[float, float] = (2, 14),
    periodic: bool = False,
) -> np.ndarray:
    """A smooth random signal in [-1, 1] along ``n`` samples: ``waves`` sinusoids
    of ``cycles`` periods over the whole length (whole periods if ``periodic``,
    so that a closed stroke ends where it began)."""
    s = np.linspace(0, 2 * np.pi, n)
    total = np.zeros(n)
    for _ in range(waves):
        freq = rng.uniform(*cycles)
        if periodic:
            freq = max(1, round(freq))
        total += np.sin(freq * s + rng.uniform(0, 2 * np.pi)) / waves
    return total / max(1e-9, np.abs(total).max())


def draw_strokes(
    strokes: list[tuple[np.ndarray, bool]],
    rng: np.random.Generator,
    *,
    thickness: tuple[float, float] = (3.0, 6.0),
    tremor: float = 0.004,
    paper_rgb: tuple[int, int, int] = (205, 220, 228),
    drawn_lines: list[np.ndarray] | None = None,
) -> np.ndarray:
    """The sheet (BGR) with hand-drawn strokes: irregular width, a hand tremor
    along the normal of at most ``tremor`` of the stroke's size (waves 2-8% of
    its length long, as a hand drawing at a few cm/s), a slightly uneven ink.
    The lines actually drawn, tremor included, go into ``drawn_lines``."""
    import cv2

    w, h = SHEET_PX
    sheet = np.empty((h, w, 3), np.float32)
    sheet[:] = paper_rgb
    sheet += rng.normal(0, 2.5, sheet.shape)
    sheet = np.clip(sheet, 0, 255).astype(np.uint8)
    for points, closed in strokes:
        dense = _densify(np.asarray(points, np.float64), closed)
        size = float((dense.max(axis=0) - dense.min(axis=0)).max())
        tangent = np.gradient(dense, axis=0)
        normal = np.stack([-tangent[:, 1], tangent[:, 0]], 1)
        normal /= np.maximum(1e-9, np.hypot(*normal.T))[:, None]
        n = len(dense)
        length = float(np.hypot(*np.diff(dense, axis=0).T).sum())
        cycles = (length / (0.08 * size), length / (0.02 * size))
        wobble = _wobble(rng, n, 4, cycles, periodic=closed)
        drawn = dense + normal * (wobble * tremor * size)[:, None]
        if drawn_lines is not None:
            drawn_lines.append(drawn)
        lo, hi = thickness
        width = lo + (hi - lo) * (0.5 + 0.5 * _wobble(rng, n, 3))
        ink = rng.integers(25, 70)
        for k in range(0, n - 1, 2):
            a, b = drawn[k], drawn[min(k + 2, n - 1)]
            colour = tuple(int(ink + rng.integers(-8, 9)) for _ in range(3))
            cv2.line(
                sheet,
                (int(round(a[0] * 16)), int(round(a[1] * 16))),
                (int(round(b[0] * 16)), int(round(b[1] * 16))),
                colour,
                max(1, int(round(width[k]))),
                cv2.LINE_AA,
                shift=4,
            )
    return sheet


def camera_homography(
    sheet_size: tuple[int, int],
    photo: tuple[int, int],
    rng: np.random.Generator,
    *,
    tilt_deg: float = 25.0,
    fill: float = 0.7,
) -> np.ndarray:
    """Sheet pixels → photo pixels for a phone held above the sheet: a pinhole
    camera (focal 0.8 × width, principal point at the centre), tilted up to
    ``tilt_deg`` about both axes and turned freely, the sheet filling about
    ``fill`` of the photo's width."""
    sw, sh = sheet_size
    pw, ph = photo
    f = 0.8 * pw
    a, b = np.radians(rng.uniform(-tilt_deg, tilt_deg, 2))
    c = rng.uniform(-0.3, 0.3)
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    rz = np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    rot = rz @ rx @ ry
    distance = f * sw / (fill * pw)
    shift = rng.uniform(-0.05, 0.05, 2) * distance
    t = np.array([shift[0], shift[1], distance])
    k = np.array([[f, 0, (pw - 1) / 2], [0, f, (ph - 1) / 2], [0, 0, 1]])
    centre = np.array([[1, 0, -sw / 2], [0, 1, -sh / 2], [0, 0, 1]])
    matrix = k @ np.column_stack([rot[:, 0], rot[:, 1], t]) @ centre
    return matrix / matrix[2, 2]


def photograph(
    sheet: np.ndarray,
    rng: np.random.Generator,
    *,
    photo: tuple[int, int] = (2400, 1800),
    table_rgb: tuple[int, int, int] = (70, 85, 105),
    tilt_deg: float = 25.0,
    shadow: float = 0.45,
    quality: int = 80,
) -> tuple[bytes, np.ndarray]:
    """Lay the sheet on a table and take a phone photo: a camera homography, a
    shadow gradient, noise, JPEG. Returns the JPEG and the sheet's corners in it."""
    import cv2

    pw, ph = photo
    sh, sw = sheet.shape[:2]
    matrix = camera_homography((sw, sh), photo, rng, tilt_deg=tilt_deg)
    src = np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], np.float64)
    dst = cv2.perspectiveTransform(src[None].astype(np.float64), matrix)[0]
    table = np.empty((ph, pw, 3), np.float32)
    table[:] = table_rgb
    table += rng.normal(0, 6, table.shape)
    image = np.clip(table, 0, 255).astype(np.uint8)
    transparent = cv2.BORDER_TRANSPARENT
    cv2.warpPerspective(sheet, matrix, (pw, ph), dst=image, borderMode=transparent)
    yy, xx = np.mgrid[0:ph, 0:pw].astype(np.float32)
    direction = rng.uniform(0, 2 * np.pi)
    ramp = (np.cos(direction) * xx / pw + np.sin(direction) * yy / ph + 1) / 2
    light = 1 - shadow * np.clip(ramp, 0, 1)
    image = image.astype(np.float32) * light[..., None] + rng.normal(0, 3, image.shape)
    image = np.clip(image, 0, 255).astype(np.uint8)
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return data.tobytes(), dst


def sketch_photo(
    strokes: list[tuple[np.ndarray, bool]], seed: int = 0, **photo_options
) -> tuple[bytes, np.ndarray]:
    """Strokes in sheet pixels drawn by hand and photographed (see the two steps above)."""
    rng = np.random.default_rng(seed)
    return photograph(draw_strokes(strokes, rng), rng, **photo_options)


def open_ellipse(gap: float, *, centre=(0.5, 0.5), rx=0.3) -> tuple[np.ndarray, np.ndarray]:
    """An ellipse on the sheet with a gap of ``gap`` × sheet width at its right end.

    Returns the open polyline and the middle of the gap (sheet pixels).
    """
    r = rx * SHEET_PX[0]
    loop = ellipse(r, r * 0.55, 2000) + np.array([centre[0] * SHEET_PX[0], centre[1] * SHEET_PX[1]])
    half_angle = np.arcsin(min(1.0, gap * SHEET_PX[0] / 2 / (r * 0.55)))
    a = np.linspace(0, 2 * np.pi, 2000, endpoint=False)
    keep = np.abs(np.angle(np.exp(1j * a))) > half_angle
    start = int(np.argmax(keep & ~np.roll(keep, 1)))
    ordered = np.roll(np.arange(len(a)), -start)
    ordered = ordered[keep[ordered]]
    return loop[ordered], loop[0]
