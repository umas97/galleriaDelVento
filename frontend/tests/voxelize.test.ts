// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 40 (SPEC §24.4): the voxels of the 3D tunnel -- sphere, cube, torus,
// cube with a hole -- and the geometry the 3D planner is given (rotations,
// box, frontal area).
import { describe, expect, it } from 'vitest'
import {
  boxOf,
  caseRotation,
  frontalArea,
  turnBody,
  voxelFrontalArea,
  voxelize,
  type Grid3,
  type Vec3,
} from '../src/sim3d/voxelize'
import { bboxCentre, cubeWithSmallHole, torus, uvSphere, type Mesh } from './synthetic'

function count(v: Uint8Array): number {
  let n = 0
  for (const c of v) n += c
  return n
}

function cell(v: Uint8Array, g: Grid3, x: number, y: number, z: number): number {
  return v[x + g.nx * (y + g.ny * z)]
}

const at = (m: Mesh, yaw = 0, pitch = 0) => turnBody(m.positions, bboxCentre(m), yaw, pitch)

describe('test 40: voxels', () => {
  const sphere = uvSphere(1, 96, 192)
  const sGrid: Grid3 = { nx: 48, ny: 48, nz: 48, dx: 0.05, offset: [1.2, 1.2, 1.2] }

  it('a sphere has its volume, closed or by majority', () => {
    const body = at(sphere)
    const closed = voxelize(body, sphere.indices, sGrid, true)
    const volume = count(closed) * sGrid.dx ** 3
    expect(volume / ((4 / 3) * Math.PI)).toBeCloseTo(1, 2)
    expect(Math.abs(volume / ((4 / 3) * Math.PI) - 1)).toBeLessThan(0.01)
    expect(cell(closed, sGrid, 24, 24, 24)).toBe(1)
    expect(cell(closed, sGrid, 2, 24, 24)).toBe(0)
    const voted = voxelize(body, sphere.indices, sGrid, false)
    let differ = 0
    for (let i = 0; i < voted.length; i++) differ += voted[i] !== closed[i] ? 1 : 0
    expect(differ / count(closed)).toBeLessThan(0.005)
    // Seen from upstream it is a disc of radius 20 cells.
    expect(voxelFrontalArea(closed, 48, 48, 48) / (Math.PI * 400)).toBeCloseTo(1, 1)
  })

  // The unit cube spans [0.148, 1.148] in the chamber: cell centres 0.15 ... 1.05
  // are inside, ten per axis, and the ray x = y = 0.65 runs through the hole.
  const cGrid: Grid3 = { nx: 13, ny: 13, nz: 13, dx: 0.1, offset: [0.648, 0.648, 0.648] }

  it('a cube fills exactly the cells whose centres it holds', () => {
    const cube = cubeWithSmallHole(false)
    const v = voxelize(at(cube), cube.indices, cGrid, true)
    expect(count(v)).toBe(1000)
    expect(cell(v, cGrid, 1, 1, 1)).toBe(1)
    expect(cell(v, cGrid, 10, 10, 10)).toBe(1)
    expect(cell(v, cGrid, 0, 5, 5)).toBe(0)
    expect(cell(v, cGrid, 11, 5, 5)).toBe(0)
  })

  it('a cube with a hole: the ray through it abstains and the majority fills the cube', () => {
    const cube = cubeWithSmallHole(true)
    const body = at(cube)
    // Along z alone the column under the hole has one crossing: it stays empty.
    const zOnly = voxelize(body, cube.indices, cGrid, true)
    expect(count(zOnly)).toBe(990)
    expect(cell(zOnly, cGrid, 6, 6, 5)).toBe(0)
    const voted = voxelize(body, cube.indices, cGrid, false)
    expect(count(voted)).toBe(1000)
    expect(cell(voted, cGrid, 6, 6, 5)).toBe(1)
  })

  it('a torus has its volume and an empty hole', () => {
    const t = torus(2, 0.5, 192, 96)
    const g: Grid3 = { nx: 108, ny: 108, nz: 24, dx: 0.05, offset: [2.7, 2.7, 0.6] }
    const v = voxelize(at(t), t.indices, g, true)
    const volume = count(v) * g.dx ** 3
    expect(Math.abs(volume / (2 * Math.PI ** 2 * 2 * 0.25) - 1)).toBeLessThan(0.01)
    expect(cell(v, g, 54, 54, 12)).toBe(0) // the centre of the hole
    expect(cell(v, g, 54 + 40, 54, 12)).toBe(1) // inside the ring, 2 m from the axis
  })
})

describe('the turned body and its frontal area', () => {
  it('pitch raises the nose, yaw turns it anticlockwise from above', () => {
    const r = caseRotation(0, 10)
    const nose: Vec3 = [-1, 0, 0]
    const z = r[6] * nose[0] + r[7] * nose[1] + r[8] * nose[2]
    expect(z).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 12)
    const yaw = caseRotation(90, 0)
    // +x goes to +y.
    expect([yaw[0], yaw[3], yaw[6]].map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1, 0])
  })

  it('the box follows the rotations', () => {
    const cube = cubeWithSmallHole(false)
    // Stretch it into a 4 × 2 × 1 box.
    const positions = cube.positions.map((v, i) => v * [4, 2, 1][i % 3])
    const box = boxOf(turnBody(positions, [2, 1, 0.5], 90, 0))
    expect(box[4] - box[1]).toBeCloseTo(4, 9)
    expect(box[3] - box[0]).toBeCloseTo(2, 9)
    const pitched = boxOf(turnBody(positions, [2, 1, 0.5], 0, 90))
    expect(pitched[5] - pitched[2]).toBeCloseTo(4, 9)
  })

  it('frontal areas of a sphere, a cube and a torus', () => {
    const sphere = uvSphere(1, 96, 192)
    expect(frontalArea(at(sphere), sphere.indices) / Math.PI).toBeCloseTo(1, 2)
    const cube = cubeWithSmallHole(false)
    expect(frontalArea(at(cube), cube.indices)).toBeCloseTo(1, 2)
    // A torus about z seen along x: a 4 × 1 band with two half discs.
    const t = torus(2, 0.5, 192, 96)
    expect(frontalArea(at(t), t.indices) / (4 + Math.PI / 4)).toBeCloseTo(1, 2)
    // Turned 90° about y it is seen face on: the ring's area.
    expect(frontalArea(at(t, 0, 90), t.indices) / (Math.PI * (2.5 ** 2 - 1.5 ** 2))).toBeCloseTo(1, 2)
  })
})
