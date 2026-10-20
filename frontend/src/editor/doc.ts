// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The profile editor's document (SPEC §7.5) and every change to it, as pure
// functions: each returns a new document, so undo and redo are a stack of
// snapshots (History) and the screen is a view of the present one.
//
// A loop is a spline or a polyline of control points (spline.ts), or a dense
// "raw" outline from an import, not editable until «Rendi modificabile» fits a
// spline to it (fit.ts).
//
// Symmetric mode works on one loop about the chord line, taken horizontal at
// the height halfway between the leading edge (minimum x) and the trailing
// edge (maximum x). The loop is kept as: trailing edge, upper surface, leading
// edge, then the mirror of the upper surface; every edit is made on the upper
// half and the lower half is rebuilt from it. The two edges stay on the line.
import type { Profile2D, ProfileDraft, ProfileSource, SplineData } from '../lib/types'
import { boxOf, signedArea, type Pt } from '../profile/geometry'
import { fitSpline } from '../profile/fit'
import { evalSegment, sampleShape } from '../profile/spline'

export type ShapeLoop = {
  kind: 'spline' | 'polyline'
  points: Pt[]
  corners: boolean[]
  symmetricAxisY: number | null
}
export type RawLoop = { kind: 'raw'; points: Pt[] }
export type EditLoop = ShapeLoop | RawLoop
export type EditorDoc = { loops: EditLoop[] }

export const MIN_CONTROL_POINTS = 3

// --- conversion ------------------------------------------------------------------

export function loopOutline(loop: EditLoop): Pt[] {
  return loop.kind === 'raw' ? loop.points : sampleShape(loop).points
}

export function outlines(doc: EditorDoc): Pt[][] {
  return doc.loops.map(loopOutline)
}

export function docFromProfile(profile: Pick<Profile2D, 'loops' | 'spline'>): EditorDoc {
  return {
    loops: profile.loops.map((loop, i) => {
      const s = profile.spline?.loops[i]
      if (!s) return { kind: 'raw', points: loop.points.map(([x, y]) => [x, y] as Pt) }
      return {
        kind: s.kind,
        points: s.points.map(([x, y]) => [x, y] as Pt),
        corners: [...s.corners],
        symmetricAxisY: s.symmetric_axis_y,
      }
    }),
  }
}

export function docToDraft(doc: EditorDoc, name: string, source: ProfileSource): ProfileDraft {
  const spline: SplineData = {
    loops: doc.loops.map((l) =>
      l.kind === 'raw'
        ? null
        : { kind: l.kind, points: l.points, corners: l.corners, symmetric_axis_y: l.symmetricAxisY },
    ),
  }
  return {
    name,
    loops: outlines(doc).map((points) => ({ points })),
    source,
    spline: spline.loops.some(Boolean) ? spline : null,
  }
}

// --- edits -----------------------------------------------------------------------

function replaceLoop(doc: EditorDoc, index: number, loop: EditLoop): EditorDoc {
  return { loops: doc.loops.map((l, i) => (i === index ? loop : l)) }
}

function shapeAt(doc: EditorDoc, index: number): ShapeLoop {
  const loop = doc.loops[index]
  if (!loop || loop.kind === 'raw') throw new Error(`anello ${index} non modificabile`)
  return loop
}

/** Size of the upper half (trailing edge to leading edge, both included). */
function halfSize(loop: ShapeLoop): number {
  return loop.points.length / 2 + 1
}

/** The upper-half index that control point k is, or mirrors. */
function upperIndex(loop: ShapeLoop, k: number): { index: number; mirrored: boolean } {
  const m = halfSize(loop)
  return k < m ? { index: k, mirrored: false } : { index: 2 * m - 2 - k, mirrored: true }
}

function rebuildSymmetric(upper: Pt[], corners: boolean[], axis: number): { points: Pt[]; corners: boolean[] } {
  const m = upper.length
  const top = upper.map(([x, y], i) => (i === 0 || i === m - 1 ? ([x, axis] as Pt) : ([x, y] as Pt)))
  const points = [...top]
  const flags = [...corners]
  for (let i = m - 2; i >= 1; i--) {
    points.push([top[i][0], 2 * axis - top[i][1]])
    flags.push(corners[i])
  }
  return { points, corners: flags }
}

function withUpper(loop: ShapeLoop, edit: (upper: Pt[], corners: boolean[]) => void): ShapeLoop {
  const m = halfSize(loop)
  const upper = loop.points.slice(0, m).map(([x, y]) => [x, y] as Pt)
  const corners = loop.corners.slice(0, m)
  edit(upper, corners)
  return { ...loop, ...rebuildSymmetric(upper, corners, loop.symmetricAxisY as number) }
}

export function movePoint(doc: EditorDoc, li: number, k: number, to: Pt): EditorDoc {
  const loop = shapeAt(doc, li)
  if (loop.symmetricAxisY === null) {
    return replaceLoop(doc, li, { ...loop, points: loop.points.map((p, i) => (i === k ? to : p)) })
  }
  const axis = loop.symmetricAxisY
  const { index, mirrored } = upperIndex(loop, k)
  return replaceLoop(
    doc,
    li,
    withUpper(loop, (upper) => {
      upper[index] = mirrored ? [to[0], 2 * axis - to[1]] : to
    }),
  )
}

/** A new control point on the segment from point `after` to the next one. */
export function insertPoint(doc: EditorDoc, li: number, after: number, at: Pt): EditorDoc {
  const loop = shapeAt(doc, li)
  if (loop.symmetricAxisY === null) {
    const points = [...loop.points]
    const corners = [...loop.corners]
    points.splice(after + 1, 0, at)
    corners.splice(after + 1, 0, false)
    return replaceLoop(doc, li, { ...loop, points, corners })
  }
  const axis = loop.symmetricAxisY
  const m = halfSize(loop)
  const lower = after >= m - 1
  // A lower segment from j to j+1 mirrors the upper one ending at 2m-2-j.
  const position = lower ? 2 * m - 2 - after : after + 1
  const point: Pt = lower ? [at[0], 2 * axis - at[1]] : at
  return replaceLoop(
    doc,
    li,
    withUpper(loop, (upper, corners) => {
      upper.splice(position, 0, point)
      corners.splice(position, 0, false)
    }),
  )
}

/**
 * insertPoint, and the index the new point has in the loop: the one to keep
 * dragging when a click on the curve pulls a point out of it.
 */
export function insertPointAt(doc: EditorDoc, li: number, after: number, at: Pt): { doc: EditorDoc; k: number } {
  const loop = shapeAt(doc, li)
  const next = insertPoint(doc, li, after, at)
  if (loop.symmetricAxisY === null) return { doc: next, k: after + 1 }
  const m = halfSize(loop)
  if (after < m - 1) return { doc: next, k: after + 1 }
  // On the lower half the point is the mirror of a new upper one at 2m − 2 − after.
  const position = 2 * m - 2 - after
  return { doc: next, k: 2 * (m + 1) - 2 - position }
}

/**
 * Twice the control points, the shape kept: a new point at the middle of
 * every segment, on the curve (a polyline's segments stay straight; a spline
 * through more points of itself moves by a hair). In symmetric mode the upper
 * half is doubled and the lower one follows.
 */
export function densifyLoop(doc: EditorDoc, li: number): EditorDoc {
  const loop = shapeAt(doc, li)
  const n = loop.points.length
  const mid = (i: number): Pt => evalSegment(loop, i, 0.5)
  if (loop.symmetricAxisY === null) {
    const points: Pt[] = []
    const corners: boolean[] = []
    for (let i = 0; i < n; i++) {
      points.push(loop.points[i], mid(i))
      corners.push(loop.corners[i], false)
    }
    return replaceLoop(doc, li, { ...loop, points, corners })
  }
  const m = halfSize(loop)
  const middles = Array.from({ length: m - 1 }, (_, i) => mid(i))
  return replaceLoop(
    doc,
    li,
    withUpper(loop, (upper, corners) => {
      for (let i = m - 2; i >= 0; i--) {
        upper.splice(i + 1, 0, middles[i])
        corners.splice(i + 1, 0, false)
      }
    }),
  )
}

/** Distance from `p` to the closed polyline `ring`. */
function distanceToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy))
  }
  return best
}

/**
 * Fewer control points within `tolerance` (metres): the point whose removal
 * moves the curve least goes, again and again, while that stays under the
 * tolerance. Corners and the two ends of a symmetric loop stay. The curve is
 * measured where it changes: the old samples of the two segments around the
 * point, against the new curve.
 */
export function simplifyLoop(doc: EditorDoc, li: number, tolerance: number): { doc: EditorDoc; removed: number } {
  let current = doc
  let removed = 0
  for (;;) {
    const loop = shapeAt(current, li)
    const before = sampleShape(loop)
    const half = loop.symmetricAxisY === null ? loop.points.length : halfSize(loop)
    let best: { k: number; error: number; doc: EditorDoc } | null = null
    for (let k = 0; k < half; k++) {
      if (loop.corners[k] || !canDeletePoint(current, li, k)) continue
      const next = deletePoint(current, li, k)
      const ring = sampleShape(shapeAt(next, li)).points
      const n = loop.points.length
      const near = new Set([(k - 1 + n) % n, k])
      let error = 0
      before.points.forEach((p, i) => {
        if (near.has(before.segment[i])) error = Math.max(error, distanceToRing(p, ring))
      })
      if (error <= tolerance && (!best || error < best.error)) best = { k, error, doc: next }
    }
    if (!best) return { doc: current, removed }
    current = best.doc
    removed += loop.symmetricAxisY === null ? 1 : 2
  }
}

export function canDeletePoint(doc: EditorDoc, li: number, k: number): boolean {
  const loop = doc.loops[li]
  if (!loop || loop.kind === 'raw') return false
  if (loop.symmetricAxisY === null) return loop.points.length > MIN_CONTROL_POINTS
  const { index } = upperIndex(loop, k)
  return index !== 0 && index !== halfSize(loop) - 1 && halfSize(loop) > 3
}

export function deletePoint(doc: EditorDoc, li: number, k: number): EditorDoc {
  if (!canDeletePoint(doc, li, k)) return doc
  const loop = shapeAt(doc, li)
  if (loop.symmetricAxisY === null) {
    return replaceLoop(doc, li, {
      ...loop,
      points: loop.points.filter((_, i) => i !== k),
      corners: loop.corners.filter((_, i) => i !== k),
    })
  }
  const { index } = upperIndex(loop, k)
  return replaceLoop(
    doc,
    li,
    withUpper(loop, (upper, corners) => {
      upper.splice(index, 1)
      corners.splice(index, 1)
    }),
  )
}

export function toggleCorner(doc: EditorDoc, li: number, k: number): EditorDoc {
  const loop = shapeAt(doc, li)
  if (loop.symmetricAxisY === null) {
    return replaceLoop(doc, li, { ...loop, corners: loop.corners.map((c, i) => (i === k ? !c : c)) })
  }
  const { index } = upperIndex(loop, k)
  return replaceLoop(
    doc,
    li,
    withUpper(loop, (_upper, corners) => {
      corners[index] = !corners[index]
    }),
  )
}

export function setLoopKind(doc: EditorDoc, li: number, kind: ShapeLoop['kind']): EditorDoc {
  return replaceLoop(doc, li, { ...shapeAt(doc, li), kind })
}

export function addLoop(doc: EditorDoc, loop: EditLoop): EditorDoc {
  return { loops: [...doc.loops, loop] }
}

export function removeLoop(doc: EditorDoc, li: number): EditorDoc {
  return { loops: doc.loops.filter((_, i) => i !== li) }
}

/** A new spline loop: a circle of `n` points. */
export function circleLoop(cx: number, cy: number, r: number, n = 8): ShapeLoop {
  const points: Pt[] = Array.from({ length: n }, (_, k) => [
    cx + r * Math.cos((2 * Math.PI * k) / n),
    cy + r * Math.sin((2 * Math.PI * k) / n),
  ])
  return { kind: 'spline', points, corners: points.map(() => false), symmetricAxisY: null }
}

export function setSymmetric(doc: EditorDoc, li: number, on: boolean): EditorDoc {
  const loop = shapeAt(doc, li)
  if (!on) return replaceLoop(doc, li, { ...loop, symmetricAxisY: null })
  if (loop.symmetricAxisY !== null) return doc
  // Counter-clockwise, starting at the trailing edge: the run to the leading
  // edge is the upper surface.
  let points = loop.points
  let corners = loop.corners
  if (signedArea(points) < 0) {
    points = [...points].reverse()
    corners = [...corners].reverse()
  }
  const te = points.reduce((best, p, i) => (p[0] > points[best][0] ? i : best), 0)
  points = [...points.slice(te), ...points.slice(0, te)]
  corners = [...corners.slice(te), ...corners.slice(0, te)]
  const le = points.reduce((best, p, i) => (p[0] < points[best][0] ? i : best), 0)
  const axis = (points[0][1] + points[le][1]) / 2
  const upper = points.slice(0, le + 1)
  const upperCorners = corners.slice(0, le + 1)
  if (upper.length < 3) {
    // A shape with nothing between its two ends on top: add the middle point.
    const mid: Pt = [(upper[0][0] + upper[upper.length - 1][0]) / 2, axis + Math.abs(points[0][0] - points[le][0]) / 10]
    upper.splice(1, 0, mid)
    upperCorners.splice(1, 0, false)
  }
  return replaceLoop(doc, li, { ...loop, symmetricAxisY: axis, ...rebuildSymmetric(upper, upperCorners, axis) })
}

function mapPoints(doc: EditorDoc, f: (p: Pt) => Pt, axis: (y: number | null) => number | null): EditorDoc {
  return {
    loops: doc.loops.map((l) =>
      l.kind === 'raw'
        ? { ...l, points: l.points.map(f) }
        : { ...l, points: l.points.map(f), symmetricAxisY: axis(l.symmetricAxisY) },
    ),
  }
}

export function docCentre(doc: EditorDoc): Pt {
  const box = boxOf(outlines(doc))
  return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2]
}

export function scaleDoc(doc: EditorDoc, factor: number, about: Pt = docCentre(doc)): EditorDoc {
  const f = (p: Pt): Pt => [about[0] + factor * (p[0] - about[0]), about[1] + factor * (p[1] - about[1])]
  return mapPoints(doc, f, (y) => (y === null ? null : about[1] + factor * (y - about[1])))
}

/** Turn every loop by `angle` radians counter-clockwise; symmetric mode ends (the line tilts). */
export function rotateDoc(doc: EditorDoc, angle: number, about: Pt = docCentre(doc)): EditorDoc {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const f = (p: Pt): Pt => {
    const x = p[0] - about[0]
    const y = p[1] - about[1]
    return [about[0] + c * x - s * y, about[1] + s * x + c * y]
  }
  return mapPoints(doc, f, () => null)
}

export function translateDoc(doc: EditorDoc, dx: number, dy: number): EditorDoc {
  return mapPoints(doc, ([x, y]) => [x + dx, y + dy], (y) => (y === null ? null : y + dy))
}

/** «Rendi modificabile»: the loop becomes a spline of `n` control points. */
export function makeEditable(doc: EditorDoc, li: number, n: number): { doc: EditorDoc; maxError: number } {
  const fit = fitSpline(loopOutline(doc.loops[li]), n)
  return { doc: replaceLoop(doc, li, { ...fit.shape, symmetricAxisY: null }), maxError: fit.maxError }
}

// --- undo / redo -----------------------------------------------------------------

/** Snapshots of the document; at least 100 steps back (SPEC §7.5). */
export class History<T> {
  private past: T[] = []
  private future: T[] = []

  constructor(
    public present: T,
    private readonly limit = 200,
  ) {}

  push(next: T): void {
    if (next === this.present) return
    this.past.push(this.present)
    if (this.past.length > this.limit) this.past.shift()
    this.present = next
    this.future = []
  }

  /** Change the present without a new step (the moves of a drag after its first). */
  replace(next: T): void {
    this.present = next
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): T {
    const previous = this.past.pop()
    if (previous !== undefined) {
      this.future.push(this.present)
      this.present = previous
    }
    return this.present
  }

  redo(): T {
    const next = this.future.pop()
    if (next !== undefined) {
      this.past.push(this.present)
      this.present = next
    }
    return this.present
  }
}
