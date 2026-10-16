// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The mean fields of a saved result (SPEC §11.1), as the server sends them
// (`fields.bin`: a JSON header, float32 u, v, cp, vorticity in real units,
// rows from the bottom of the chamber, then the solid mask), and what the
// study pages need to draw them: the field shown, its colour range, the body's
// box and a frame around it. Frames have the same size in metres for every
// study compared (SPEC §11.4: «lo stesso riquadro»).

export type MeanFields = {
  nx: number
  ny: number
  dx: number
  u: Float32Array
  v: Float32Array
  cp: Float32Array
  vorticity: Float32Array
  solid: Uint8Array
  samples: number
}

export type FieldShown = 'speed' | 'cp' | 'vorticity'

/** A rectangle in chamber metres. */
export type Frame = { x0: number; y0: number; x1: number; y1: number }

export function parseFields(buffer: ArrayBuffer): MeanFields {
  const view = new DataView(buffer)
  const length = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as {
    nx: number
    ny: number
    dx: number
    names: string[]
    samples: number
  }
  const n = header.nx * header.ny
  let at = 4 + length
  const arrays: Record<string, Float32Array> = {}
  for (const name of header.names) {
    arrays[name] = new Float32Array(buffer.slice(at, at + 4 * n))
    at += 4 * n
  }
  return {
    nx: header.nx,
    ny: header.ny,
    dx: header.dx,
    u: arrays.u,
    v: arrays.v,
    cp: arrays.cp,
    vorticity: arrays.vorticity,
    solid: new Uint8Array(buffer.slice(at, at + n)),
    samples: header.samples,
  }
}

/** The values of a field, cell by cell (speed from u and v). */
export function valuesOf(f: MeanFields, shown: FieldShown): Float32Array {
  if (shown === 'cp') return f.cp
  if (shown === 'vorticity') return f.vorticity
  const out = new Float32Array(f.u.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(f.u[i], f.v[i])
  return out
}

/** The 2nd–98th percentile range over the fluid cells; symmetric about 0 if `diverging`. */
export function rangeOf(f: MeanFields, values: Float32Array, diverging: boolean): [number, number] {
  const fluid: number[] = []
  const stride = Math.max(1, Math.floor(values.length / 200_000))
  for (let i = 0; i < values.length; i += stride) if (!f.solid[i] && Number.isFinite(values[i])) fluid.push(values[i])
  if (!fluid.length) return [0, 1]
  fluid.sort((a, b) => a - b)
  const lo = fluid[Math.floor(0.02 * (fluid.length - 1))]
  const hi = fluid[Math.floor(0.98 * (fluid.length - 1))]
  if (diverging) {
    const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-12)
    return [-m, m]
  }
  return [Math.min(0, lo), Math.max(hi, lo + 1e-12)]
}

/** The union of ranges (one colour scale for every study compared). */
export function unionRange(ranges: [number, number][]): [number, number] {
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]
}

/** The box of the solid cells, metres; null without a body. */
export function bodyBox(f: MeanFields): Frame | null {
  let i0 = Infinity
  let i1 = -Infinity
  let j0 = Infinity
  let j1 = -Infinity
  for (let j = 0; j < f.ny; j++)
    for (let i = 0; i < f.nx; i++)
      if (f.solid[j * f.nx + i]) {
        if (i < i0) i0 = i
        if (i > i1) i1 = i
        if (j < j0) j0 = j
        if (j > j1) j1 = j
      }
  if (!Number.isFinite(i0)) return null
  return { x0: i0 * f.dx, y0: j0 * f.dx, x1: (i1 + 1) * f.dx, y1: (j1 + 1) * f.dx }
}

/**
 * A frame of `length` metres across (aspect `aspect` = height / width) around
 * a body: the body's front at 20% of the width, centred vertically. Without a
 * body: the whole chamber.
 */
export function frameAround(f: MeanFields, length: number | null, aspect: number): Frame {
  const box = bodyBox(f)
  if (!box || !length) return { x0: 0, y0: 0, x1: f.nx * f.dx, y1: f.ny * f.dx }
  const height = length * aspect
  const cy = (box.y0 + box.y1) / 2
  const x0 = box.x0 - 0.2 * length
  return { x0, y0: cy - height / 2, x1: x0 + length, y1: cy + height / 2 }
}

/** The width of a frame showing a body of length L with its wake. */
export function frameWidthFor(bodyLength: number): number {
  return 3.2 * bodyLength
}
