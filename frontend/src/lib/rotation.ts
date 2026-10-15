// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Base orientation as integer matrices: quarter turns compose exactly. The
// backend validates the result (a proper rotation, no mirror).
import type { Rotation } from './types'

export const IDENTITY: Rotation = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/** "L'asse alto del file è Y": +90 degrees about x takes file y to tunnel z. */
export const Y_UP: Rotation = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
]

export type Axis = 'x' | 'y' | 'z'

/** A quarter turn about `axis`, counter-clockwise looking from +axis when `sign` is +1. */
export function quarterTurn(axis: Axis, sign: 1 | -1): Rotation {
  const s = sign
  switch (axis) {
    case 'x':
      return [
        [1, 0, 0],
        [0, 0, -s],
        [0, s, 0],
      ]
    case 'y':
      return [
        [0, 0, s],
        [0, 1, 0],
        [-s, 0, 0],
      ]
    case 'z':
      return [
        [0, -s, 0],
        [s, 0, 0],
        [0, 0, 1],
      ]
  }
}

export function multiply(a: Rotation, b: Rotation): Rotation {
  const out = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + 0),
  )
  return out as Rotation
}

/** Turn the model that is already oriented by `current` a further quarter about `axis`. */
export function turn(current: Rotation, axis: Axis, sign: 1 | -1): Rotation {
  return multiply(quarterTurn(axis, sign), current)
}

/** Extents along the tunnel axes for file extents `e` under `r` (still in file units). */
export function rotatedExtents(e: [number, number, number], r: Rotation): [number, number, number] {
  return [0, 1, 2].map((i) => Math.abs(r[i][0]) * e[0] + Math.abs(r[i][1]) * e[1] + Math.abs(r[i][2]) * e[2]) as [
    number,
    number,
    number,
  ]
}
