// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 8: the section cut (SPEC §7.2), on analytic cases.
import { describe, expect, it } from 'vitest'
import { perimeter, signedArea, type Pt } from '../src/profile/geometry'
import { SlicerClient, type WorkerLike } from '../src/section/client'
import type { SliceAttitude } from '../src/section/frame'
import { chainPieces, simplifyLoop } from '../src/section/loops'
import type { FromWorker, ToWorker } from '../src/section/protocol'
import { SliceIndex, argsortFloat32, type CutResult } from '../src/section/slicer'
import { bboxCentre, cubeWithSmallHole, taperedWing, torus, uvSphere, type Mesh } from './synthetic'

const VERTICAL: SliceAttitude = { plane: 'vertical', roll: 0, tilt: 0 }
const HORIZONTAL: SliceAttitude = { plane: 'horizontal', roll: 0, tilt: 0 }
const FINE = 1e-4 // cell size: simplification well below the mesh's own facets

function index(mesh: Mesh, attitude = VERTICAL) {
  return new SliceIndex(mesh.positions, mesh.indices, bboxCentre(mesh), attitude)
}

const extentX = (loop: Pt[]) => Math.max(...loop.map((p) => p[0])) - Math.min(...loop.map((p) => p[0]))

describe('test 8: cutting sections', () => {
  it('cuts a sphere of radius 1 at depth 0.5 into one circle of area 0.75 pi', () => {
    const cut = index(uvSphere()).cut(0.5, FINE)
    expect(cut.loops).toHaveLength(1)
    expect(cut.open).toHaveLength(0)
    expect(cut.repaired).toBe(false)
    expect(signedArea(cut.loops[0])).toBeGreaterThan(0)
    expect(Math.abs(signedArea(cut.loops[0]) / (Math.PI * 0.75) - 1)).toBeLessThan(0.005)
  })

  it('cuts the same sphere horizontally', () => {
    const cut = index(uvSphere(), HORIZONTAL).cut(-0.5, FINE)
    expect(cut.loops).toHaveLength(1)
    expect(Math.abs(signedArea(cut.loops[0]) / (Math.PI * 0.75) - 1)).toBeLessThan(0.005)
  })

  it('cuts a torus through its axis into two loops, vertices lying on the plane', () => {
    const cut = index(torus()).cut(0, FINE)
    expect(cut.loops).toHaveLength(2)
    const centres = cut.loops.map((l) => l.reduce((s, p) => s + p[0], 0) / l.length).sort((a, b) => a - b)
    expect(centres[0]).toBeCloseTo(-2, 2)
    expect(centres[1]).toBeCloseTo(2, 2)
    for (const loop of cut.loops) expect(Math.abs(signedArea(loop) / (Math.PI * 0.25) - 1)).toBeLessThan(0.005)
  })

  it('cuts a horizontal torus into a ring: an outer loop and a hole', () => {
    const cut = index(torus(), HORIZONTAL).cut(0.1, FINE)
    expect(cut.loops).toHaveLength(2)
    const areas = cut.loops.map(signedArea).sort((a, b) => a - b)
    expect(areas[0]).toBeLessThan(0) // the hole, clockwise
    expect(areas[1]).toBeGreaterThan(0)
  })

  it('finds the expected chord of a tapered wing at three depths', () => {
    const wing = index(taperedWing(2, 1, 0.4))
    for (const fraction of [0.1, 0.5, 0.9]) {
      const cut = wing.cut(2 * fraction, FINE)
      expect(cut.loops).toHaveLength(1)
      const expected = 1 + (0.4 - 1) * fraction
      expect(Math.abs(extentX(cut.loops[0]) / expected - 1)).toBeLessThan(0.005)
    }
  })

  it('closes the loop across a gap smaller than 1% of the section', () => {
    const cube = index(cubeWithSmallHole())
    const cut = cube.cut(0.5025, FINE)
    expect(cut.loops).toHaveLength(1)
    expect(cut.open).toHaveLength(0)
    expect(Math.abs(signedArea(cut.loops[0]))).toBeCloseTo(1, 3)
    // Where the mesh is whole the same cube cuts without any joining.
    expect(cube.cut(0.25 + 0.01, FINE).loops).toHaveLength(1)
  })

  it('chains an unwelded mesh (a triangle soup) by distance', () => {
    const welded = uvSphere(1, 48, 96)
    const n = welded.indices.length
    const positions = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) positions.set(welded.positions.subarray(3 * welded.indices[i], 3 * welded.indices[i] + 3), 3 * i)
    const soup = { positions, indices: Uint32Array.from({ length: n }, (_, i) => i) }
    const cut = index(soup).cut(0.5, FINE)
    expect(cut.loops).toHaveLength(1)
    expect(cut.open).toHaveLength(0)
    expect(Math.abs(signedArea(cut.loops[0]) / (Math.PI * 0.75) - 1)).toBeLessThan(0.01)
  })

  it('gives an empty result outside the model', () => {
    const sphere = index(uvSphere())
    expect(sphere.info.depthMin).toBeCloseTo(-1, 3)
    expect(sphere.info.depthMax).toBeCloseTo(1, 3)
    for (const depth of [-1.5, 1.01, 7]) {
      const cut = sphere.cut(depth, FINE)
      expect(cut.loops).toHaveLength(0)
      expect(cut.open).toHaveLength(0)
    }
  })

  it('turns the model, not the plane: a cube rolled by 45 degrees', () => {
    const cube = cubeWithSmallHole()
    const cut = index(cube, { plane: 'vertical', roll: 45, tilt: 0 }).cut(0.5, FINE)
    expect(cut.loops).toHaveLength(1)
    expect(Math.abs(signedArea(cut.loops[0]))).toBeCloseTo(Math.SQRT2, 3)
    // Tilting about z by 90 degrees turns the span of a wing along the wind.
    const tilted = index(taperedWing(2, 1, 0.4), { plane: 'horizontal', roll: 0, tilt: 0 })
    expect(tilted.info.envelope.maxY - tilted.info.envelope.minY).toBeCloseTo(2, 3)
  })

  it('drops slivers under four cells and says how many', () => {
    const cut = index(uvSphere(1, 48, 96)).cut(0.99999, 0.01)
    expect(cut.loops).toHaveLength(0)
    expect(cut.droppedSmall).toBe(1)
  })

  it('simplifies to half a cell', () => {
    const fine = index(uvSphere()).cut(0, 1e-5).loops[0]
    const coarse = index(uvSphere()).cut(0, 0.02).loops[0]
    expect(coarse.length).toBeLessThan(fine.length / 2)
    expect(Math.abs(perimeter(coarse) / perimeter(fine) - 1)).toBeLessThan(0.01)
  })

  it('indexes a sample of a big mesh while dragging', () => {
    const sphere = uvSphere()
    const sample = new SliceIndex(sphere.positions, sphere.indices, [0, 0, 0], VERTICAL, 5000)
    expect(sample.info.indexed).toBeLessThanOrEqual(5000)
    expect(sample.info.triangles).toBe(sphere.indices.length / 3)
  })
})

describe('building blocks', () => {
  it('radix-sorts floats, negatives included', () => {
    const values = new Float32Array([3.5, -1, 0, -7.25, 2, -2.5e-8, 1e-30, -1e30, 1e30])
    const order = argsortFloat32(values)
    const sorted = Array.from(order, (i) => values[i])
    expect(sorted).toEqual([...values].sort((a, b) => a - b))
  })

  it('chains pieces in any direction and leaves open ones open', () => {
    const square = [
      [0, 0, 1, 0],
      [1, 1, 1, 0], // reversed
      [1, 1, 0, 1],
      [0, 0, 0, 1], // reversed
    ]
    const open = [[5, 5, 6, 5], [6, 5, 6, 6]]
    const { loops, open: left } = chainPieces([...square, ...open], 1e-9)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(8)
    expect(left).toHaveLength(1)
    expect(left[0]).toHaveLength(6)
  })

  it('simplification keeps the corners of a dense square', () => {
    const dense: number[] = []
    for (let i = 0; i < 100; i++) dense.push(i / 100, 0)
    for (let i = 0; i < 100; i++) dense.push(1, i / 100)
    for (let i = 0; i < 100; i++) dense.push(1 - i / 100, 1)
    for (let i = 0; i < 100; i++) dense.push(0, 1 - i / 100)
    expect(simplifyLoop(dense, 1e-6)).toHaveLength(8)
  })
})

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null
  sent: ToWorker[] = []
  postMessage(message: ToWorker): void {
    this.sent.push(message)
  }
  reply(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>)
  }
}

const EMPTY: CutResult = {
  loops: [],
  rawLoops: null,
  repaired: false,
  issues: [],
  open: [],
  droppedSmall: 0,
  segments: 0,
  ms: 0,
}

describe('test 8: superseded results are dropped', () => {
  it('keeps one cut in flight and only the latest request pending', () => {
    const worker = new FakeWorker()
    const client = new SlicerClient(worker)
    const shown: number[] = []
    client.onCut = ({ depth }) => shown.push(depth)
    client.cut(0.1, 0.01)
    client.cut(0.2, 0.01)
    client.cut(0.3, 0.01)
    const cuts = () => worker.sent.filter((m) => m.type === 'cut') as Extract<ToWorker, { type: 'cut' }>[]
    expect(cuts().map((m) => m.depth)).toEqual([0.1])
    worker.reply({ type: 'cut', seq: cuts()[0].seq, index: -1, depth: 0.1, result: EMPTY })
    expect(cuts().map((m) => m.depth)).toEqual([0.1, 0.3]) // 0.2 never computed
    expect(shown).toEqual([0.1])
  })

  it('drops a result older than one already shown', () => {
    const worker = new FakeWorker()
    const client = new SlicerClient(worker)
    const shown: number[] = []
    client.onCut = ({ seq }) => shown.push(seq)
    worker.reply({ type: 'cut', seq: 5, index: 0, depth: 0, result: EMPTY })
    worker.reply({ type: 'cut', seq: 3, index: 0, depth: 0, result: EMPTY })
    worker.reply({ type: 'cut', seq: 6, index: -1, depth: 0, result: EMPTY }) // made on an older index
    worker.reply({ type: 'cut', seq: 7, index: 1, depth: 0, result: EMPTY })
    expect(shown).toEqual([5, 7])
  })

  it('cuts again at the current depth when the rotation changes the index', () => {
    const worker = new FakeWorker()
    const client = new SlicerClient(worker)
    client.cut(0.4, 0.01)
    const first = worker.sent.at(-1) as Extract<ToWorker, { type: 'cut' }>
    worker.reply({ type: 'cut', seq: first.seq, index: first.index, depth: 0.4, result: EMPTY })
    client.setAttitude({ plane: 'vertical', roll: 10, tilt: 0 }, true)
    client.setAttitude({ plane: 'vertical', roll: 20, tilt: 0 }, true) // pending, replaces nothing yet
    client.setAttitude({ plane: 'vertical', roll: 30, tilt: 0 }, false) // replaces roll 20
    const indexes = () => worker.sent.filter((m) => m.type === 'index') as Extract<ToWorker, { type: 'index' }>[]
    expect(indexes().map((m) => m.attitude.roll)).toEqual([10])
    const info = { triangles: 1, indexed: 1, depthMin: 0, depthMax: 1, envelope: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, ms: 1 }
    worker.reply({ type: 'indexed', id: indexes()[0].id, info })
    expect(indexes().map((m) => [m.attitude.roll, m.preview])).toEqual([
      [10, true],
      [30, false],
    ])
    worker.reply({ type: 'indexed', id: indexes()[1].id, info })
    const last = worker.sent.at(-1) as Extract<ToWorker, { type: 'cut' }>
    expect(last).toMatchObject({ type: 'cut', depth: 0.4, index: indexes()[1].id })
  })
})
