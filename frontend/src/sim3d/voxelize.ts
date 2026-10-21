// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// From the model's mesh to the 3D solver's voxels (SPEC §24.3), on the full
// mesh (mesh.bin, SPEC §7.2), meant to run in a Web Worker:
//
// - `turnBody`: the case's rotations about the model's pivot (planner3d.py:
//   pitch about y, positive nose up, then yaw about z, anticlockwise from
//   above), giving the body relative to the pivot;
// - `boxOf` and `frontalArea`: what the 3D planner sizes the chamber on;
// - `voxelize`: a cell is solid when its centre is inside the body. Rays run
//   through the cell centres; along each ray the crossings with the mesh are
//   sorted and the cells between the 1st and 2nd, 3rd and 4th... are inside.
//   A closed mesh needs one direction (z). An open one (a scan without soles,
//   a hole that repair left) gives a ray through the opening an odd count:
//   such a ray abstains, and the cell takes the majority of the rays along
//   x, y and z that did not (a tie counts as solid).
//
// - `wallLinks`: where the links between cell centres meet the surface, for the
//   solver's interpolated walls (SPEC §24.8): every link that crosses a
//   triangle is a wall for its fluid ends, at the nearest crossing -- also
//   between two fluid cells, so that a part thinner than a cell still exists
//   for the flow.
//
// Coordinates on the grid are in cells with the cell centres on the integers;
// the mesh is moved by a few millionths of a cell so that a vertex or an edge
// never sits exactly on a ray (a ray through an edge shared by two triangles
// would cross it twice or not at all).

// With its extension: Node runs this module directly in the benchmarks.
import { C, OPPOSITE, Q } from './lattice3d.generated.ts'

export type Vec3 = [number, number, number]
export type Box3 = [number, number, number, number, number, number]

/** R = R_z(yaw) · R_y(pitch), row-major. */
export function caseRotation(yawDeg: number, pitchDeg: number): number[] {
  const a = (yawDeg * Math.PI) / 180
  const b = (pitchDeg * Math.PI) / 180
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]
  // R_y(b) = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]]: nose (−x) up for b > 0.
  // R_z(a) = [[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]].
  return [ca * cb, -sa, ca * sb, sa * cb, ca, sa * sb, -sb, 0, cb]
}

/** The body turned about the pivot, relative to it: R (p − pivot), metres, float64. */
export function turnBody(positions: Float32Array, pivot: Vec3, yawDeg: number, pitchDeg: number): Float64Array {
  const r = caseRotation(yawDeg, pitchDeg)
  const out = new Float64Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] - pivot[0]
    const y = positions[i + 1] - pivot[1]
    const z = positions[i + 2] - pivot[2]
    out[i] = r[0] * x + r[1] * y + r[2] * z
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z
  }
  return out
}

/** (x0, y0, z0, x1, y1, z1) of a set of points. */
export function boxOf(points: Float64Array | Float32Array): Box3 {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < points.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = points[i + a]
      if (v < lo[a]) lo[a] = v
      if (v > hi[a]) hi[a] = v
    }
  return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]
}

/**
 * The 1-D crossings of the triangles with a family of rays along `axis`
 * through the integer points of the other two (u, v) coordinates, grouped per
 * ray: ray (u, v) has its crossings in hits[start[r] .. start[r + 1]).
 */
function crossings(
  p: Float64Array,
  indices: Uint32Array,
  axis: 0 | 1 | 2,
  nu: number,
  nv: number,
): { start: Int32Array; hits: Float64Array } {
  const ua = axis === 0 ? 1 : 0
  const va = axis === 2 ? 1 : 2
  const count = new Int32Array(nu * nv + 1)
  const visit = (record: (ray: number, w: number) => void) => {
    for (let t = 0; t < indices.length; t += 3) {
      const a = 3 * indices[t]
      const b = 3 * indices[t + 1]
      const c = 3 * indices[t + 2]
      const au = p[a + ua], av = p[a + va], bu = p[b + ua], bv = p[b + va], cu = p[c + ua], cv = p[c + va]
      const u0 = Math.max(0, Math.ceil(Math.min(au, bu, cu)))
      const u1 = Math.min(nu - 1, Math.floor(Math.max(au, bu, cu)))
      if (u0 > u1) continue
      const v0 = Math.max(0, Math.ceil(Math.min(av, bv, cv)))
      const v1 = Math.min(nv - 1, Math.floor(Math.max(av, bv, cv)))
      if (v0 > v1) continue
      // Twice the signed area in (u, v); a triangle seen edge-on has no crossings.
      const area = (bu - au) * (cv - av) - (bv - av) * (cu - au)
      if (area === 0) continue
      const aw = p[a + axis], bw = p[b + axis], cw = p[c + axis]
      for (let v = v0; v <= v1; v++)
        for (let u = u0; u <= u1; u++) {
          // Barycentric weights of (u, v), all of one sign when inside.
          const l0 = (bu - u) * (cv - v) - (bv - v) * (cu - u)
          const l1 = (cu - u) * (av - v) - (cv - v) * (au - u)
          const l2 = area - l0 - l1
          if (area > 0 ? l0 < 0 || l1 < 0 || l2 < 0 : l0 > 0 || l1 > 0 || l2 > 0) continue
          record(u + nu * v, (l0 * aw + l1 * bw + l2 * cw) / area)
        }
    }
  }
  visit((ray) => count[ray + 1]++)
  for (let r = 0; r < nu * nv; r++) count[r + 1] += count[r]
  const hits = new Float64Array(count[nu * nv])
  const fill = count.slice(0, nu * nv)
  visit((ray, w) => (hits[fill[ray]++] = w))
  return { start: count, hits }
}

/** The jitter, in cells, that keeps rays off vertices and edges. */
const JITTER: Vec3 = [1.234567e-6, 2.345671e-6, 3.456712e-6]

export type Grid3 = { nx: number; ny: number; nz: number; dx: number; offset: Vec3 }

/** The body relative to the pivot as grid coordinates (cell centres on the integers), jittered. */
function onGrid(body: Float64Array, grid: Grid3): Float64Array {
  const { dx, offset } = grid
  const p = new Float64Array(body.length)
  for (let i = 0; i < body.length; i += 3)
    for (let a = 0; a < 3; a++) p[i + a] = (body[i + a] + offset[a]) / dx - 0.5 + JITTER[a]
  return p
}

/**
 * Voxels of the body (relative to the pivot, as `turnBody` gives it) on a
 * grid whose pivot sits at `offset` (metres from the chamber's corner): one
 * byte per cell, x fastest. `closed`: the mesh is watertight (rays along z
 * only); otherwise the majority of x, y and z.
 */
export function voxelize(body: Float64Array, indices: Uint32Array, grid: Grid3, closed: boolean): Uint8Array<ArrayBuffer> {
  const { nx, ny, nz } = grid
  const p = onGrid(body, grid)
  const size = [nx, ny, nz]
  const n = nx * ny * nz
  const axes: (0 | 1 | 2)[] = closed ? [2] : [0, 1, 2]
  // Per cell: votes for solid and votes cast.
  const solid = new Uint8Array(n)
  const cast = closed ? null : new Uint8Array(n)
  const stride = [1, nx, nx * ny]
  for (const axis of axes) {
    const ua = axis === 0 ? 1 : 0
    const va = axis === 2 ? 1 : 2
    const nu = size[ua]
    const nv = size[va]
    const nw = size[axis]
    const { start, hits } = crossings(p, indices, axis, nu, nv)
    for (let v = 0; v < nv; v++)
      for (let u = 0; u < nu; u++) {
        const ray = u + nu * v
        const lo = start[ray]
        const hi = start[ray + 1]
        if (hi === lo) {
          if (cast) for (let w = 0; w < nw; w++) cast[u * stride[ua] + v * stride[va] + w * stride[axis]]++
          continue
        }
        if ((hi - lo) % 2 === 1) continue // through an opening: abstains
        const w = hits.subarray(lo, hi).sort()
        const base = u * stride[ua] + v * stride[va]
        if (cast) for (let k = 0; k < nw; k++) cast[base + k * stride[axis]]++
        for (let i = 0; i < w.length; i += 2) {
          const k0 = Math.max(0, Math.ceil(w[i]))
          const k1 = Math.min(nw - 1, Math.floor(w[i + 1]))
          for (let k = k0; k <= k1; k++) solid[base + k * stride[axis]]++
        }
      }
  }
  if (!cast) return solid
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = solid[i] > 0 && 2 * solid[i] >= cast[i] ? 1 : 0
  return out
}

/**
 * The body's area projected on the y–z plane (the frontal area, m²), rasterised
 * on `resolution` pixels across its larger side: what the planner sizes the
 * chamber on (SPEC §24.3).
 */
export function frontalArea(body: Float64Array, indices: Uint32Array, resolution = 1024): number {
  const [, y0, z0, , y1, z1] = boxOf(body)
  const h = Math.max(y1 - y0, z1 - z0) / resolution
  if (!(h > 0)) return 0
  const nu = Math.ceil((y1 - y0) / h) + 1
  const nv = Math.ceil((z1 - z0) / h) + 1
  const p = new Float64Array(body.length)
  for (let i = 0; i < body.length; i += 3) {
    p[i] = 0
    p[i + 1] = (body[i + 1] - y0) / h - 0.5 + JITTER[1]
    p[i + 2] = (body[i + 2] - z0) / h - 0.5 + JITTER[2]
  }
  const covered = new Uint8Array(nu * nv)
  const { start } = crossings(p, indices, 0, nu, nv)
  for (let r = 0; r < nu * nv; r++) if (start[r + 1] > start[r]) covered[r] = 1
  let count = 0
  for (const c of covered) count += c
  return count * h * h
}

/** The frontal area of voxels (cells with a solid cell along x), in cells². */
export function voxelFrontalArea(voxels: Uint8Array, nx: number, ny: number, nz: number): number {
  let count = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const row = nx * (y + ny * z)
      for (let x = 0; x < nx; x++)
        if (voxels[row + x]) {
          count++
          break
        }
    }
  return count
}

/** Words of a wall record, and the index of a cell without one (the solver's layout, shaders.ts). */
export const WALL_WORDS = 5
export const NO_WALL = 0xffffffff

/**
 * The body's walls for the solver (SPEC §24.8): per cell an index into
 * `count` records of WALL_WORDS words, NO_WALL for none; byte k − 1 of a
 * record (four to a word) is the wall on the link from the cell to x − c_k,
 * at q = b / 255 of the link (b ≥ 1), or none (b = 0).
 */
export type WallLinks = { index: Uint32Array<ArrayBuffer>; q: Uint32Array<ArrayBuffer>; count: number }

/** A wall distance (fraction of the link, 0..1) as a byte, 1..255 (the reference's quantize). */
export function quantizeQ(q: number): number {
  return Math.min(255, Math.max(1, Math.floor(q * 255 + 0.5)))
}

/** Walls from (cell, direction, byte) triples; a later triple of a link replaces an earlier one. */
export function packWalls(cells: number, triples: ArrayLike<number>): WallLinks {
  const index = new Uint32Array(cells).fill(NO_WALL)
  let count = 0
  for (let i = 0; i < triples.length; i += 3) if (index[triples[i]] === NO_WALL) index[triples[i]] = count++
  const q = new Uint32Array(Math.max(1, count) * WALL_WORDS)
  for (let i = 0; i < triples.length; i += 3) {
    const [cell, k, b] = [triples[i], triples[i + 1], triples[i + 2]]
    const w = WALL_WORDS * index[cell] + ((k - 1) >> 2)
    const shift = 8 * ((k - 1) & 3)
    q[w] = ((q[w] & ~(255 << shift)) | (b << shift)) >>> 0
  }
  return { index, q, count }
}

/** No walls: halfway bounce-back on every solid cell. */
export function noWalls(cells: number): WallLinks {
  return { index: new Uint32Array(cells).fill(NO_WALL), q: new Uint32Array(WALL_WORDS), count: 0 }
}

/**
 * The walls of the body (relative to the pivot, as `turnBody` gives it) on the
 * grid of its `voxels`: every link between two cell centres that crosses a
 * triangle is a wall for each of its fluid ends, at the crossing nearest to
 * it. A solid neighbour whose link meets no triangle (a voxel of an open mesh,
 * decided by majority) is left to the solver's halfway bounce-back.
 */
export function wallLinks(body: Float64Array, indices: Uint32Array, grid: Grid3, voxels: Uint8Array): WallLinks {
  const { nx, ny, nz } = grid
  const n = nx * ny * nz
  const size = [nx, ny, nz]
  const p = onGrid(body, grid)
  // Nearest crossing per (cell, direction), 2 = none; a record per cell that has one.
  const slot = new Int32Array(n).fill(-1)
  let best = new Float32Array(Q * 1024).fill(2)
  let count = 0
  const record = (cell: number, k: number, t: number) => {
    let r = slot[cell]
    if (r < 0) {
      r = slot[cell] = count++
      if (Q * count > best.length) {
        const grown = new Float32Array(2 * best.length).fill(2)
        grown.set(best)
        best = grown
      }
    }
    const i = Q * r + k
    if (t < best[i]) best[i] = t
  }
  // One direction of each opposite pair: the link from x to x − c_k.
  const dirs = Array.from({ length: Q }, (_, k) => k).filter((k) => k > 0 && OPPOSITE[k] > k)
  const lo = [0, 0, 0]
  const hi = [0, 0, 0]
  const r0 = [0, 0, 0]
  const r1 = [0, 0, 0]
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]
    const b = 3 * indices[t + 1]
    const c = 3 * indices[t + 2]
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(p[a + i], p[b + i], p[c + i])
      hi[i] = Math.max(p[a + i], p[b + i], p[c + i])
    }
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
    for (const k of dirs) {
      const d = [-C[3 * k], -C[3 * k + 1], -C[3 * k + 2]]
      // x and x + d both in the grid, and the segment x → x + d able to reach the triangle's box.
      let empty = false
      for (let i = 0; i < 3; i++) {
        r0[i] = Math.max(0, -d[i], Math.ceil(lo[i] + Math.min(0, -d[i]) - 1e-9))
        r1[i] = Math.min(size[i] - 1, size[i] - 1 - d[i], Math.floor(hi[i] + Math.max(0, -d[i]) + 1e-9))
        if (r0[i] > r1[i]) empty = true
      }
      if (empty) continue
      // Möller–Trumbore with the segment x + s d, s in [0, 1].
      const px = d[1] * e2z - d[2] * e2y
      const py = d[2] * e2x - d[0] * e2z
      const pz = d[0] * e2y - d[1] * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (det === 0) continue
      const inv = 1 / det
      const step = d[0] + nx * (d[1] + ny * d[2])
      for (let z = r0[2]; z <= r1[2]; z++)
        for (let y = r0[1]; y <= r1[1]; y++)
          for (let x = r0[0]; x <= r1[0]; x++) {
            const tx = x - p[a], ty = y - p[a + 1], tz = z - p[a + 2]
            const u = (tx * px + ty * py + tz * pz) * inv
            if (u < 0 || u > 1) continue
            const qx = ty * e1z - tz * e1y
            const qy = tz * e1x - tx * e1z
            const qz = tx * e1y - ty * e1x
            const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
            if (v < 0 || u + v > 1) continue
            const s = (e2x * qx + e2y * qy + e2z * qz) * inv
            if (s < 0 || s > 1) continue
            const cell = x + nx * (y + ny * z)
            if (!voxels[cell]) record(cell, k, s)
            if (!voxels[cell + step]) record(cell + step, OPPOSITE[k], 1 - s)
          }
    }
  }
  const index = new Uint32Array(n).fill(NO_WALL)
  const q = new Uint32Array(Math.max(1, count) * WALL_WORDS)
  for (let cell = 0; cell < n; cell++) {
    const r = slot[cell]
    if (r < 0) continue
    index[cell] = r
    for (let k = 1; k < Q; k++) {
      const v = best[Q * r + k]
      if (v > 1) continue
      q[WALL_WORDS * r + ((k - 1) >> 2)] |= quantizeQ(v) << (8 * ((k - 1) & 3))
    }
  }
  return { index, q, count }
}
