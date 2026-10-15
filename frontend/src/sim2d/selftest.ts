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
  const state = solver.readState()
  const ms = performance.now() - start
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  solver.dispose()
  return { ux: Array.from(state.ux), uy: Array.from(state.uy), drho: Array.from(state.drho), ms, renderer }
}

;(window as unknown as { gdvSelfTest: typeof selfTest }).gdvSelfTest = selfTest
