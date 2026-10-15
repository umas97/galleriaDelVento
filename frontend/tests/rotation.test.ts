// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { IDENTITY, Y_UP, multiply, quarterTurn, rotatedExtents, turn } from '../src/lib/rotation'

const apply = (r: number[][], v: number[]) => r.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])

describe('quarter turns', () => {
  it('four turns about any axis give the identity', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      let r = IDENTITY
      for (let i = 0; i < 4; i++) r = turn(r, axis, 1)
      expect(r).toEqual(IDENTITY)
    }
  })
  it('a turn and its inverse cancel', () => {
    expect(multiply(quarterTurn('y', 1), quarterTurn('y', -1))).toEqual(IDENTITY)
  })
  it('turns counter-clockwise looking from +axis', () => {
    expect(apply(quarterTurn('z', 1), [1, 0, 0])).toEqual([0, 1, 0])
    expect(apply(quarterTurn('x', 1), [0, 1, 0])).toEqual([0, 0, 1])
    expect(apply(quarterTurn('y', 1), [0, 0, 1])).toEqual([1, 0, 0])
  })
  it('Y up takes the file y axis to tunnel z', () => {
    expect(apply(Y_UP, [0, 1, 0])).toEqual([0, 0, 1])
    expect(rotatedExtents([4, 2, 1], Y_UP)).toEqual([4, 1, 2])
  })
})
