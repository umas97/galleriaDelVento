// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Streamlines (SPEC §10.6 #6): curves tangent to the velocity, integrated with
// RK4 along the unit direction (a streamline does not depend on the speed) on a
// field read back from the GPU every half second, downsampled. Seeds: 30
// points across the chamber just downstream of the inlet, or along a rake
// drawn by the user. Pure functions; streamlines.worker.ts runs them.

export type Field = {
  w: number
  h: number
  /** Cells per texel. */
  factor: number
  /** (δρ, ux, uy, solid) per texel, row-major. */
  data: Float32Array
}

export type Polyline = number[] // x0, y0, x1, y1, ... in cells

function velocity(f: Field, x: number, y: number): [number, number] | null {
  // Texel centres at (i + 0.5) · factor; bilinear between them.
  const gx = x / f.factor - 0.5
  const gy = y / f.factor - 0.5
  const i0 = Math.floor(gx)
  const j0 = Math.floor(gy)
  const wx = gx - i0
  const wy = gy - j0
  let u = 0
  let v = 0
  for (const [di, dj, w] of [
    [0, 0, (1 - wx) * (1 - wy)],
    [1, 0, wx * (1 - wy)],
    [0, 1, (1 - wx) * wy],
    [1, 1, wx * wy],
  ] as const) {
    const i = Math.min(f.w - 1, Math.max(0, i0 + di))
    const j = Math.min(f.h - 1, Math.max(0, j0 + dj))
    const k = 4 * (j * f.w + i)
    if (f.data[k + 3] > 0) continue
    u += w * f.data[k + 1]
    v += w * f.data[k + 2]
  }
  return [u, v]
}

function solidAt(f: Field, x: number, y: number): boolean {
  const i = Math.floor(x / f.factor)
  const j = Math.floor(y / f.factor)
  if (i < 0 || j < 0 || i >= f.w || j >= f.h) return true
  return f.data[4 * (j * f.w + i) + 3] > 0
}

function direction(f: Field, x: number, y: number): [number, number] | null {
  const vel = velocity(f, x, y)
  if (!vel) return null
  const n = Math.hypot(vel[0], vel[1])
  if (n < 1e-6) return null
  return [vel[0] / n, vel[1] / n]
}

/** One streamline from (x, y), downstream, in cells. */
export function trace(f: Field, x: number, y: number, step: number, maxPoints: number): Polyline {
  const out: Polyline = [x, y]
  const width = f.w * f.factor
  const height = f.h * f.factor
  for (let n = 0; n < maxPoints; n++) {
    const k1 = direction(f, x, y)
    if (!k1) break
    const k2 = direction(f, x + 0.5 * step * k1[0], y + 0.5 * step * k1[1])
    if (!k2) break
    const k3 = direction(f, x + 0.5 * step * k2[0], y + 0.5 * step * k2[1])
    if (!k3) break
    const k4 = direction(f, x + step * k3[0], y + step * k3[1])
    if (!k4) break
    x += (step / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
    y += (step / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
    if (x < 0 || y < 0 || x >= width || y >= height || solidAt(f, x, y)) break
    out.push(x, y)
  }
  return out
}

/** Seeds: `count` points evenly along a segment (cells). */
export function rakeSeeds(a: [number, number], b: [number, number], count = 30): [number, number][] {
  return Array.from({ length: count }, (_, k) => {
    const t = (k + 0.5) / count
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] as [number, number]
  })
}

export function defaultSeeds(nx: number, ny: number, count = 30): [number, number][] {
  const x = Math.max(2, nx * 0.03)
  return rakeSeeds([x, 0], [x, ny], count)
}

export function streamlines(f: Field, seeds: [number, number][]): Polyline[] {
  const step = Math.max(0.5, f.factor * 0.5)
  const maxPoints = Math.ceil((4 * (f.w + f.h) * f.factor) / step)
  return seeds.map(([x, y]) => trace(f, x, y, step, maxPoints))
}
