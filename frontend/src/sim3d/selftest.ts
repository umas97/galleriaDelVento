// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 39's hook (SPEC §24.4): with `?selftest3d` in the address the page
// exposes `window.gdvSelfTest3D`, which runs a lattice case in the WGSL solver
// and returns the velocity field, for pytest to compare with the 3D reference
// solver; and `window.gdvBench3D`, which measures steps per second on a grid
// (to fix the presets, SPEC §17). Nothing in the interface leads here.
import { C, Q } from './lattice3d.generated'
import { requestGpu, type Gpu } from './gpu'
import { Solver3D, packMask, type LatticeParams3D, type Sample3D } from './solver'

export type SelfTest3DCase = {
  params: LatticeParams3D
  /** Solid cells as run-length pairs (start, length) over [x + nx (y + ny z)]. */
  mask: number[]
  steps: number
  /** Also measure every `measureEvery` steps (forces, density range). */
  measureEvery?: number
  /** Return the fields (default); false for the measurements alone (large grids). */
  fields?: boolean
  /** Stop at the first unstable measurement (NaN, density outside [0.7, 1.3]). */
  stopWhenUnstable?: boolean
}

function unpack(runs: number[], size: number): Uint8Array {
  const mask = new Uint8Array(size)
  for (let k = 0; k < runs.length; k += 2) mask.fill(1, runs[k], runs[k] + runs[k + 1])
  return mask
}

let gpu: Promise<Gpu> | null = null

/** (δρ, ux, uy, uz) per cell from the populations, in double precision. */
function macro(f: Float32Array, voxels: Uint8Array, n: number) {
  const drho = new Float64Array(n)
  const u = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  for (let i = 0; i < n; i++) {
    if (voxels[i]) continue
    let d = 0
    const j = [0, 0, 0]
    for (let k = 0; k < Q; k++) {
      const v = f[k * n + i]
      d += v
      for (let a = 0; a < 3; a++) j[a] += v * C[3 * k + a]
    }
    drho[i] = d
    for (let a = 0; a < 3; a++) u[a][i] = j[a] / (1 + d)
  }
  return { drho, ux: u[0], uy: u[1], uz: u[2] }
}

async function selfTest3D(c: SelfTest3DCase) {
  gpu ??= requestGpu()
  const g = await gpu
  const p = c.params
  const n = p.nx * p.ny * p.nz
  const voxels = unpack(c.mask, n)
  const solver = await Solver3D.create(g, p, packMask(voxels))
  const start = performance.now()
  const samples: Sample3D[] = []
  const every = c.measureEvery ?? 0
  const unstable = (s: Sample3D) => s.nan > 0 || !(s.rhoMin >= 0.7 && s.rhoMax <= 1.3)
  if (every > 0) {
    for (let done = 0; done < c.steps; done += every) {
      solver.run(Math.min(every, c.steps - done))
      solver.measure()
      await solver.idle()
      await new Promise((r) => setTimeout(r, 0))
      samples.push(...solver.collect())
      if (c.stopWhenUnstable && samples.some(unstable)) break
    }
  } else {
    solver.run(c.steps)
  }
  if (c.fields === false) {
    await solver.idle()
    await new Promise((r) => setTimeout(r, 20))
    samples.push(...solver.collect())
    const ms = performance.now() - start
    solver.dispose()
    return { samples, ms, adapter: g.adapter, steps: solver.step }
  }
  const f = await solver.readPopulations()
  const ms = performance.now() - start
  samples.push(...solver.collect())
  solver.dispose()
  const m = macro(f, voxels, n)
  return {
    drho: Array.from(m.drho),
    ux: Array.from(m.ux),
    uy: Array.from(m.uy),
    uz: Array.from(m.uz),
    samples,
    ms,
    adapter: g.adapter,
  }
}

export type Bench3DCase = {
  params: LatticeParams3D
  mask: number[]
  /** Seconds to measure, after one of warm-up. */
  seconds: number
  /** Steps per submit. */
  batch: number
}

/** Steps per second over `seconds`, measuring every 8 steps as the tunnel will. */
async function bench3D(c: Bench3DCase) {
  gpu ??= requestGpu()
  const g = await gpu
  const p = c.params
  const n = p.nx * p.ny * p.nz
  const solver = await Solver3D.create(g, p, packMask(unpack(c.mask, n)))
  const runFor = async (seconds: number) => {
    const t0 = performance.now()
    const s0 = solver.step
    while (performance.now() - t0 < seconds * 1000) {
      for (let i = 0; i < c.batch; i += 8) {
        solver.run(8)
        solver.measure()
      }
      await solver.idle()
      solver.collect()
    }
    return ((solver.step - s0) * 1000) / (performance.now() - t0)
  }
  await runFor(1)
  const stepsPerSecond = await runFor(c.seconds)
  await solver.idle()
  const last = solver.collect()
  solver.measure()
  await solver.idle()
  await new Promise((r) => setTimeout(r, 50))
  const sample = solver.collect().concat(last).pop() ?? null
  solver.dispose()
  return { stepsPerSecond, mlups: (stepsPerSecond * n) / 1e6, cells: n, adapter: g.adapter, sample }
}

const w = window as unknown as { gdvSelfTest3D: typeof selfTest3D; gdvBench3D: typeof bench3D }
w.gdvSelfTest3D = selfTest3D
w.gdvBench3D = bench3D
