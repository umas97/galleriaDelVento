// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's views without a GPU (SPEC §24, Phase 7b): the camera, where
// the drawn model sits (it must coincide with the voxels the flow sees), the
// rake, the points the colour ranges are read at, the ranges, and the page's
// side of the geometry thread.
import { describe, expect, it } from 'vitest'
import { OrbitCamera, lookAt, multiply, perspective, transform, type Vec3 } from '../src/sim3d/camera'
import { apply, autoRange, hexColor, modelMatrix, planePoints, rakeNozzles, rotationMatrix, surfacePoints, vertexNormals } from '../src/sim3d/scene'
import { VoxelClient, type FromVoxelWorker, type ToVoxelWorker, type WorkerLike } from '../src/sim3d/voxelProtocol'
import { boxOf, turnBody, voxelize } from '../src/sim3d/voxelize'
import { ahmedBody, bboxCentre, uvSphere } from './synthetic'

const close = (a: number[], b: number[], digits = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('camera', () => {
  it('projects the target to the centre of the view, depth between 0 and 1', () => {
    const cam = new OrbitCamera()
    cam.fit([1, 2, 3], 2)
    const clip = transform(cam.viewProj(16 / 9), [1, 2, 3])
    expect(clip[0] / clip[3]).toBeCloseTo(0, 6)
    expect(clip[1] / clip[3]).toBeCloseTo(0, 6)
    const z = clip[2] / clip[3]
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(1)
  })

  it('keeps z up: a point above the target is above the centre', () => {
    const cam = new OrbitCamera()
    cam.fit([0, 0, 0], 1, 'side')
    const clip = transform(cam.viewProj(1), [0, 0, 0.2])
    expect(clip[1] / clip[3]).toBeGreaterThan(0)
  })

  it('looks downstream from the front view, from above from the top', () => {
    const cam = new OrbitCamera()
    cam.fit([0, 0, 0], 1, 'front')
    expect(cam.eye()[0]).toBeLessThan(0)
    cam.look('top')
    const eye = cam.eye()
    expect(eye[2]).toBeGreaterThan(Math.hypot(eye[0], eye[1]) * 10)
  })

  it('orbits about the target at a fixed distance, and the elevation stops short of the pole', () => {
    const cam = new OrbitCamera()
    cam.fit([1, 1, 1], 1)
    const d = (e: Vec3) => Math.hypot(e[0] - 1, e[1] - 1, e[2] - 1)
    const before = d(cam.eye())
    cam.orbit(200, -150)
    expect(d(cam.eye())).toBeCloseTo(before, 9)
    cam.orbit(0, 10_000)
    expect(cam.elevation).toBeLessThan(Math.PI / 2)
  })

  it('pans the target with the pointer, and zoom stays within limits', () => {
    const cam = new OrbitCamera()
    cam.fit([0, 0, 0], 1, 'front')
    cam.pan(100, 0, 500)
    // Looking downstream (+x), the right of the view is −y: dragging right moves the target left.
    expect(cam.target[1]).toBeGreaterThan(0)
    cam.zoom(1e-9)
    expect(cam.distance).toBeGreaterThan(0)
    cam.zoom(1e12)
    expect(cam.distance).toBeLessThan(100)
  })

  it('has WebGPU depth: near maps to 0, far to 1', () => {
    const p = perspective(1, 1, 0.5, 50)
    const view = lookAt([0, 0, 0], [0, 0, -1], [0, 1, 0])
    const m = multiply(p, view)
    const near = transform(m, [0, 0, -0.5])
    const far = transform(m, [0, 0, -50])
    expect(near[2] / near[3]).toBeCloseTo(0, 6)
    expect(far[2] / far[3]).toBeCloseTo(1, 6)
  })
})

describe('the drawn model sits where the voxels are', () => {
  const car = ahmedBody()
  const pivot = bboxCentre(car)
  const offset: Vec3 = [1.6, 0.74, 0.2]

  it('model matrix = offset + R (p − pivot), the same turn as the voxels', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [20, 0],
      [-35, 8],
      [90, -12],
    ]) {
      const m = modelMatrix(pivot, offset, yaw, pitch)
      const turned = turnBody(car.positions, pivot, yaw, pitch)
      for (const v of [0, 7, 30, car.positions.length / 3 - 1]) {
        const p: Vec3 = [car.positions[3 * v], car.positions[3 * v + 1], car.positions[3 * v + 2]]
        close(apply(m, p), [turned[3 * v] + offset[0], turned[3 * v + 1] + offset[1], turned[3 * v + 2] + offset[2]])
      }
      // Normals turn with the rotation alone.
      close(apply(rotationMatrix(yaw, pitch), [0, 0, 1], 0), apply(modelMatrix([0, 0, 0], [0, 0, 0], yaw, pitch), [0, 0, 1]))
    }
  })

  it('the cells under the drawn surface are solid', () => {
    const sphere = uvSphere(0.5, 48, 96)
    const plan = { nx: 40, ny: 40, nz: 40, dx: 0.05 }
    const p: Vec3 = [1, 1, 1]
    const voxels = voxelize(turnBody(sphere.positions, [0, 0, 0], 0, 0), sphere.indices, { ...plan, offset: p }, true)
    const m = modelMatrix([0, 0, 0], p, 0, 0)
    const normals = vertexNormals(sphere.positions, sphere.indices)
    let inside = 0
    let outside = 0
    for (let v = 0; v < sphere.positions.length / 3; v += 7) {
      const q = apply(m, [sphere.positions[3 * v], sphere.positions[3 * v + 1], sphere.positions[3 * v + 2]])
      const n = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]]
      const cellOf = (s: number) => q.map((x, i) => Math.floor((x + s * n[i] * plan.dx) / plan.dx))
      const solid = (c: number[]) => voxels[c[0] + plan.nx * (c[1] + plan.ny * c[2])]
      inside += solid(cellOf(-1))
      outside += solid(cellOf(1))
    }
    // A cell inward of the surface is solid, a cell outward is fluid.
    const total = Math.ceil(sphere.positions.length / 3 / 7)
    expect(inside).toBe(total)
    expect(outside).toBe(0)
  })

  it('vertex normals point outward on a closed mesh', () => {
    const sphere = uvSphere(1, 24, 48)
    const n = vertexNormals(sphere.positions, sphere.indices)
    for (let v = 0; v < sphere.positions.length / 3; v++) {
      const d = sphere.positions[3 * v] * n[3 * v] + sphere.positions[3 * v + 1] * n[3 * v + 1] + sphere.positions[3 * v + 2] * n[3 * v + 2]
      expect(d).toBeGreaterThan(0.99)
    }
  })
})

describe('views', () => {
  const plan = { nx: 100, ny: 40, nz: 30, dx: 0.02 }

  it('the rake spreads its nozzles across the wind, inside the chamber', () => {
    const h = rakeNozzles({ orientation: 'horizontal', x: 0.5, across: 0.3, centre: 0.4, span: 0.2, nozzles: 5 }, plan)
    expect(h.length).toBe(20)
    for (let k = 0; k < 5; k++) {
      expect(h[4 * k]).toBeCloseTo(25, 6)
      expect(h[4 * k + 2]).toBeCloseTo(15, 6)
    }
    close([h[1], h[17]], [15, 25])
    const v = rakeNozzles({ orientation: 'vertical', x: 0.5, across: 0.4, centre: 0.3, span: 10, nozzles: 3 }, plan)
    // A span wider than the chamber stays inside it.
    expect(v[2]).toBeGreaterThan(0)
    expect(v[10]).toBeLessThan(plan.nz)
    expect(v[1]).toBeCloseTo(20, 6)
  })

  it('plane points are cell centres of the plane, without the body', () => {
    const voxels = new Uint8Array(plan.nx * plan.ny * plan.nz)
    voxels[50 + plan.nx * (20 + plan.ny * 15)] = 1
    const pts = planePoints(1, 20.5 * plan.dx, plan, voxels, 1e9)
    expect(pts.length / 4).toBe(plan.nx * plan.nz - 1)
    for (let k = 0; k < pts.length; k += 4) expect(pts[k + 1]).toBeCloseTo(20.5 / plan.ny, 6)
    expect(planePoints(2, 0.3, plan, null, 500).length / 4).toBeLessThanOrEqual(600)
  })

  it('surface points sit half a cell or more outside the body, in the chamber', () => {
    const sphere = uvSphere(0.2, 24, 48)
    const body = { positions: sphere.positions, indices: sphere.indices, normals: vertexNormals(sphere.positions, sphere.indices) }
    const centre: Vec3 = [1, 0.4, 0.3]
    const pts = surfacePoints(body, modelMatrix([0, 0, 0], centre, 0, 0), rotationMatrix(0, 0), plan, 100)
    expect(pts.length / 4).toBeGreaterThan(50)
    const size = [plan.nx * plan.dx, plan.ny * plan.dx, plan.nz * plan.dx]
    for (let k = 0; k < pts.length; k += 4) {
      const r = Math.hypot(...[0, 1, 2].map((a) => pts[k + a] * size[a] - centre[a]))
      expect(r).toBeGreaterThan(0.2 + 0.5 * plan.dx)
    }
  })

  it('colour ranges: 2nd to 98th percentile, symmetric for Cp', () => {
    const values = Array.from({ length: 1001 }, (_, i) => i / 100)
    close(autoRange(values, false)!, [0.2, 9.8])
    close(autoRange([-0.5, 0.1, 0.9, 1, NaN], true)!, [-0.9, 0.9])
    expect(autoRange([], false)).toBeNull()
    expect(autoRange([3, 3, 3], false)![1]).toBeGreaterThan(3)
  })

  it('theme colours become RGBA', () => {
    close(hexColor('#ff8000'), [1, 128 / 255, 0, 1])
    close(hexColor('#fff', 0.5), [1, 1, 1, 0.5])
  })
})

describe('geometry thread client', () => {
  /** A worker that answers like voxel.worker.ts, synchronously, from the same functions. */
  function fakeWorker(): WorkerLike & { sent: ToVoxelWorker[] } {
    const sphere = uvSphere(0.5, 24, 48)
    const w = {
      sent: [] as ToVoxelWorker[],
      onmessage: null as ((e: MessageEvent<FromVoxelWorker>) => void) | null,
      postMessage(m: ToVoxelWorker) {
        w.sent.push(m)
        const reply = (data: FromVoxelWorker) => queueMicrotask(() => w.onmessage?.({ data } as MessageEvent<FromVoxelWorker>))
        if (m.type === 'load') reply({ type: 'loaded', id: m.id, pivot: [0, 0, 0], size: [1, 1, 1], triangles: sphere.indices.length / 3 })
        else if (m.type === 'body') {
          const body = turnBody(sphere.positions, [0, 0, 0], m.yaw, m.pitch)
          reply({ type: 'body', id: m.id, box: boxOf(body), area: Math.PI / 4 })
        } else if (m.type === 'voxels') {
          if (m.grid.nx > 1000) reply({ type: 'error', id: m.id, message: 'troppo grande' })
          else {
            const voxels = voxelize(turnBody(sphere.positions, [0, 0, 0], m.yaw, m.pitch), sphere.indices, m.grid, m.closed)
            reply({ type: 'voxels', id: m.id, voxels, frontalCells: 1 })
          }
        }
      },
    }
    return w
  }

  it('answers each request with its own promise, errors as rejections', async () => {
    const w = fakeWorker()
    const client = new VoxelClient(w)
    const loaded = await client.load(new ArrayBuffer(8))
    expect(loaded.triangles).toBeGreaterThan(0)
    const [a, b] = await Promise.all([client.body(0, 0), client.body(90, 0)])
    expect(a.box[3]).toBeCloseTo(0.5, 2)
    expect(b.box[4]).toBeCloseTo(0.5, 2)
    const v = await client.voxels(0, 0, { nx: 24, ny: 24, nz: 24, dx: 0.05, offset: [0.6, 0.6, 0.6] }, true)
    expect(v.voxels.reduce((s, x) => s + x, 0)).toBeGreaterThan(0)
    await expect(client.voxels(0, 0, { nx: 2000, ny: 1, nz: 1, dx: 1, offset: [0, 0, 0] }, true)).rejects.toThrow('troppo grande')
    expect(new Set(w.sent.map((m) => m.id)).size).toBe(w.sent.length)
  })
})
