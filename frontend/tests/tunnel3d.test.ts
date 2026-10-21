// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's views without a GPU (SPEC §24, Phase 7b): the camera, where
// the drawn model sits (it must coincide with the voxels the flow sees), the
// rake, the points the colour ranges are read at, the ranges, the voxels'
// surface («Mostra i voxel», SPEC §24.8) and the page's side of the geometry
// thread.
import { describe, expect, it } from 'vitest'
import { OrbitCamera, lookAt, multiply, perspective, transform, type Vec3 } from '../src/sim3d/camera'
import {
  apply,
  autoRange,
  hexColor,
  modelMatrix,
  planePoints,
  rakeNozzles,
  rakeShape,
  rotationMatrix,
  surfacePoints,
  vertexNormals,
  voxelSurface,
} from '../src/sim3d/scene'
import type { CasePlan3D, CaseSetup3D } from '../src/lib/types'
import { pointUpload3d } from '../src/tunnel/study3d'
import type { Engine3DResult } from '../src/sim3d/engine'
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

  it('the voxels drawn («Mostra i voxel») are the cells, outer faces only, facing out', () => {
    // Two solid cells side by side along x, and one alone: 10 + 6 faces.
    const plan = { nx: 6, ny: 4, nz: 4, dx: 0.1, offset: [0.3, 0.2, 0.2], yaw_deg: 35, pitch_deg: -10 } as unknown as CasePlan3D
    const voxels = new Uint8Array(6 * 4 * 4)
    const at = (x: number, y: number, z: number) => x + 6 * (y + 4 * z)
    voxels[at(1, 1, 1)] = voxels[at(2, 1, 1)] = voxels[at(4, 2, 2)] = 1
    const pivot: Vec3 = [5, -2, 1]
    const mesh = voxelSurface(voxels, plan, pivot)
    expect(mesh.indices.length).toBe(16 * 6)
    // The model's matrix takes the vertices back to the cell corners in the chamber.
    const m = modelMatrix(pivot, plan.offset, plan.yaw_deg, plan.pitch_deg)
    const r = rotationMatrix(plan.yaw_deg, plan.pitch_deg)
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const q = apply(m, [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]])
      q.forEach((v) => expect(Math.abs(v / plan.dx - Math.round(v / plan.dx))).toBeLessThan(1e-4))
    }
    // Every face looks out of its cell: its centre plus half a cell along the normal is fluid.
    for (let f = 0; f < mesh.indices.length / 6; f++) {
      const corners = [0, 1, 2, 3].map((k) => apply(m, Array.from(mesh.positions.subarray(3 * (4 * f + k), 3 * (4 * f + k) + 3)) as Vec3))
      const centre = [0, 1, 2].map((i) => corners.reduce((a, c) => a + c[i], 0) / 4)
      const n = apply(r, Array.from(mesh.normals.subarray(3 * 4 * f, 3 * 4 * f + 3)) as Vec3, 0)
      const out = centre.map((v, i) => Math.floor((v + 0.5 * plan.dx * n[i]) / plan.dx))
      const inn = centre.map((v, i) => Math.floor((v - 0.5 * plan.dx * n[i]) / plan.dx))
      expect(voxels[at(out[0], out[1], out[2])] ?? 0).toBe(0)
      expect(voxels[at(inn[0], inn[1], inn[2])]).toBe(1)
      // Anticlockwise seen from outside: (b − a) × (c − a) along the normal.
      const [a, b, c] = corners
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      expect(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2]).toBeGreaterThan(0)
    }
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

  it('a grid rake fills a rectangle of the transverse plane, row after row', () => {
    const g = rakeNozzles({ orientation: 'grid', x: 0.5, across: 0.3, centre: 0.4, span: 0.2, nozzles: 3, rows: 2, height: 0.1 }, plan)
    expect(g.length).toBe(4 * 6)
    const cell = (k: number) => [g[4 * k], g[4 * k + 1], g[4 * k + 2]]
    for (let k = 0; k < 6; k++) expect(cell(k)[0]).toBeCloseTo(25, 6)
    // First row at the bottom (z = 0.25 m), columns from y = 0.3 to 0.5 m.
    close([cell(0)[1], cell(1)[1], cell(2)[1]], [15, 20, 25])
    close([cell(0)[2], cell(2)[2]], [12.5, 12.5])
    close([cell(3)[2], cell(5)[2]], [17.5, 17.5])
  })

  it('the panel limits hold whatever the rake asks for', () => {
    expect(rakeShape({ orientation: 'grid', x: 0, across: 0, centre: 0, span: 0, nozzles: 99, rows: 1 })).toEqual({ rows: 2, perRow: 16 })
    expect(rakeShape({ orientation: 'horizontal', x: 0, across: 0, centre: 0, span: 0, nozzles: 99, rows: 9 })).toEqual({ rows: 1, perRow: 48 })
    expect(rakeShape({ orientation: 'grid', x: 0, across: 0, centre: 0, span: 0, nozzles: 16, rows: 16 }).rows * 16).toBe(256) // MAX_NOZZLES in views.ts
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

describe('a 3D result for a study (SPEC §24.2 #7)', () => {
  const plan = { blockage_correction: 0.8 } as unknown as CasePlan3D
  const setup = {} as CaseSetup3D
  const stats = {
    status: 'converged' as const,
    regime: 'steady' as const,
    cd: { mean: 0.4, std: 0.01 },
    cl: { mean: -0.1, std: 0.02 },
    cm: { mean: 0.05, std: 0.005 },
    clcd: null,
    strouhal: null,
    change: 0.002,
    averagedSteps: 1600.4,
  }
  const result: Engine3DResult = {
    step: 4000,
    unstable: false,
    stats,
    rhoInf: 1.0002,
    history: [
      { step: 8, cd: 0.4, cl: -0.1, cm: 0.05 },
      { step: 16, cd: Number.NaN, cl: 0, cm: 0 },
    ],
    mean: { sums: new Float32Array(4), samples: 10, rhoInf: 1.0001 },
    voxels: new Uint8Array(1),
  }
  const ctx = { setup, plan, elapsedSeconds: 3, lines: [], box: [0, 0, 0, 1, 1, 1], options: {} as never, sequential: 'viridis' as const, diverging: 'coolwarm' as const }

  it('keeps the corrected numbers, the measured Cd and Cs from the side-force slot', () => {
    const up = pointUpload3d(result, ctx)
    expect(up.dimension).toBe('3d')
    expect(up.status).toBe('converged')
    expect(up.coefficients.cd).toEqual({ mean: 0.4, std: 0.01 })
    expect(up.coefficients.cd_measured!.mean).toBeCloseTo(0.5, 12)
    expect(up.coefficients.cs).toEqual({ mean: 0.05, std: 0.005 })
    expect(up.coefficients.blockage_correction).toBe(0.8)
    expect(up.coefficients.averaged_steps).toBe(1600)
    // No NaN reaches the server.
    expect(up.history.step).toEqual([8])
    expect(up.history.cs).toEqual([0.05])
    expect(up.mean).toEqual({ samples: 10, rho_inf: 1.0001 })
  })

  it('an unstable case has no numbers and no mean field', () => {
    const up = pointUpload3d({ ...result, unstable: true }, ctx)
    expect(up.status).toBe('unstable')
    expect(up.coefficients.cd).toBeNull()
    expect(up.coefficients.cd_measured).toBeNull()
    expect(up.mean).toBeNull()
  })
})
