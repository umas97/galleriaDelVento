// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The geometry of the 3D tunnel's views, without the GPU (vitest checks it):
// where the model sits in the chamber, its normals, the body as the flow sees
// it (the voxels' outer faces), the rake's nozzles, the points the colour
// ranges are sampled at, and the ranges themselves.
import type { CasePlan3D } from '../lib/types'
import type { Mat4, Vec3 } from './camera'
import { caseRotation } from './voxelize'

/** The model's view mesh, library coordinates (metres). */
export type BodyMesh = { positions: Float32Array; indices: Uint32Array; normals: Float32Array }

/** Area-weighted vertex normals; with the repaired mesh's outward winding they point out. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array<ArrayBuffer> {
  const n = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]
    const b = 3 * indices[t + 1]
    const c = 3 * indices[t + 2]
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const v of [a, b, c]) {
      n[v] += nx
      n[v + 1] += ny
      n[v + 2] += nz
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l
    n[i + 1] /= l
    n[i + 2] /= l
  }
  return n
}

/**
 * Library coordinates → chamber metres, as planner3d.py places the body:
 * q = offset + R_z(yaw) R_y(pitch) (p − pivot). Column-major, for WGSL.
 */
export function modelMatrix(pivot: Vec3, offset: Vec3, yawDeg: number, pitchDeg: number): Mat4 {
  const r = caseRotation(yawDeg, pitchDeg)
  const t = [0, 1, 2].map((i) => offset[i] - (r[3 * i] * pivot[0] + r[3 * i + 1] * pivot[1] + r[3 * i + 2] * pivot[2]))
  const m = new Float32Array(16)
  m.set([r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1])
  return m
}

/**
 * The body as the flow sees it (SPEC §24.8, «Mostra i voxel»): the faces of
 * the solid cells that touch fluid, flat-shaded, brought back to library
 * coordinates -- p = pivot + Rᵀ (q − offset) -- so that the model's matrices
 * draw them where the cells are.
 */
export function voxelSurface(voxels: Uint8Array, plan: CasePlan3D, pivot: Vec3): BodyMesh {
  const { nx, ny, nz, dx, offset } = plan
  const r = caseRotation(plan.yaw_deg, plan.pitch_deg)
  const solid = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && voxels[x + nx * (y + ny * z)] === 1
  const positions: number[] = []
  const normals: number[] = []
  const back = (q: number[]) => {
    const d = [q[0] * dx - offset[0], q[1] * dx - offset[1], q[2] * dx - offset[2]]
    // Rᵀ d (r is row-major).
    for (let i = 0; i < 3; i++) positions.push(pivot[i] + r[i] * d[0] + r[3 + i] * d[1] + r[6 + i] * d[2])
  }
  // Per axis a and side s: the face's corners, anticlockwise seen from outside.
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (!solid(x, y, z)) continue
        for (let a = 0; a < 3; a++)
          for (const side of [-1, 1]) {
            const o = [x, y, z]
            o[a] += side
            if (solid(o[0], o[1], o[2])) continue
            const u = (a + 1) % 3
            const v = (a + 2) % 3
            const base = [x, y, z]
            if (side > 0) base[a] += 1
            const corner = (du: number, dv: number) => {
              const q = [...base]
              q[u] += du
              q[v] += dv
              return q
            }
            const quad = side > 0 ? [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)] : [corner(0, 0), corner(0, 1), corner(1, 1), corner(1, 0)]
            for (const q of quad) back(q)
            const n = [0, 0, 0]
            n[a] = side
            for (let k = 0; k < 4; k++) for (let i = 0; i < 3; i++) normals.push(r[i] * n[0] + r[3 + i] * n[1] + r[6 + i] * n[2])
          }
      }
  const quads = positions.length / 12
  const indices = new Uint32Array(6 * quads)
  for (let k = 0; k < quads; k++) indices.set([4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3], 6 * k)
  return { positions: new Float32Array(positions), indices, normals: new Float32Array(normals) }
}

/** The rotation alone (for normals). */
export function rotationMatrix(yawDeg: number, pitchDeg: number): Mat4 {
  return modelMatrix([0, 0, 0], [0, 0, 0], yawDeg, pitchDeg)
}

export function apply(m: Mat4, p: Vec3, w = 1): Vec3 {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * w) as Vec3
}

/** The body's box in the chamber (metres): (x0, y0, z0, x1, y1, z1). */
export function bodyBoxInChamber(plan: Pick<CasePlan3D, 'offset'>, box: [number, number, number, number, number, number]) {
  const [ox, oy, oz] = plan.offset
  return [box[0] + ox, box[1] + oy, box[2] + oz, box[3] + ox, box[4] + oy, box[5] + oz] as const
}

/**
 * The smoke rake (SPEC §24.2 #3): nozzles across the wind at `x` (metres
 * from the inlet). A line, horizontal (along y, at height `across`) or
 * vertical (along z, at lateral position `across`), `span` metres wide
 * centred on `centre` (y or z); or a grid (SPEC §24.10) on the transverse
 * plane, `nozzles` per row over `span` (y, centred on `centre`) and `rows`
 * rows over `height` (z, centred on `across`).
 */
export type Rake = {
  orientation: 'horizontal' | 'vertical' | 'grid'
  x: number
  across: number
  centre: number
  span: number
  nozzles: number
  /** Grid only. */
  rows?: number
  height?: number
}

/** Nozzles of a line, and per row and rows of a grid: what the panel allows. */
export const RAKE_LIMITS = { line: [2, 48], grid: [2, 16] } as const

/** Rows and nozzles per row of a rake, within the limits (a line is one row). */
export function rakeShape(rake: Rake): { rows: number; perRow: number } {
  const [lo, hi] = rake.orientation === 'grid' ? RAKE_LIMITS.grid : RAKE_LIMITS.line
  const fit = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)))
  return { rows: rake.orientation === 'grid' ? fit(rake.rows ?? lo) : 1, perRow: fit(rake.nozzles) }
}

/** Nozzle positions in cells (vec4 per nozzle, row after row), inside the chamber's fluid. */
export function rakeNozzles(rake: Rake, plan: Pick<CasePlan3D, 'nx' | 'ny' | 'nz' | 'dx'>): Float32Array<ArrayBuffer> {
  const { rows, perRow } = rakeShape(rake)
  const out = new Float32Array(4 * rows * perRow)
  const clamp = (v: number, size: number) => Math.min(size - 0.51, Math.max(0.51, v))
  const spread = (i: number, n: number) => (n === 1 ? 0 : i / (n - 1) - 0.5)
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < perRow; i++) {
      const along = rake.centre + spread(i, perRow) * rake.span
      const height = rake.orientation === 'grid' ? rake.across + spread(r, rows) * (rake.height ?? 0) : rake.across
      const y = rake.orientation === 'vertical' ? rake.across : along
      const z = rake.orientation === 'vertical' ? along : height
      out.set([clamp(rake.x / plan.dx, plan.nx), clamp(y / plan.dx, plan.ny), clamp(z / plan.dx, plan.nz), 1], 4 * (r * perRow + i))
    }
  }
  return out
}

/** Which plane: 0 transverse (x = const), 1 longitudinal (y = const), 2 horizontal (z = const). */
export type PlaneAxis = 0 | 1 | 2

/**
 * Points (texture coordinates, vec4) on a plane's fluid cells, at most about
 * `budget` of them, for its colour range; solid cells are left out.
 */
export function planePoints(
  axis: PlaneAxis,
  position: number,
  plan: Pick<CasePlan3D, 'nx' | 'ny' | 'nz' | 'dx'>,
  voxels: Uint8Array | null,
  budget = 6000,
): Float32Array<ArrayBuffer> {
  const size = [plan.nx, plan.ny, plan.nz]
  const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
  const fixed = Math.min(size[axis] - 1, Math.max(0, Math.floor(position / plan.dx)))
  const stride = Math.max(1, Math.ceil(Math.sqrt((size[a] * size[b]) / budget)))
  const out: number[] = []
  const c = [0, 0, 0]
  c[axis] = fixed
  for (let j = 0; j < size[b]; j += stride)
    for (let i = 0; i < size[a]; i += stride) {
      c[a] = i
      c[b] = j
      if (voxels && voxels[c[0] + plan.nx * (c[1] + plan.ny * c[2])]) continue
      out.push((c[0] + 0.5) / size[0], (c[1] + 0.5) / size[1], (c[2] + 0.5) / size[2], 0)
    }
  return new Float32Array(out)
}

/**
 * Points just off the body's surface (texture coordinates, vec4): up to
 * `budget` vertices of the view mesh, moved out along their normals by the
 * same 0.75 cell the surface colouring samples at.
 */
export function surfacePoints(body: BodyMesh, model: Mat4, rotation: Mat4, plan: Pick<CasePlan3D, 'nx' | 'ny' | 'nz' | 'dx'>, budget = 4000): Float32Array<ArrayBuffer> {
  const count = body.positions.length / 3
  const stride = Math.max(1, Math.floor(count / budget))
  const out: number[] = []
  const size = [plan.nx * plan.dx, plan.ny * plan.dx, plan.nz * plan.dx]
  for (let v = 0; v < count; v += stride) {
    const p = apply(model, [body.positions[3 * v], body.positions[3 * v + 1], body.positions[3 * v + 2]])
    const n = apply(rotation, [body.normals[3 * v], body.normals[3 * v + 1], body.normals[3 * v + 2]], 0)
    const q = p.map((x, i) => (x + n[i] * 0.75 * plan.dx) / size[i])
    if (q.some((x) => x < 0 || x > 1)) continue
    out.push(q[0], q[1], q[2], 0)
  }
  return new Float32Array(out)
}

export function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}

/** As in 2D (SPEC §10.6): magnitudes from the 2nd to the 98th percentile, signed values symmetric about 0. */
export function autoRange(values: number[], symmetric: boolean): [number, number] | null {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return null
  const lo = percentile(finite, 0.02)
  const hi = percentile(finite, 0.98)
  if (symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6)
    return [-m, m]
  }
  return hi > lo ? [lo, hi] : [lo, lo + 1e-6]
}

/** A CSS hex colour as RGBA in [0, 1]. */
export function hexColor(hex: string, alpha = 1): number[] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6)
  const v = parseInt(full, 16)
  return Number.isFinite(v) ? [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, alpha] : [0.5, 0.5, 0.5, alpha]
}
