// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Closed centripetal Catmull-Rom splines (SPEC §7.5). The curve passes through
// every control point; between P1 and P2 it is shaped by P0 and P3, with knots
// spaced by the square root of the distances (centripetal: no cusps, no loops
// on uneven spacing). A control point marked as a corner ends the curve on each
// side as if it were an endpoint: the neighbour beyond it is replaced by its
// mirror image (2·P1 - P2), so the tangent there points along the chord and
// the two sides meet at an angle. A polyline is a spline made of corners only.
//
// For a fixed set of knots the curve is linear in the control points, which is
// what the least-squares fit in fit.ts relies on: `segmentWeights` returns the
// coefficients of P0..P3 (corner mirrors already folded in).
import type { Pt } from './geometry'

export type SplineShape = {
  kind: 'spline' | 'polyline'
  points: Pt[]
  corners: boolean[]
}

/** Sampling: chord error at most this fraction of the loop's size (SPEC §7.5). */
export const CHORD_ERROR = 2e-4
const MIN_KNOT = 1e-12

export function isCorner(shape: SplineShape, i: number): boolean {
  return shape.kind === 'polyline' || shape.corners[i]
}

type Knots = { t0: number; t1: number; t2: number; t3: number }

function knotsOf(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Knots {
  const d = (a: Pt, b: Pt) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), MIN_KNOT)
  const t1 = d(p0, p1)
  const t2 = t1 + d(p1, p2)
  return { t0: 0, t1, t2, t3: t2 + d(p2, p3) }
}

/** The four control points of segment i (from point i to point i+1), corner mirrors applied. */
export function segmentPoints(shape: SplineShape, i: number): [Pt, Pt, Pt, Pt] {
  const n = shape.points.length
  const p1 = shape.points[i]
  const p2 = shape.points[(i + 1) % n]
  const p0: Pt = isCorner(shape, i) ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : shape.points[(i - 1 + n) % n]
  const p3: Pt = isCorner(shape, (i + 1) % n) ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : shape.points[(i + 2) % n]
  return [p0, p1, p2, p3]
}

/** Barry-Goldman pyramid: coefficients of P0..P3 at local parameter u in [0, 1]. */
function pyramid(k: Knots, u: number): [number, number, number, number] {
  const { t0, t1, t2, t3 } = k
  const t = t1 + u * (t2 - t1)
  // A1 = a0 P0 + a1 P1, A2 = b1 P1 + b2 P2, A3 = c2 P2 + c3 P3
  const a0 = (t1 - t) / (t1 - t0)
  const a1 = (t - t0) / (t1 - t0)
  const b1 = (t2 - t) / (t2 - t1)
  const b2 = (t - t1) / (t2 - t1)
  const c2 = (t3 - t) / (t3 - t2)
  const c3 = (t - t2) / (t3 - t2)
  // B1 = d1 A1 + d2 A2, B2 = e2 A2 + e3 A3
  const d1 = (t2 - t) / (t2 - t0)
  const d2 = (t - t0) / (t2 - t0)
  const e2 = (t3 - t) / (t3 - t1)
  const e3 = (t - t1) / (t3 - t1)
  // C = f1 B1 + f2 B2
  const f1 = (t2 - t) / (t2 - t1)
  const f2 = (t - t1) / (t2 - t1)
  return [
    f1 * d1 * a0,
    f1 * (d1 * a1 + d2 * b1) + f2 * e2 * b1,
    f1 * d2 * b2 + f2 * (e2 * b2 + e3 * c2),
    f2 * e3 * c3,
  ]
}

/**
 * Coefficients of the control points (indices into shape.points) for the point
 * at parameter u of segment i, with corner mirrors folded in.
 */
export function segmentWeights(shape: SplineShape, i: number, u: number): { index: number; weight: number }[] {
  const n = shape.points.length
  const [p0, p1, p2, p3] = segmentPoints(shape, i)
  const w = pyramid(knotsOf(p0, p1, p2, p3), u)
  const i0 = (i - 1 + n) % n
  const i1 = i
  const i2 = (i + 1) % n
  const i3 = (i + 2) % n
  const out = new Map<number, number>()
  const add = (index: number, weight: number) => out.set(index, (out.get(index) ?? 0) + weight)
  if (isCorner(shape, i1)) {
    add(i1, 2 * w[0])
    add(i2, -w[0])
  } else add(i0, w[0])
  add(i1, w[1])
  add(i2, w[2])
  if (isCorner(shape, i2)) {
    add(i2, 2 * w[3])
    add(i1, -w[3])
  } else add(i3, w[3])
  return [...out].map(([index, weight]) => ({ index, weight }))
}

export function evalSegment(shape: SplineShape, i: number, u: number): Pt {
  const [p0, p1, p2, p3] = segmentPoints(shape, i)
  const w = pyramid(knotsOf(p0, p1, p2, p3), u)
  return [
    w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
    w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
  ]
}

export function shapeSize(shape: SplineShape): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of shape.points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return Math.max(maxX - minX, maxY - minY)
}

export type Sampled = { points: Pt[]; /** segment index of each sample */ segment: number[] }

/**
 * The loop as a polygon: each segment bisected until its chords stay within
 * `tolerance` of the curve (checked at the middle and the quarters). Straight
 * segments between corners give their two ends only.
 */
export function sampleShape(shape: SplineShape, tolerance = CHORD_ERROR * shapeSize(shape)): Sampled {
  const n = shape.points.length
  const points: Pt[] = []
  const segment: number[] = []
  const tol = Math.max(tolerance, 1e-12)
  for (let i = 0; i < n; i++) {
    const at = (u: number) => evalSegment(shape, i, u)
    const recurse = (u0: number, p0: Pt, u1: number, p1: Pt, level: number) => {
      const um = (u0 + u1) / 2
      const pm = at(um)
      const dev = (p: Pt, a: Pt, b: Pt, f: number) => Math.hypot(p[0] - (a[0] + f * (b[0] - a[0])), p[1] - (a[1] + f * (b[1] - a[1])))
      const flat =
        dev(pm, p0, p1, 0.5) <= tol &&
        dev(at((3 * u0 + u1) / 4), p0, p1, 0.25) <= tol &&
        dev(at((u0 + 3 * u1) / 4), p0, p1, 0.75) <= tol
      if (level >= 12 || (level >= 1 && flat) || (level === 0 && flat && isStraight(shape, i))) {
        points.push(p0)
        segment.push(i)
        return
      }
      recurse(u0, p0, um, pm, level + 1)
      recurse(um, pm, u1, p1, level + 1)
    }
    recurse(0, shape.points[i], 1, shape.points[(i + 1) % n], 0)
  }
  return { points, segment }
}

/** Both ends are corners: the segment is the straight line between them. */
function isStraight(shape: SplineShape, i: number): boolean {
  return isCorner(shape, i) && isCorner(shape, (i + 1) % shape.points.length)
}
