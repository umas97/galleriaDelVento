#!/usr/bin/env python3
# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Draw the application icons: an airfoil in a stream, on a dark plate.

One geometry, computed here, feeds both the SVG and the PNGs (drawn with
Pillow at 4x and scaled down), so the two never disagree. File names are what
install.sh and the interface look for:

* ``packaging/icons/galleriadelvento-{48,128,256}.png`` and ``galleriadelvento.svg`` for
  the desktop (hicolor theme);
* ``packaging/icons/galleriadelvento.ico`` for the Windows executable (SPEC §25.3),
  each size drawn on its own;
* ``icons/icon.svg``, ``icon-192.png``, ``icon-512.png``, ``icon-512-maskable.png``
  for the interface (favicon, PWA manifest).

The maskable variant is the same drawing at 80% on a full-bleed plate: some
desktops crop icons to their own shape, and only the centre circle is safe.

Run with ``uv run python packaging/make_icons.py``.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

APP_ID = "galleriadelvento"
PLATE = "#161c28"
STREAM = "#7aa2f7"
BODY = "#f2f4f8"

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "packaging" / "icons"
WEB = (
    ROOT / "frontend" / "public" / "icons"
    if (ROOT / "frontend").is_dir()
    else ROOT / "backend" / "gdv" / "static" / "icons"
)

# Geometry in a 512 x 512 box.
SIZE = 512
PLATE_INSET, PLATE_RADIUS = 31, 99
CHORD, THICKNESS, INCIDENCE_DEG = 290.0, 0.19, 8.0
CENTRE = (262.0, 258.0)
STREAM_WIDTH = 17.0
#: (offset from the centre line, opacity): the outer lines are fainter.
STREAMS = ((-122.0, 0.5), (-64.0, 1.0), (64.0, 1.0), (122.0, 0.5))
X_START, X_END = 100.0, 424.0


def airfoil() -> list[tuple[float, float]]:
    """A thick symmetric NACA-style section, nose up, closed (screen coordinates)."""
    n = 48
    upper, lower = [], []
    for i in range(n + 1):
        beta = math.pi * i / n
        x = (1 - math.cos(beta)) / 2  # cosine spacing: round nose
        t = (
            5
            * THICKNESS
            * (
                0.2969 * math.sqrt(x)
                - 0.1260 * x
                - 0.3516 * x**2
                + 0.2843 * x**3
                - 0.1036 * x**4  # closed trailing edge
            )
        )
        upper.append((x, -t))
        lower.append((x, t))
    points = upper + lower[::-1][1:-1]
    a = math.radians(INCIDENCE_DEG)
    out = []
    for x, y in points:
        px, py = (x - 0.42) * CHORD, y * CHORD
        out.append(
            (
                CENTRE[0] + px * math.cos(a) - py * math.sin(a),
                CENTRE[1] + px * math.sin(a) + py * math.cos(a),
            )
        )
    return out


def streamline(offset: float) -> list[tuple[float, float]]:
    """A line of the stream, pushed away from the body near it (more above: lift)."""
    side = -1.0 if offset < 0 else 1.0
    strength = (44.0 if offset < 0 else 22.0) * math.exp(-(abs(offset) - 64.0) / 100.0)
    points = []
    steps = 64
    for i in range(steps + 1):
        x = X_START + (X_END - X_START) * i / steps
        # Widest where the section is thickest, about 30% of the chord.
        bump = math.exp(-(((x - (CENTRE[0] - 0.12 * CHORD)) / 95.0) ** 2))
        # The stream rises ahead of the nose and comes down behind the tail.
        upwash = -12.0 * math.tanh((CENTRE[0] - x) / 90.0) - 4.0
        points.append((x, CENTRE[1] + offset + side * strength * bump + upwash))
    return points


def _path(points: list[tuple[float, float]], closed: bool) -> str:
    head = f"M{points[0][0]:.1f} {points[0][1]:.1f}"
    body = " ".join(f"L{x:.1f} {y:.1f}" for x, y in points[1:])
    return f"{head} {body}{' Z' if closed else ''}"


def svg() -> str:
    lines = "\n".join(
        f'  <path d="{_path(streamline(o), False)}" fill="none" stroke="{STREAM}" '
        f'stroke-width="{STREAM_WIDTH}" stroke-linecap="round" stroke-linejoin="round" '
        f'opacity="{alpha}"/>'
        for o, alpha in STREAMS
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <rect x="{PLATE_INSET}" y="{PLATE_INSET}" width="{SIZE - 2 * PLATE_INSET}"
        height="{SIZE - 2 * PLATE_INSET}" rx="{PLATE_RADIUS}" fill="{PLATE}"/>
{lines}
  <path d="{_path(airfoil(), True)}" fill="{BODY}"/>
</svg>
"""


def _rgba(colour: str, alpha: float = 1.0) -> tuple[int, int, int, int]:
    c = colour.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), round(255 * alpha)


def draw(size: int, *, maskable: bool = False) -> Image.Image:
    """The icon at ``size`` px, drawn at 4x and scaled down for clean edges."""
    big = size * 4
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)
    if maskable:
        pen.rectangle((0, 0, big, big), fill=PLATE)
        k, shift = 0.8 * big / SIZE, big * 0.1
    else:
        k, shift = big / SIZE, 0.0
        inset, end = PLATE_INSET * k, (SIZE - PLATE_INSET) * k
        pen.rounded_rectangle((inset, inset, end, end), radius=PLATE_RADIUS * k, fill=PLATE)

    def tx(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * k + shift, y * k + shift) for x, y in points]

    width = STREAM_WIDTH * k
    for offset, alpha in STREAMS:
        layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        lp = ImageDraw.Draw(layer)
        points = tx(streamline(offset))
        colour = _rgba(STREAM)
        lp.line(points, fill=colour, width=round(width), joint="curve")
        for x, y in (points[0], points[-1]):
            r = width / 2
            lp.ellipse((x - r, y - r, x + r, y + r), fill=colour)
        if alpha < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v, a=alpha: round(v * a)))
        image.alpha_composite(layer)
    pen = ImageDraw.Draw(image)
    pen.polygon(tx(airfoil()), fill=BODY)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    DESKTOP.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    for size in (48, 128, 256):
        draw(size).save(DESKTOP / f"{APP_ID}-{size}.png")
    (DESKTOP / f"{APP_ID}.svg").write_text(svg(), encoding="utf-8")
    ico = (16, 24, 32, 48, 64, 128, 256)
    draw(256).save(
        DESKTOP / f"{APP_ID}.ico",
        sizes=[(s, s) for s in ico],
        append_images=[draw(s) for s in ico[:-1]],
    )
    draw(192).save(WEB / "icon-192.png")
    draw(512).save(WEB / "icon-512.png")
    draw(512, maskable=True).save(WEB / "icon-512-maskable.png")
    (WEB / "icon.svg").write_text(svg(), encoding="utf-8")
    print(f"icone scritte in {DESKTOP} e {WEB}")


if __name__ == "__main__":
    main()
