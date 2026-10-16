// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import type { SketchRegion } from '../src/lib/types'
import {
  fromFraction,
  insidePolygon,
  regionAt,
  toFraction,
  toggleRegion,
  weldFor,
  windAngle,
  windVector,
  type Pt,
} from '../src/sketch/geometry'

const square = (x: number, y: number, s: number): Pt[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
]

const region = (outline: Pt[], selected: boolean, seed: Pt): SketchRegion => ({ outline, selected, seed, fraction: 0.1 })

describe('sketch geometry', () => {
  it('finds the region under a click, the smallest when nested', () => {
    const regions = [region(square(0, 0, 100), true, [0.1, 0.1]), region(square(40, 40, 20), false, [0.5, 0.5])]
    expect(insidePolygon([50, 50], regions[0].outline)).toBe(true)
    expect(regionAt(regions, [50, 50])).toBe(1)
    expect(regionAt(regions, [10, 10])).toBe(0)
    expect(regionAt(regions, [150, 10])).toBe(-1)
  })

  it('toggles regions but never leaves none chosen', () => {
    const regions = [region(square(0, 0, 10), true, [0.1, 0.1]), region(square(20, 0, 10), false, [0.3, 0.1])]
    expect(toggleRegion(regions, 1)).toEqual([
      [0.1, 0.1],
      [0.3, 0.1],
    ])
    expect(toggleRegion(regions, 0)).toBeNull()
    const both = regions.map((r) => ({ ...r, selected: true }))
    expect(toggleRegion(both, 0)).toEqual([[0.3, 0.1]])
  })

  it('proposes a weld wider than the gap, at most 8%', () => {
    expect(weldFor({ a: [0, 0], b: [1, 1], fraction: 0.03 })).toBeGreaterThan(0.03)
    expect(weldFor({ a: [0, 0], b: [1, 1], fraction: 0.03 })).toBeLessThan(0.04)
    expect(weldFor({ a: [0, 0], b: [1, 1], fraction: 0.2 })).toBe(0.08)
  })

  it('turns the wind arrow on screen axes (y down)', () => {
    const [x, y] = windVector(90)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(-1) // up the sheet
    expect(windAngle([100, 100], [200, 100])).toBe(0)
    expect(windAngle([100, 100], [100, 0])).toBe(90)
    expect(windAngle([100, 100], [0, 100])).toBe(180)
    expect(windAngle([100, 100], [100, 200])).toBe(-90)
  })

  it('maps fractions both ways and clamps to the image', () => {
    expect(toFraction([50, 25], [100, 50])).toEqual([0.5, 0.5])
    expect(toFraction([-5, 70], [100, 50])).toEqual([0, 1])
    expect(fromFraction([0.25, 1], [100, 50])).toEqual([25, 50])
  })
})
