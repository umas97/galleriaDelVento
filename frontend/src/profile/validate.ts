// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The fast twin of profile.validate in the backend (SPEC §7.1, test 9): same
// codes, same order, one issue per loop -- too few points, points too close,
// flat (zero area), self-intersection. Live sections are checked here on every
// cut, so the ring test uses a uniform grid: each segment is tested only
// against the segments that share a cell with it.
import type { Issue, ValidationReport } from '../lib/types'
import { MAX_LOOPS, MAX_POINTS, MIN_POINT_DISTANCE, isFlat, type Pt } from './geometry'

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  )
}

/** Closed segments ab and cd share at least one point. */
export function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  )
}

/** Where the closed ring touches or crosses itself, or null if it is simple. */
export function selfIntersection(points: readonly Pt[]): Pt | null {
  const n = points.length
  // Two consecutive segments share their vertex; they are wrong only if the
  // second turns straight back over the first.
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const c = points[(i + 2) % n]
    if (orient(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) return b
  }
  if (n < 4) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const w = maxX - minX || 1e-12
  const h = maxY - minY || 1e-12
  // About one segment per cell, shaped like the bounding box.
  const nx = Math.max(1, Math.min(2048, Math.ceil(Math.sqrt((n * w) / h))))
  const ny = Math.max(1, Math.min(2048, Math.ceil(Math.sqrt((n * h) / w))))
  const cells = new Map<number, number[]>()
  const cellX = (x: number) => Math.min(nx - 1, Math.floor(((x - minX) / w) * nx))
  const cellY = (y: number) => Math.min(ny - 1, Math.floor(((y - minY) / h) * ny))
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const x0 = cellX(Math.min(a[0], b[0]))
    const x1 = cellX(Math.max(a[0], b[0]))
    const y0 = cellY(Math.min(a[1], b[1]))
    const y1 = cellY(Math.max(a[1], b[1]))
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx * ny + cy
        const list = cells.get(key)
        if (list) list.push(i)
        else cells.set(key, [i])
      }
  }
  for (const list of cells.values()) {
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p]
        const j = list[q]
        const gap = Math.abs(i - j)
        if (gap === 1 || gap === n - 1) continue // neighbours: checked above
        const a = points[i]
        const b = points[(i + 1) % n]
        const c = points[j]
        const d = points[(j + 1) % n]
        if (segmentsTouch(a, b, c, d)) return intersectionPoint(a, b, c, d)
      }
  }
  return null
}

function intersectionPoint(a: Pt, b: Pt, c: Pt, d: Pt): Pt {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
  if (den === 0) {
    // Collinear overlap: any shared endpoint will do.
    for (const p of [c, d]) if (onSegment(a, b, p)) return p
    return a
  }
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
}

export function validateLoops(loops: readonly (readonly Pt[])[]): ValidationReport {
  const issues: Issue[] = []
  if (!loops.length) issues.push({ code: 'no_loops', loop: null, at: null })
  if (loops.length > MAX_LOOPS) issues.push({ code: 'too_many_loops', loop: null, at: null })
  if (loops.reduce((sum, l) => sum + l.length, 0) > MAX_POINTS)
    issues.push({ code: 'too_many_points', loop: null, at: null })
  loops.forEach((p, i) => {
    if (p.length < 3) {
      issues.push({ code: 'too_few_points', loop: i, at: null })
      return
    }
    for (let k = 0; k < p.length; k++) {
      const q = p[(k + 1) % p.length]
      if (Math.hypot(q[0] - p[k][0], q[1] - p[k][1]) <= MIN_POINT_DISTANCE) {
        issues.push({ code: 'points_too_close', loop: i, at: [p[k][0], p[k][1]] })
        return
      }
    }
    if (isFlat(p)) {
      issues.push({ code: 'zero_area', loop: i, at: null })
      return
    }
    const at = selfIntersection(p)
    if (at) issues.push({ code: 'self_intersection', loop: i, at })
  })
  return { valid: issues.length === 0, issues }
}
