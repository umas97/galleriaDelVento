// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cutting a section out of the full mesh (SPEC §7.2), the pure part: the worker
// (slicer.worker.ts) only moves messages.
//
// Index. For the current plane normal every vertex gets its depth and its two
// profile coordinates (one dot product each, see frame.ts); every triangle its
// minimum and maximum depth. Triangles are sorted by minimum (radix sort on
// float32 keys) with the running maximum alongside, so a cut at depth d scans
// only from the first triangle whose running maximum reaches d to the last one
// whose minimum is below d. The index changes only with the two rotations that
// change the section; while one of them is dragged it is built on a sample of at
// most PREVIEW_TRIANGLES triangles, and again on the full mesh at release.
//
// Cut. A vertex counts as above the plane when its depth is >= d, below
// otherwise: every triangle then crosses with exactly two edges or not at all,
// and the point on an edge is interpolated from its lower-numbered vertex, so
// the two triangles sharing the edge produce the very same point. Segments are
// chained into loops (loops.ts) by the edge they end on -- exact, and a sort
// rather than a spatial search; ends left free (vertices not shared) are
// joined by distance, then open ends nearer than 1% of the section (a mesh
// with gaps). What stays open is reported, loops are simplified to half a cell,
// slivers under 4 cells dropped, and an invalid result goes through the
// automatic repairer (repair.ts).
import { boxOf, normaliseOrientation, type Box, type Pt } from '../profile/geometry'
import { repairLoops } from '../profile/repair'
import { validateLoops } from '../profile/validate'
import type { Issue } from '../lib/types'
import { planeAxes, projectionAxes, type SliceAttitude, type Vec3 } from './frame'
import { chainByKeys, chainPieces, flatArea, simplifyLoop, type Flat } from './loops'

export const PREVIEW_TRIANGLES = 200_000
/** Segment ends closer than this fraction of the mesh diagonal are the same point. */
export const JOIN_FRACTION = 1e-6
/** Free ends closer than this fraction of the section's size are joined (SPEC §7.2 #4). */
export const GAP_FRACTION = 0.01
/** Loops smaller than this many cells are slivers (SPEC §7.2 #6). */
export const MIN_AREA_CELLS = 4

export type IndexInfo = {
  triangles: number
  /** Triangles in the index: all of them, or a sample while dragging. */
  indexed: number
  /** Depth range of the rotated model along the plane normal. */
  depthMin: number
  depthMax: number
  /** Profile-plane box of the rotated model over every depth (camera sizing, SPEC §9.2). */
  envelope: Box
  ms: number
}

export type CutResult = {
  /** Closed loops in profile coordinates (metres), outer CCW, holes CW. */
  loops: Pt[][]
  /** The loops before the automatic repair, when there was one (for the save dialog). */
  rawLoops: Pt[][] | null
  repaired: boolean
  issues: Issue[]
  /** Open chains that could not be closed: drawn in red, left out of the profile. */
  open: Pt[][]
  /** Loops dropped as slivers (< 4 cells). */
  droppedSmall: number
  segments: number
  ms: number
}

function sortableKeys(values: Float32Array): Uint32Array {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length)
  const keys = new Uint32Array(values.length)
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i]
    keys[i] = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0
  }
  return keys
}

/** Indices that sort `values` ascending: LSD radix sort, two 16-bit passes. */
export function argsortFloat32(values: Float32Array): Uint32Array {
  const n = values.length
  const keys = sortableKeys(values)
  let order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  let next = new Uint32Array(n)
  const counts = new Uint32Array(65536)
  for (const shift of [0, 16]) {
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[(keys[order[i]] >>> shift) & 0xffff]++
    let sum = 0
    for (let b = 0; b < 65536; b++) {
      const c = counts[b]
      counts[b] = sum
      sum += c
    }
    for (let i = 0; i < n; i++) {
      const o = order[i]
      next[counts[(keys[o] >>> shift) & 0xffff]++] = o
    }
    ;[order, next] = [next, order]
  }
  return order
}

function flatToPts(f: Flat): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < f.length; i += 2) pts.push([f[i], f[i + 1]])
  return pts
}

/** First index in a non-decreasing array whose value is >= x. */
function lowerBound(a: Float32Array, x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class SliceIndex {
  readonly info: IndexInfo
  private readonly depth: Float64Array
  private readonly px: Float64Array
  private readonly py: Float64Array
  private readonly order: Uint32Array
  private readonly sortedMin: Float32Array
  private readonly sortedMax: Float32Array
  private readonly runningMax: Float32Array
  /** Float32 keys are rounded: a cut scans this much wider and tests exactly. */
  private readonly margin: number
  private readonly diagonal: number
  private readonly vertexCount: number

  constructor(
    positions: Float32Array,
    private readonly indices: Uint32Array,
    centre: Vec3,
    readonly attitude: SliceAttitude,
    maxTriangles = Infinity,
  ) {
    const start = performance.now()
    const nv = positions.length / 3
    this.vertexCount = nv
    const nt = indices.length / 3
    const { normal, x, up } = projectionAxes(attitude)
    const { normalAxis, upAxis } = planeAxes(attitude.plane)
    this.depth = new Float64Array(nv)
    this.px = new Float64Array(nv)
    this.py = new Float64Array(nv)
    const envelope = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (let v = 0; v < nv; v++) {
      const dx = positions[3 * v] - centre[0]
      const dy = positions[3 * v + 1] - centre[1]
      const dz = positions[3 * v + 2] - centre[2]
      this.depth[v] = dx * normal[0] + dy * normal[1] + dz * normal[2] + centre[normalAxis]
      const X = dx * x[0] + dy * x[1] + dz * x[2] + centre[0]
      const Y = dx * up[0] + dy * up[1] + dz * up[2] + centre[upAxis]
      this.px[v] = X
      this.py[v] = Y
      if (X < envelope.minX) envelope.minX = X
      if (X > envelope.maxX) envelope.maxX = X
      if (Y < envelope.minY) envelope.minY = Y
      if (Y > envelope.maxY) envelope.maxY = Y
    }
    const stride = Math.max(1, Math.ceil(nt / maxTriangles))
    const count = Math.ceil(nt / stride)
    const mins = new Float32Array(count)
    const maxs = new Float32Array(count)
    let depthMin = Infinity
    let depthMax = -Infinity
    for (let k = 0; k < count; k++) {
      const t = k * stride
      const a = this.depth[indices[3 * t]]
      const b = this.depth[indices[3 * t + 1]]
      const c = this.depth[indices[3 * t + 2]]
      const lo = Math.min(a, b, c)
      const hi = Math.max(a, b, c)
      mins[k] = lo
      maxs[k] = hi
      if (lo < depthMin) depthMin = lo
      if (hi > depthMax) depthMax = hi
    }
    const sorted = argsortFloat32(mins)
    this.order = new Uint32Array(count)
    this.sortedMin = new Float32Array(count)
    this.sortedMax = new Float32Array(count)
    this.runningMax = new Float32Array(count)
    let running = -Infinity
    for (let i = 0; i < count; i++) {
      const k = sorted[i]
      this.order[i] = k * stride
      this.sortedMin[i] = mins[k]
      this.sortedMax[i] = maxs[k]
      running = Math.max(running, maxs[k])
      this.runningMax[i] = running
    }
    const span = Math.max(Math.abs(depthMin), Math.abs(depthMax), depthMax - depthMin, 1e-30)
    this.margin = span * 1e-6
    this.diagonal = Math.hypot(envelope.maxX - envelope.minX, envelope.maxY - envelope.minY, depthMax - depthMin)
    this.info = {
      triangles: nt,
      indexed: count,
      depthMin: count ? depthMin : 0,
      depthMax: count ? depthMax : 0,
      envelope,
      ms: performance.now() - start,
    }
  }

  /**
   * Raw segments of the cut at `depth`: four coordinates each, and for each end
   * the mesh edge it lies on (lower vertex * vertexCount + upper vertex).
   */
  segments(depth: number): { coords: Float64Array; keys: Float64Array } {
    const { indices, order } = this
    const d = this.depth
    const first = lowerBound(this.runningMax, depth - this.margin)
    const last = lowerBound(this.sortedMin, depth + this.margin)
    let coords = new Float64Array(1024)
    let keys = new Float64Array(512)
    let count = 0
    const ends: number[] = []
    for (let i = first; i < last; i++) {
      if (this.sortedMax[i] < depth - this.margin) continue
      const t = order[i]
      const v0 = indices[3 * t]
      const v1 = indices[3 * t + 1]
      const v2 = indices[3 * t + 2]
      const a0 = d[v0] >= depth
      const a1 = d[v1] >= depth
      const a2 = d[v2] >= depth
      if (a0 === a1 && a1 === a2) continue
      ends.length = 0
      if (a0 !== a1) this.edgePoint(v0, v1, depth, ends)
      if (a1 !== a2) this.edgePoint(v1, v2, depth, ends)
      if (a2 !== a0) this.edgePoint(v2, v0, depth, ends)
      if (ends[0] === ends[3] && ends[1] === ends[4]) continue // both ends on one point
      if (4 * (count + 1) > coords.length) {
        const grownC = new Float64Array(coords.length * 2)
        grownC.set(coords)
        coords = grownC
        const grownK = new Float64Array(keys.length * 2)
        grownK.set(keys)
        keys = grownK
      }
      coords[4 * count] = ends[0]
      coords[4 * count + 1] = ends[1]
      coords[4 * count + 2] = ends[3]
      coords[4 * count + 3] = ends[4]
      keys[2 * count] = ends[2]
      keys[2 * count + 1] = ends[5]
      count++
    }
    return { coords: coords.subarray(0, 4 * count), keys: keys.subarray(0, 2 * count) }
  }

  private edgePoint(a: number, b: number, depth: number, out: number[]): void {
    // Always from the lower-numbered vertex: both triangles of the edge agree to the bit.
    const u = a < b ? a : b
    const v = a < b ? b : a
    const su = this.depth[u] - depth
    const sv = this.depth[v] - depth
    const t = su / (su - sv)
    out.push(
      this.px[u] + t * (this.px[v] - this.px[u]),
      this.py[u] + t * (this.py[v] - this.py[u]),
      u * this.vertexCount + v,
    )
  }

  /**
   * The section at `depth`. `cellSize` is the grid cell of the tunnel: loops are
   * simplified to half of it and slivers below MIN_AREA_CELLS cells dropped.
   */
  cut(depth: number, cellSize: number): CutResult {
    const start = performance.now()
    const { coords, keys } = this.segments(depth)
    // Exact by edge first; ends left free (unwelded vertices) by distance, then gaps.
    const byEdge = chainByKeys(coords, keys)
    let loops = byEdge.loops
    let open = byEdge.open
    if (open.length) {
      const joined = chainPieces(open, JOIN_FRACTION * this.diagonal)
      loops = loops.concat(joined.loops)
      open = joined.open
    }
    if (open.length) {
      const box = boxOf([...loops, ...open].map(flatToPts))
      const size = Math.max(box.maxX - box.minX, box.maxY - box.minY)
      const gaps = chainPieces(open, GAP_FRACTION * size)
      loops = loops.concat(gaps.loops)
      open = gaps.open
    }
    const minArea = MIN_AREA_CELLS * cellSize * cellSize
    let droppedSmall = 0
    const kept: Pt[][] = []
    for (const loop of loops) {
      const simple = simplifyLoop(loop, cellSize / 2)
      if (simple.length < 6 || Math.abs(flatArea(simple)) < minArea) {
        droppedSmall++
        continue
      }
      kept.push(flatToPts(simple))
    }
    const report = validateLoops(kept)
    let result = normaliseOrientation(kept).loops
    let rawLoops: Pt[][] | null = null
    const repaired = !report.valid && kept.length > 0
    if (repaired) {
      rawLoops = result
      const fixed = repairLoops(kept, minArea)
      result = fixed.loops
      droppedSmall += fixed.dropped
    }
    return {
      loops: result,
      rawLoops,
      repaired,
      issues: report.issues,
      open: open.map(flatToPts),
      droppedSmall,
      segments: keys.length / 2,
      ms: performance.now() - start,
    }
  }
}
