// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §24.4: voxelising a 1M-triangle model at the Normale grid (≤ 2 s), with
// the rotation, the box and the frontal area the planner needs; closed (rays
// along z) and open (majority of x, y, z), and the interpolated walls of
// SPEC §24.8. Runs in Node, the same V8 as
// Chrome's worker; median of 3 runs.
//
//   node tests/bench/voxelize.bench.mjs
import { boxOf, frontalArea, turnBody, voxelize, wallLinks } from '../../src/sim3d/voxelize.ts'
import { uvSphere } from '../synthetic.ts'

const mesh = uvSphere(1, 500, 1000)
const triangles = mesh.indices.length / 3
// The Normale plan of a sphere of diameter 2 (planner3d: 168 × 94 × 94, D = 30 cells).
const dx = 2 / 30
const grid = { nx: 168, ny: 94, nz: 94, dx, offset: [1.5 * 2 + 1, 47 * dx, 47 * dx] }
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]
const time = (fn) => {
  const out = []
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    out.push(performance.now() - t)
  }
  return median(out)
}
const prepare = time(() => {
  const body = turnBody(mesh.positions, [0, 0, 0], 15, 5)
  boxOf(body)
  frontalArea(body, mesh.indices)
})
const body = turnBody(mesh.positions, [0, 0, 0], 15, 5)
const closed = time(() => voxelize(body, mesh.indices, grid, true))
const open = time(() => voxelize(body, mesh.indices, grid, false))
const voxels = voxelize(body, mesh.indices, grid, true)
const walls = time(() => wallLinks(body, mesh.indices, grid, voxels))
const records = wallLinks(body, mesh.indices, grid, voxels).count
console.log(
  `${(triangles / 1e6).toFixed(2)} M triangoli, griglia ${grid.nx}×${grid.ny}×${grid.nz}: ` +
    `rotazione + ingombro + area frontale ${prepare.toFixed(0)} ms, ` +
    `voxel (chiusa) ${closed.toFixed(0)} ms, voxel (aperta, maggioranza) ${open.toFixed(0)} ms, ` +
    `pareti ${walls.toFixed(0)} ms (${records} celle di confine)`,
)
