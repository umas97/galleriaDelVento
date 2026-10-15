#!/usr/bin/env python3
# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Draw the application icons: placeholders, until the program has a face.

A rounded plate with the initial of the name. Good enough for the menu and the
dock on day one; replace the drawing with a real one when the program deserves
it, keeping the file names -- install.sh and the interface look for exactly
these:

* ``packaging/icons/galleriadelvento-{48,128,256}.png`` and ``galleriadelvento.svg`` for
  the desktop (hicolor theme);
* ``icons/icon.svg``, ``icon-192.png``, ``icon-512.png``, ``icon-512-maskable.png``
  for the interface (favicon, PWA manifest).

The maskable variant is the same drawing at 80% on a full-bleed plate: some
desktops crop icons to their own shape, and only the centre circle is safe.

Run with ``uv run python packaging/make_icons.py``.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP_ID = "galleriadelvento"
INITIAL = "galleriaDelVento"[:1].upper()
PLATE = "#1d2433"
ACCENT = "#7aa2f7"
INK = "#f5f5f5"

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "packaging" / "icons"
WEB = (
    ROOT / "frontend" / "public" / "icons"
    if (ROOT / "frontend").is_dir()
    else ROOT / "backend" / "gdv" / "static" / "icons"
)

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size)


def draw(size: int, *, maskable: bool = False) -> Image.Image:
    """The icon at ``size`` px, drawn at 4x and scaled down for clean edges."""
    big = size * 4
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)
    if maskable:
        pen.rectangle((0, 0, big, big), fill=PLATE)
        scale, offset = 0.8, big * 0.1
    else:
        scale, offset = 1.0, 0.0
    inset = offset + big * 0.06 * scale
    side = big - 2 * inset
    if not maskable:
        pen.rounded_rectangle((inset, inset, inset + side, inset + side), radius=side * 0.22, fill=PLATE)
    bar = side * 0.07
    pen.rounded_rectangle(
        (inset + side * 0.2, inset + side * 0.78, inset + side * 0.8, inset + side * 0.78 + bar),
        radius=bar / 2,
        fill=ACCENT,
    )
    font = _font(int(side * 0.52))
    pen.text((big / 2, inset + side * 0.46), INITIAL, font=font, fill=INK, anchor="mm")
    return image.resize((size, size), Image.Resampling.LANCZOS)


def svg() -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="31" y="31" width="450" height="450" rx="99" fill="{PLATE}"/>
  <rect x="121" y="382" width="270" height="32" rx="16" fill="{ACCENT}"/>
  <text x="256" y="238" font-family="DejaVu Sans, Ubuntu, Liberation Sans, sans-serif"
        font-weight="700" font-size="234" fill="{INK}" text-anchor="middle"
        dominant-baseline="central">{INITIAL}</text>
</svg>
"""


def main() -> None:
    DESKTOP.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    for size in (48, 128, 256):
        draw(size).save(DESKTOP / f"{APP_ID}-{size}.png")
    (DESKTOP / f"{APP_ID}.svg").write_text(svg(), encoding="utf-8")
    draw(192).save(WEB / "icon-192.png")
    draw(512).save(WEB / "icon-512.png")
    draw(512, maskable=True).save(WEB / "icon-512-maskable.png")
    (WEB / "icon.svg").write_text(svg(), encoding="utf-8")
    print(f"icone scritte in {DESKTOP} e {WEB}")


if __name__ == "__main__":
    main()
