// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 25's hook (SPEC §18): with `?selftest` in the address the page exposes
// `window.gdvSelfTest`, which runs a lattice case in the shader and returns
// the fields, for pytest to compare with the reference solver. Nothing in the
// interface leads here; it only exists for the test.
import { createContext } from './gl'
import { Solver, type LatticeParams } from './solver'

export type SelfTestCase = {
  params: LatticeParams
  /** Solid cells as run-length pairs (start, length) over [j * nx + i]. */
  mask: number[]
  steps: number
  /** Optionally a second mask, set after `at` steps. */
  change?: { at: number; mask: number[] }
  /** Moment reference of the forces returned, cells. */
  forcesAbout?: [number, number]
}

function unpack(runs: number[], size: number): Uint8Array {
  const mask = new Uint8Array(size)
  for (let k = 0; k < runs.length; k += 2) mask.fill(1, runs[k], runs[k] + runs[k + 1])
  return mask
}

async function selfTest(c: SelfTestCase) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const gl = createContext(canvas)
  const size = c.params.nx * c.params.ny
  const solver = new Solver(gl, c.params, unpack(c.mask, size))
  const start = performance.now()
  if (c.change) {
    solver.run(c.change.at)
    solver.setMask(unpack(c.change.mask, size))
    solver.run(c.steps - c.change.at)
  } else {
    solver.run(c.steps)
  }
  // The forces at the last step, through the measurement the tunnel uses.
  solver.measure(c.forcesAbout ?? [0, 0])
  gl.flush() // the fence is sent with the next flush (in the tunnel, the frame's)
  let sample: ReturnType<Solver['collect']>[number] | null = null
  const deadline = performance.now() + 60_000 // SwiftShader takes seconds for 500 steps
  while (!sample && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
    sample = solver.collect()[0] ?? null
  }
  const state = solver.readState()
  const ms = performance.now() - start
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  solver.dispose()
  const forces = sample && { fx: sample.fx, fy: sample.fy, mz: sample.mz, rhoInf: sample.rhoInf, step: sample.step }
  return { ux: Array.from(state.ux), uy: Array.from(state.uy), drho: Array.from(state.drho), forces, ms, renderer }
}

;(window as unknown as { gdvSelfTest: typeof selfTest }).gdvSelfTest = selfTest
