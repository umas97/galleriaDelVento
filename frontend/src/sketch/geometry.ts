// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The small geometry of the sketch wizard (SPEC §8): which region a click
// falls in, choosing regions, the weld that bridges a gap, the wind arrow.
// Positions sent to the server are fractions of an image; what is drawn is in
// that image's pixels (y down).
import type { Point2, SketchGap, SketchRegion } from '../lib/types'

export type Pt = Point2

/** Even-odd point in polygon. */
export function insidePolygon([x, y]: Pt, polygon: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function area(polygon: readonly Pt[]): number {
  let sum = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1]
  }
  return Math.abs(sum) / 2
}

/** The region under `point` (sheet pixels): the smallest that holds it, or -1. */
export function regionAt(regions: readonly SketchRegion[], point: Pt): number {
  let best = -1
  let bestArea = Infinity
  regions.forEach((region, i) => {
    if (!insidePolygon(point, region.outline)) return
    const a = area(region.outline)
    if (a < bestArea) {
      best = i
      bestArea = a
    }
  })
  return best
}

/**
 * The seeds after a click on region `index`: it is added if not chosen,
 * removed if it is. `null` when that would leave nothing chosen.
 */
export function toggleRegion(regions: readonly SketchRegion[], index: number): Pt[] | null {
  const chosen = regions.map((r, i) => (i === index ? !r.selected : r.selected))
  if (!chosen.some(Boolean)) return null
  return regions.filter((_, i) => chosen[i]).map((r) => r.seed)
}

/** «Chiusura varchi» that safely bridges `gap` (fraction of the sheet's width), at most 8%. */
export function weldFor(gap: SketchGap): number {
  return Math.min(0.08, Math.ceil(gap.fraction * 1.2 * 1000) / 1000 + 0.002)
}

export const IMAGE_CORNERS: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/** Unit vector of the wind on screen (y down) for `deg` counter-clockwise from left-to-right. */
export function windVector(deg: number): Pt {
  const a = (deg * Math.PI) / 180
  return [Math.cos(a), -Math.sin(a)]
}

/** The wind angle pointing from `centre` to `point` (screen axes): degrees in (-180, 180], one decimal. */
export function windAngle(centre: Pt, point: Pt): number {
  const deg = Math.round((Math.atan2(-(point[1] - centre[1]), point[0] - centre[0]) * 1800) / Math.PI) / 10
  return deg <= -180 ? deg + 360 : deg + 0 // and no -0 in a field the user reads
}

export const toFraction = ([x, y]: Pt, [w, h]: readonly [number, number]): Pt => [
  Math.min(1, Math.max(0, x / w)),
  Math.min(1, Math.max(0, y / h)),
]

export const fromFraction = ([x, y]: Pt, [w, h]: readonly [number, number]): Pt => [x * w, y * h]
