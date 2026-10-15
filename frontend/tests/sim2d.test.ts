// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The pure parts of the tunnel: streamlines and the contour for Cp.
import { describe, expect, it } from 'vitest'
import { boundaryCells, contourPoints, mainLoop } from '../src/sim2d/contour'
import { outerLoops, place, rasterize } from '../src/sim2d/mask'
import { defaultSeeds, streamlines, trace, type Field } from '../src/sim2d/streamlines'
import { naca4 } from './synthetic'

function uniformField(w: number, h: number, factor: number, u: number, v: number): Field {
  const data = new Float32Array(w * h * 4)
  for (let k = 0; k < w * h; k++) {
    data[4 * k + 1] = u
    data[4 * k + 2] = v
  }
  return { w, h, factor, data }
}

describe('streamlines', () => {
  it('follow a uniform stream straight to the outlet', () => {
    const f = uniformField(50, 20, 2, 0.08, 0)
    const line = trace(f, 5, 17, 1, 1000)
    const last = line.length - 2
    expect(line[last]).toBeGreaterThan(98)
    expect(line[last + 1]).toBeCloseTo(17, 6)
  })

  it('stop at a body', () => {
    const f = uniformField(50, 20, 2, 0.08, 0)
    for (let j = 0; j < 20; j++) f.data[4 * (j * 50 + 25) + 3] = 1 // a wall at x = 50..52
    const lines = streamlines(f, defaultSeeds(100, 40, 10))
    for (const l of lines) expect(l[l.length - 2]).toBeLessThan(50)
  })

  it('turn with a rotating flow', () => {
    // Solid-body rotation about the centre: streamlines are circles.
    const w = 64
    const data = new Float32Array(w * w * 4)
    for (let j = 0; j < w; j++)
      for (let i = 0; i < w; i++) {
        const x = i + 0.5 - w / 2
        const y = j + 0.5 - w / 2
        data[4 * (j * w + i) + 1] = -y * 0.001
        data[4 * (j * w + i) + 2] = x * 0.001
      }
    const line = trace({ w, h: w, factor: 1, data }, w / 2 + 20, w / 2, 0.5, 200)
    for (let k = 0; k < line.length; k += 2) expect(Math.hypot(line[k] - w / 2, line[k + 1] - w / 2)).toBeCloseTo(20, 1)
  })
})

describe('contour', () => {
  const loop = naca4('0012', 120, 1)
  const placement = { pivot: [0.5, 0] as [number, number], position: [2, 1] as [number, number], angleDeg: 0 }
  const dx = 0.01
  const nx = 400
  const ny = 200
  const mask = rasterize(place(outerLoops([loop], 'orientation'), placement).map((l) => l.map(([x, y]) => [x / dx, y / dx] as [number, number])), nx, ny, 1)

  it('finds the cells around the body, both surfaces', () => {
    const cells = boundaryCells(mask, nx, ny)
    expect(cells.length / 2).toBeGreaterThan(150)
    const points = contourPoints(cells, mainLoop([loop])!, placement, dx)
    expect(points.length).toBe(cells.length / 2)
    const upper = points.filter((p) => p.upper)
    const lower = points.filter((p) => !p.upper)
    expect(upper.length).toBeGreaterThan(50)
    expect(lower.length).toBeGreaterThan(50)
    for (const p of upper) expect(p.j + 0.5).toBeGreaterThanOrEqual(100 - 1)
    for (const p of lower) expect(p.j + 0.5).toBeLessThanOrEqual(100 + 1)
    for (const p of points) {
      expect(p.xc).toBeGreaterThanOrEqual(0)
      expect(p.xc).toBeLessThanOrEqual(1)
    }
  })

  it('follows the incidence', () => {
    const turned = { ...placement, angleDeg: 10 }
    const m = rasterize(place([loop], turned).map((l) => l.map(([x, y]) => [x / dx, y / dx] as [number, number])), nx, ny, 1)
    const points = contourPoints(boundaryCells(m, nx, ny), loop, turned, dx)
    const le = points.reduce((a, b) => (b.xc < a.xc ? b : a))
    const te = points.reduce((a, b) => (b.xc > a.xc ? b : a))
    // Nose up: the leading edge is higher than the trailing edge.
    expect(le.y).toBeGreaterThan(te.y + 10)
  })
})
