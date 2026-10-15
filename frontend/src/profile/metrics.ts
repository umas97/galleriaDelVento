// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the editor shows next to the drawing (SPEC §7.5): chord, maximum
// thickness and where it is, area, perimeter. Chord is the extent along x
// (the wind at zero incidence); thickness at x is the height between the
// lowest and the highest crossing of the vertical line x with the outlines.
import { loopDepths, perimeter, signedArea, type Pt } from './geometry'

export type ProfileMetrics = {
  chord: number
  thickness: number
  /** Position of the maximum thickness as a fraction of the chord, from the front. */
  thicknessAt: number
  area: number
  perimeter: number
}

const STATIONS = 400

export function profileMetrics(loops: readonly Pt[][]): ProfileMetrics {
  const usable = loops.filter((l) => l.length >= 3)
  if (!usable.length) return { chord: 0, thickness: 0, thicknessAt: 0, area: 0, perimeter: 0 }
  const depths = loopDepths(usable)
  const outer = usable.filter((_, i) => depths[i] % 2 === 0)
  let minX = Infinity
  let maxX = -Infinity
  for (const loop of outer)
    for (const [x] of loop) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
  const chord = maxX - minX
  let thickness = 0
  let thicknessAt = 0
  for (let k = 1; k < STATIONS; k++) {
    const x = minX + (chord * k) / STATIONS
    let lo = Infinity
    let hi = -Infinity
    for (const loop of outer)
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]
        const b = loop[(i + 1) % loop.length]
        if (a[0] > x === b[0] > x) continue
        const y = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0])
        lo = Math.min(lo, y)
        hi = Math.max(hi, y)
      }
    if (hi - lo > thickness) {
      thickness = hi - lo
      thicknessAt = k / STATIONS
    }
  }
  const area = usable.reduce((s, l, i) => s + (depths[i] % 2 === 0 ? 1 : -1) * Math.abs(signedArea(l)), 0)
  return { chord, thickness, thicknessAt, area, perimeter: usable.reduce((s, l) => s + perimeter(l), 0) }
}
