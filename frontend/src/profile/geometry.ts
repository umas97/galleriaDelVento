// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Plane geometry shared by validation, repair, the slicer and the editor.
// Nesting follows backend/gdv/geometry/profile.py exactly: a loop is inside
// another when every one of up to NESTING_SAMPLES of its vertices, evenly
// spread, is strictly inside it (even-odd rule); an even count of containing
// loops makes it an outer boundary (CCW once normalised), odd a hole (CW).
import type { Point2 } from '../lib/types'

export type Pt = Point2

/** Consecutive points closer than this (metres) are an error (SPEC §7.1). */
export const MIN_POINT_DISTANCE = 1e-6
export const MAX_LOOPS = 50
export const MAX_POINTS = 20_000
export const NESTING_SAMPLES = 16

/** Shoelace area: positive for counter-clockwise. */
export function signedArea(points: readonly Pt[]): number {
  const n = points.length
  if (n < 3) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % n]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

export function perimeter(points: readonly Pt[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    sum += Math.hypot(x1 - x0, y1 - y0)
  }
  return sum
}

/** All points on one line: the loop encloses nothing (a bow tie's shoelace sum cannot tell). */
export function isFlat(points: readonly Pt[], eps = MIN_POINT_DISTANCE): boolean {
  const [x0, y0] = points[0]
  let far = 0
  let best = -1
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - x0, points[i][1] - y0)
    if (d > best) {
      best = d
      far = i
    }
  }
  const ax = points[far][0] - x0
  const ay = points[far][1] - y0
  const length = Math.hypot(ax, ay)
  if (length <= eps) return true
  for (const [x, y] of points) {
    if (Math.abs((x - x0) * -ay + (y - y0) * ax) / length > eps) return false
  }
  return true
}

export type Box = { minX: number; minY: number; maxX: number; maxY: number }

export function boxOf(loops: readonly (readonly Pt[])[]): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const loop of loops)
    for (const [x, y] of loop) {
      if (x < box.minX) box.minX = x
      if (x > box.maxX) box.maxX = x
      if (y < box.minY) box.minY = y
      if (y > box.maxY) box.maxY = y
    }
  return box
}

/** Even-odd point in polygon; a point on the boundary may go either way. */
export function pointInPolygon(x: number, y: number, polygon: readonly Pt[]): boolean {
  let inside = false
  const n = polygon.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = polygon[i]
    const [bx, by] = polygon[(i + 1) % n]
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside
  }
  return inside
}

function samples(points: readonly Pt[]): Pt[] {
  const n = points.length
  if (n <= NESTING_SAMPLES) return [...points]
  const out: Pt[] = []
  for (let k = 0; k < NESTING_SAMPLES; k++) out.push(points[Math.floor((k * n) / NESTING_SAMPLES)])
  return out
}

/** How many other loops contain each loop (even = outer boundary, odd = hole). */
export function loopDepths(loops: readonly (readonly Pt[])[]): number[] {
  const boxes = loops.map((l) => boxOf([l]))
  return loops.map((inner, i) => {
    const sample = samples(inner)
    let depth = 0
    loops.forEach((outer, j) => {
      if (i === j || outer.length < 3) return
      const b = boxes[j]
      if (sample.some(([x, y]) => x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) return
      if (sample.every(([x, y]) => pointInPolygon(x, y, outer))) depth++
    })
    return depth
  })
}

/** Outer loops counter-clockwise, holes clockwise. Returns which loops were reversed. */
export function normaliseOrientation(loops: readonly Pt[][]): { loops: Pt[][]; reversed: boolean[] } {
  const depths = loopDepths(loops)
  const reversed = loops.map((loop, i) => signedArea(loop) > 0 === (depths[i] % 2 === 1))
  return { loops: loops.map((loop, i) => (reversed[i] ? [...loop].reverse() : loop)), reversed }
}

/** Drop consecutive points closer than `eps` (also between the last and the first). */
export function dedupe(points: readonly Pt[], eps = MIN_POINT_DISTANCE): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p)
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps)
    out.pop()
  return out
}

/** Rotate points by `angle` radians (counter-clockwise) about (cx, cy). */
export function rotatePoints(points: readonly Pt[], angle: number, cx: number, cy: number): Pt[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return points.map(([x, y]) => [cx + c * (x - cx) - s * (y - cy), cy + s * (x - cx) + c * (y - cy)])
}
