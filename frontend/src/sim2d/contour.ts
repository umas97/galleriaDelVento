// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cp along the contour (SPEC §10.7): the fluid cells touching the body are
// sampled (their density gives the pressure), and each is tied to the nearest
// point of the outline. For a chord reference the curve is Cp against x/c, the
// upper and the lower surface apart; for blunt bodies, Cp along the perimeter.
//
// The outline is the main body's (largest outer loop) in profile coordinates
// at zero incidence, placed in the chamber like the mask. Upper and lower are
// the two arcs between the points of smallest and largest x (leading and
// trailing edge), the upper being the one that runs from the trailing edge
// counter-clockwise -- outer loops are counter-clockwise.
import { signedArea, type Pt } from '../profile/geometry'
import { place, type Placement } from './mask'

export type ContourPoint = {
  /** The fluid cell sampled. */
  i: number
  j: number
  /** Along the chord, 0 at the leading edge, 1 at the trailing edge. */
  xc: number
  /** Arc length from the trailing edge, counter-clockwise, as a fraction of the perimeter. */
  s: number
  upper: boolean
  /** The nearest point of the outline, chamber coordinates (cells). */
  x: number
  y: number
}

/** Fluid cells with a solid neighbour along an axis. */
export function boundaryCells(mask: Uint8Array, nx: number, ny: number): Int32Array {
  const out: number[] = []
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i]) continue
      if (
        (i > 0 && mask[j * nx + i - 1]) ||
        (i < nx - 1 && mask[j * nx + i + 1]) ||
        (j > 0 && mask[(j - 1) * nx + i]) ||
        (j < ny - 1 && mask[(j + 1) * nx + i])
      )
        out.push(i, j)
    }
  return Int32Array.from(out)
}

/** The largest loop by area (the main body). */
export function mainLoop(loops: readonly Pt[][]): Pt[] | null {
  let best: Pt[] | null = null
  let area = 0
  for (const l of loops) {
    const a = Math.abs(signedArea(l))
    if (a > area) {
      area = a
      best = l
    }
  }
  return best
}

/**
 * The contour points of `cells`, each tied to the nearest point of `loop`
 * (profile coordinates). `dx` converts metres to cells. Cells farther than
 * two cells from the outline (another body) are left out.
 */
export function contourPoints(cells: Int32Array, loop: Pt[], placement: Placement, dx: number): ContourPoint[] {
  const n = loop.length
  if (n < 3) return []
  const placed = place([loop], placement)[0].map(([x, y]) => [x / dx, y / dx] as Pt)
  // Arc length from the trailing edge (largest x at zero incidence).
  let te = 0
  let le = 0
  for (let k = 1; k < n; k++) {
    if (loop[k][0] > loop[te][0]) te = k
    if (loop[k][0] < loop[le][0]) le = k
  }
  const cumulative = new Float64Array(n + 1)
  for (let m = 0; m < n; m++) {
    const a = loop[(te + m) % n]
    const b = loop[(te + m + 1) % n]
    cumulative[m + 1] = cumulative[m] + Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const perimeter = cumulative[n] || 1
  const leS = cumulative[(le - te + n) % n] / perimeter
  const x0 = loop[le][0]
  const chord = loop[te][0] - x0 || 1
  const out: ContourPoint[] = []
  for (let c = 0; c < cells.length; c += 2) {
    const cx = cells[c] + 0.5
    const cy = cells[c + 1] + 0.5
    let best = Infinity
    let bestM = 0
    let bestT = 0
    for (let m = 0; m < n; m++) {
      const a = placed[(te + m) % n]
      const b = placed[(te + m + 1) % n]
      const ex = b[0] - a[0]
      const ey = b[1] - a[1]
      const len2 = ex * ex + ey * ey || 1e-30
      const t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cy - a[1]) * ey) / len2))
      const d = (a[0] + t * ex - cx) ** 2 + (a[1] + t * ey - cy) ** 2
      if (d < best) {
        best = d
        bestM = m
        bestT = t
      }
    }
    if (best > 4) continue
    const a = loop[(te + bestM) % n]
    const b = loop[(te + bestM + 1) % n]
    const px = a[0] + bestT * (b[0] - a[0])
    const pa = placed[(te + bestM) % n]
    const pb = placed[(te + bestM + 1) % n]
    const s = (cumulative[bestM] + bestT * (cumulative[bestM + 1] - cumulative[bestM])) / perimeter
    out.push({
      i: cells[c],
      j: cells[c + 1],
      xc: (px - x0) / chord,
      s,
      upper: s <= leS,
      x: pa[0] + bestT * (pb[0] - pa[0]),
      y: pa[1] + bestT * (pb[1] - pa[1]),
    })
  }
  return out
}
