// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The automatic repairer of live sections (SPEC §7.2 #6): a cut through a scan
// can give loops that cross themselves or each other. Every loop is oriented by
// nesting (outer CCW, holes CW), then Clipper2 unites them all with the NonZero
// fill rule -- crossings resolved, overlaps merged, holes kept -- and pieces
// smaller than `minArea` (4 cells) are dropped. Test 9 checks it against
// shapely.make_valid + union in the backend.
//
// Clipper works on integers: coordinates are scaled so that the largest is
// 2^25. Products of two of them stay below 2^53, so Clipper's arithmetic in
// doubles stays exact, and the step is 1/33 millionth of the section's size.
import { FillRule, union, type Path64 } from 'clipper2-ts'
import { dedupe, isFlat, normaliseOrientation, signedArea, type Pt } from './geometry'
import { selfIntersection } from './validate'

const RANGE = 2 ** 25

export type RepairResult = { loops: Pt[][]; dropped: number }

export function repairLoops(loops: readonly (readonly Pt[])[], minArea = 0): RepairResult {
  const usable = loops.map((l) => dedupe(l)).filter((l) => l.length >= 3 && !isFlat(l))
  if (!usable.length) return { loops: [], dropped: 0 }
  const oriented = normaliseOrientation(usable).loops
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const loop of oriented)
    for (const [x, y] of loop) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const scale = RANGE / Math.max((maxX - minX) / 2, (maxY - minY) / 2, 1e-12)
  const paths: Path64[] = oriented.map((loop) =>
    loop.map(([x, y]) => ({ x: Math.round((x - cx) * scale), y: Math.round((y - cy) * scale) })),
  )
  const merged = union(paths, FillRule.NonZero).flatMap(splitPinches)
  const out: Pt[][] = []
  let dropped = 0
  for (const path of merged) {
    const loop = dedupe(path.map((p) => [p.x / scale + cx, p.y / scale + cy] as Pt))
    if (loop.length < 3) continue
    if (Math.abs(signedArea(loop)) < minArea) {
      dropped++
      continue
    }
    out.push(loop)
  }
  // A hole is smaller than its boundary, so it never outlives it here.
  return { loops: normaliseOrientation(out).loops, dropped }
}

/**
 * Clipper's rings may touch themselves at a vertex (a pinch: two lobes meeting
 * at a point, possibly in the middle of a side). Such a ring is not simple, so
 * it is cut there into rings that are. Exact: the coordinates are integers.
 */
export function splitPinches(path: Path64): Path64[] {
  const pts = path.map((p) => [p.x, p.y] as Pt)
  if (pts.length < 4 || !selfIntersection(pts)) return [path]
  // 1. A vertex lying inside a side that is not its own becomes a vertex of it too.
  const ring: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    ring.push(a)
    const inside: Pt[] = []
    for (let k = 0; k < pts.length; k++) {
      const v = pts[k]
      if (k === i || k === (i + 1) % pts.length) continue
      const cross = (b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])
      const dot = (v[0] - a[0]) * (b[0] - a[0]) + (v[1] - a[1]) * (b[1] - a[1])
      const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
      if (cross === 0 && dot > 0 && dot < len2) inside.push(v)
    }
    inside.sort((u, v) => Math.hypot(u[0] - a[0], u[1] - a[1]) - Math.hypot(v[0] - a[0], v[1] - a[1]))
    ring.push(...inside)
  }
  // 2. Walk the ring; coming back to a vertex already on the stack closes a sub-ring.
  const out: Path64[] = []
  const stack: Pt[] = []
  const seen = new Map<string, number>()
  for (const p of ring) {
    const key = `${p[0]},${p[1]}`
    const at = seen.get(key)
    if (at !== undefined) {
      const sub = stack.splice(at + 1)
      for (const q of sub) seen.delete(`${q[0]},${q[1]}`)
      if (sub.length >= 2) out.push([stack[at], ...sub].map(([x, y]) => ({ x, y })))
      continue
    }
    seen.set(key, stack.length)
    stack.push(p)
  }
  if (stack.length >= 3) out.push(stack.map(([x, y]) => ({ x, y })))
  return out
}
