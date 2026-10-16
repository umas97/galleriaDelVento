# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""A photographed hand sketch → ``Profile2D`` (SPEC §8).

Four steps, one module each: ``paper`` (find and straighten the sheet),
``binarize`` (flatten the light, threshold, close gaps, drop specks),
``contour`` (fill the enclosed regions, take the stroke's middle line, smooth)
and ``pipeline`` (the steps chained, cached, and turned into a profile).

OpenCV is imported by those modules only: nothing here imports them, so the
program starts without OpenCV in memory (SPEC §17).
"""
