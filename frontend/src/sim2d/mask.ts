// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Profile2D → the solver's mask of solid cells (SPEC §10.3). The twin of
// backend/gdv/geometry/raster2d.py, step for step and in the same order, so
// that every intermediate is the same IEEE double: test 10 asks the two to
// agree cell for cell.
//
// A cell is solid when its centre lies inside at least one *outer* loop (the
// union of the bodies, holes filled). Inside a loop is even-odd along the
// cell's row: the crossings c of the row's centre line with the edges (an
// edge counts when exactly one end is above the line), sorted, make the cells
// with c[2m] <= x < c[2m+1] solid. Outer loops: counter-clockwise for a saved
// profile, an even nesting depth for a live section.
//
// Chamber frame: origin at the bottom-left corner, cell (i, j) centred at
// ((i + 0.5) dx, (j + 0.5) dx), the mask indexed [j * nx + i]. A profile point
// p sits at position + R(-incidence)(p - pivot), positive incidence nose up.
import { loopDepths, signedArea, type Pt } from '../profile/geometry'

export type OuterRule = 'orientation' | 'nesting'

export type Placement = { pivot: Pt; position: Pt; angleDeg: number }

export function outerLoops(loops: readonly (readonly Pt[])[], rule: OuterRule): Pt[][] {
  const usable = loops.filter((l) => l.length >= 3).map((l) => [...l])
  if (rule === 'orientation') return usable.filter((l) => signedArea(l) > 0)
  const depths = loopDepths(usable)
  return usable.filter((_, i) => depths[i] % 2 === 0)
}

/** Profile coordinates → chamber coordinates. */
export function place(loops: readonly (readonly Pt[])[], { pivot, position, angleDeg }: Placement): Pt[][] {
  const a = (-angleDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const [px, py] = pivot
  const [qx, qy] = position
  return loops.map((loop) =>
    loop.map(([x, y]) => {
      const dx = x - px
      const dy = y - py
      return [qx + (c * dx - s * dy), qy + (s * dx + c * dy)] as Pt
    }),
  )
}

/** The first column whose centre is >= c, clamped to [0, n]. */
function firstAtOrAfter(c: number, dx: number, n: number): number {
  let i = Math.ceil(c / dx - 0.5)
  i = Math.min(Math.max(i, 0), n)
  while (i > 0 && (i - 1 + 0.5) * dx >= c) i--
  while (i < n && (i + 0.5) * dx < c) i++
  return i
}

/**
 * Solid cells (1) of the union of `loops` (chamber coordinates), row-major
 * [j * nx + i]. `out` is reused when given (it is cleared first).
 */
export function rasterize(
  loops: readonly (readonly Pt[])[],
  nx: number,
  ny: number,
  dx: number,
  out?: Uint8Array,
): Uint8Array {
  const mask = out ?? new Uint8Array(nx * ny)
  mask.fill(0)
  const rows: number[][] = []
  for (const loop of loops) {
    const n = loop.length
    if (n < 3) continue
    const touched: number[] = []
    for (let k = 0; k < n; k++) {
      const [ax, ay] = loop[k]
      const [bx, by] = loop[(k + 1) % n]
      if (ay === by) continue
      const lo = Math.min(ay, by)
      const hi = Math.max(ay, by)
      const j0 = Math.max(0, Math.floor(lo / dx - 0.5))
      const j1 = Math.min(ny - 1, Math.ceil(hi / dx - 0.5))
      for (let j = j0; j <= j1; j++) {
        const yc = (j + 0.5) * dx
        if (ay > yc !== by > yc) {
          let row = rows[j]
          if (!row) {
            row = rows[j] = []
          }
          if (row.length === 0) touched.push(j)
          row.push(ax + ((yc - ay) * (bx - ax)) / (by - ay))
        }
      }
    }
    for (const j of touched) {
      const crossings = rows[j]
      crossings.sort((a, b) => a - b)
      const base = j * nx
      for (let m = 0; m + 1 < crossings.length; m += 2) {
        const i0 = firstAtOrAfter(crossings[m], dx, nx)
        const i1 = firstAtOrAfter(crossings[m + 1], dx, nx)
        if (i1 > i0) mask.fill(1, base + i0, base + i1)
      }
      crossings.length = 0
    }
  }
  return mask
}
