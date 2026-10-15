// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// «Rendi modificabile» (SPEC §7.5): a dense loop (a section, a drawing, a photo)
// becomes a spline of N control points fitted by least squares.
//
// 1. Corners: vertices where the outline turns by more than CORNER_DEG over a
//    short stretch (a trailing edge, the corner of a building) become fixed
//    control points marked as corners.
// 2. The other points are spread between the corners with a density that grows
//    with the square root of the curvature: many around a leading edge, few
//    along a flat side.
// 3. Each sample of the outline is tied to a parameter on a segment; with the
//    knots frozen the curve is linear in the control points (spline.ts), so
//    the points come from one linear least-squares solve. Then the knots and
//    the parameters (nearest point on the curve) are updated, and again.
import type { Pt } from './geometry'
import { evalSegment, sampleShape, segmentWeights, shapeSize, type SplineShape } from './spline'

export const DEFAULT_CONTROL_POINTS = 24
const CORNER_DEG = 50
const ITERATIONS = 12

export type FitResult = { shape: SplineShape; /** largest distance between outline and spline, metres */ maxError: number }

type Sample = { p: Pt; segment: number; u: number }

function cumulative(points: readonly Pt[]): number[] {
  const s = [0]
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1]
    const b = points[i % points.length]
    s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  return s
}

/** The point at arc length `s` (any real number: the loop wraps). */
function pointAt(points: readonly Pt[], cum: number[], s: number): Pt {
  const total = cum[cum.length - 1]
  const x = ((s % total) + total) % total
  let lo = 0
  let hi = points.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= x) lo = mid
    else hi = mid
  }
  const a = points[lo]
  const b = points[(lo + 1) % points.length]
  const f = (x - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-300)
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]
}

function turning(a: Pt, b: Pt, c: Pt): number {
  const ang = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])
  return Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)))
}

/**
 * Vertices where the outline turns sharply over a stretch of 1% of its length
 * and still does over a stretch eight times shorter: a tight curve (a leading
 * edge) turns less and less as the stretch shrinks, a corner does not.
 */
export function findCorners(points: readonly Pt[]): number[] {
  const cum = cumulative(points)
  const h = cum[cum.length - 1] * 0.01
  const turn = (i: number, span: number) =>
    turning(pointAt(points, cum, cum[i] - span), points[i], pointAt(points, cum, cum[i] + span))
  const angle = points.map((_, i) => turn(i, h))
  const limit = (CORNER_DEG * Math.PI) / 180
  const out: number[] = []
  points.forEach((_, i) => {
    if (angle[i] <= limit || turn(i, h / 8) < 0.6 * angle[i]) return
    // Only the sharpest vertex of its neighbourhood.
    for (let k = 0; k < points.length; k++) {
      if (k === i) continue
      const d = Math.min(Math.abs(cum[k] - cum[i]), cum[cum.length - 1] - Math.abs(cum[k] - cum[i]))
      if (d < h && (angle[k] > angle[i] || (angle[k] === angle[i] && k < i))) return
    }
    out.push(i)
  })
  return out
}

function solve(a: number[][], b: number[][]): number[][] {
  // Gaussian elimination with partial pivoting; b has one column per coordinate.
  const n = a.length
  const m = a.map((row, i) => [...row, ...b[i]])
  const cols = b[0].length
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    const d = m[c][c] || 1e-300
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r][c] / d
      if (f === 0) continue
      for (let k = c; k < n + cols; k++) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row, i) => row.slice(n).map((v) => v / (m[i][i] || 1e-300)))
}

/** Least-squares spline through `n` control points for a dense closed outline. */
export function fitSpline(outline: readonly Pt[], n = DEFAULT_CONTROL_POINTS): FitResult {
  const cum = cumulative(outline)
  const total = cum[cum.length - 1]
  const cornerIdx = findCorners(outline).slice(0, Math.max(0, n - 3))
  // Samples: uniform in arc length, with every corner exactly on a sample.
  const count = Math.max(400, 20 * n)
  const anchors = cornerIdx.length ? cornerIdx.map((i) => cum[i]) : [0]
  const pieces = anchors.map((s, k) => {
    const end = k + 1 < anchors.length ? anchors[k + 1] : anchors[0] + total
    return { start: s, length: end - s }
  })
  const samples: { p: Pt; s: number; piece: number }[] = []
  pieces.forEach((piece, k) => {
    const m = Math.max(4, Math.round((count * piece.length) / total))
    for (let j = 0; j < m; j++) {
      const s = piece.start + (piece.length * j) / m
      samples.push({ p: j === 0 && cornerIdx.length ? outline[cornerIdx[k]] : pointAt(outline, cum, s), s, piece: k })
    }
  })
  // Density for the free control points: sqrt of curvature, smoothed, plus a floor.
  const M = samples.length
  const step = total / M
  const kappa = samples.map((_, j) => turning(samples[(j - 1 + M) % M].p, samples[j].p, samples[(j + 1) % M].p) / step)
  const window = Math.max(1, Math.round(M * 0.01))
  const density = kappa.map((_, j) => {
    let sum = 0
    for (let k = -window; k <= window; k++) sum += Math.sqrt(kappa[(j + k + M) % M] * total)
    return sum / (2 * window + 1) + 2
  })
  // Free points per piece in proportion to its share of the density.
  const free = n - cornerIdx.length
  const pieceDensity = pieces.map((_, k) => samples.reduce((s, q, j) => (q.piece === k ? s + density[j] : s), 0))
  const all = pieceDensity.reduce((a, b) => a + b, 0)
  let quota = pieceDensity.map((d) => (free * d) / all)
  const counts = quota.map(Math.floor)
  let left = free - counts.reduce((a, b) => a + b, 0)
  quota = quota.map((q, k) => q - counts[k])
  while (left-- > 0) {
    const k = quota.indexOf(Math.max(...quota))
    counts[k]++
    quota[k] = -1
  }
  // Control points sit on samples, at equal steps of cumulative density: after
  // the corner that opens each piece, or spread over the whole loop if none.
  const controlAt: number[] = []
  const corners: boolean[] = []
  pieces.forEach((_, k) => {
    const idx = samples.map((q, j) => (q.piece === k ? j : -1)).filter((j) => j >= 0)
    if (cornerIdx.length) {
      controlAt.push(idx[0])
      corners.push(true)
    }
    const sum = idx.reduce((acc, j) => acc + density[j], 0)
    const targets = Array.from({ length: counts[k] }, (_, r) =>
      cornerIdx.length ? (sum * (r + 1)) / (counts[k] + 1) : (sum * (r + 0.5)) / counts[k],
    )
    let acc = 0
    let next = 0
    for (const j of idx) {
      acc += density[j]
      if (next < targets.length && acc >= targets[next]) {
        if (j !== controlAt[controlAt.length - 1]) {
          controlAt.push(j)
          corners.push(false)
        }
        next++
      }
    }
  })
  const controls: Pt[] = controlAt.map((j) => [...samples[j].p] as Pt)
  const K = controls.length
  const fixed = corners
  // Tie samples to segments by position, with the arc fraction as first parameter.
  const tied: Sample[] = []
  for (let k = 0; k < K; k++) {
    const a = controlAt[k]
    const b = controlAt[(k + 1) % K]
    const span = (b - a + M) % M || M
    for (let r = 0; r < span; r++) tied.push({ p: samples[(a + r) % M].p, segment: k, u: r / span })
  }
  let shape: SplineShape = { kind: 'spline', points: controls, corners: fixed }
  // Column of each control point in the system; corners are fixed (-1).
  const unknown: number[] = []
  let u = 0
  for (const corner of fixed) unknown.push(corner ? -1 : u++)
  for (let iter = 0; iter < ITERATIONS && u > 0; iter++) {
    const ata = Array.from({ length: u }, () => new Array<number>(u).fill(0))
    const atb = Array.from({ length: u }, () => [0, 0])
    for (const s of tied) {
      const weights = segmentWeights(shape, s.segment, s.u)
      let rx = s.p[0]
      let ry = s.p[1]
      for (const { index, weight } of weights) {
        if (unknown[index] < 0) {
          rx -= weight * shape.points[index][0]
          ry -= weight * shape.points[index][1]
        }
      }
      for (const a of weights) {
        const ia = unknown[a.index]
        if (ia < 0) continue
        atb[ia][0] += a.weight * rx
        atb[ia][1] += a.weight * ry
        for (const b of weights) {
          const ib = unknown[b.index]
          if (ib >= 0) ata[ia][ib] += a.weight * b.weight
        }
      }
    }
    const trace = ata.reduce((s, row, i) => s + row[i], 0)
    ata.forEach((row, i) => (row[i] += (1e-10 * trace) / u))
    const x = solve(ata, atb)
    const points = shape.points.map((p, k) => (unknown[k] >= 0 ? (x[unknown[k]] as Pt) : p))
    shape = { ...shape, points }
    for (const s of tied) s.u = nearestParameter(shape, s.segment, s.p, s.u)
  }
  return { shape, maxError: hausdorff(outline, sampleShape(shape, shapeSize(shape) * 1e-5).points) }
}

function nearestParameter(shape: SplineShape, segment: number, p: Pt, start: number): number {
  let u = start
  for (let k = 0; k < 6; k++) {
    const h = 1e-4
    const c = evalSegment(shape, segment, u)
    const c1 = evalSegment(shape, segment, Math.min(1, u + h))
    const c0 = evalSegment(shape, segment, Math.max(0, u - h))
    const span = Math.min(1, u + h) - Math.max(0, u - h)
    const dx = (c1[0] - c0[0]) / span
    const dy = (c1[1] - c0[1]) / span
    const ddx = (c1[0] - 2 * c[0] + c0[0]) / (h * h)
    const ddy = (c1[1] - 2 * c[1] + c0[1]) / (h * h)
    const g = (c[0] - p[0]) * dx + (c[1] - p[1]) * dy
    const H = dx * dx + dy * dy + (c[0] - p[0]) * ddx + (c[1] - p[1]) * ddy
    const next = Math.min(1, Math.max(0, u - g / (H > 0 ? H : dx * dx + dy * dy || 1)))
    if (Math.abs(next - u) < 1e-9) return next
    u = next
  }
  return u
}

function pointSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Largest distance from a point of one closed polyline to the other, both ways. */
export function hausdorff(a: readonly Pt[], b: readonly Pt[]): number {
  const oneWay = (from: readonly Pt[], to: readonly Pt[]) => {
    let worst = 0
    for (const p of from) {
      let best = Infinity
      for (let i = 0; i < to.length; i++) {
        const d = pointSegment(p, to[i], to[(i + 1) % to.length])
        if (d < best) best = d
        if (best <= worst) break // cannot raise the maximum
      }
      if (best > worst) worst = best
    }
    return worst
  }
  return Math.max(oneWay(a, b), oneWay(b, a))
}

