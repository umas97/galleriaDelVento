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
// Coordinates on the grid are in cells with the cell centres on the integers;
// the mesh is moved by a few millionths of a cell so that a vertex or an edge
// never sits exactly on a ray (a ray through an edge shared by two triangles
// would cross it twice or not at all).

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

/**
 * Voxels of the body (relative to the pivot, as `turnBody` gives it) on a
 * grid whose pivot sits at `offset` (metres from the chamber's corner): one
 * byte per cell, x fastest. `closed`: the mesh is watertight (rays along z
 * only); otherwise the majority of x, y and z.
 */
export function voxelize(body: Float64Array, indices: Uint32Array, grid: Grid3, closed: boolean): Uint8Array {
  const { nx, ny, nz, dx, offset } = grid
  const p = new Float64Array(body.length)
  for (let i = 0; i < body.length; i += 3)
    for (let a = 0; a < 3; a++) p[i + a] = (body[i + a] + offset[a]) / dx - 0.5 + JITTER[a]
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
