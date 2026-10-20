// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §24.3, the 3D solver alone: steps per second (and million cell updates
// per second) at the three presets, on a sphere planned by the 3D planner,
// measuring every 8 steps as the tunnel will. Runs in the system Chrome on the
// real GPU (WebGPU on Vulkan) through the `?selftest3d` hook.
//
//   node tests/bench/tunnel3d.bench.mjs [seconds] [extra Chrome flags...]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const seconds = Number(process.argv[2] ?? 10)
const flags = process.argv.slice(3)
const D = 0.1
const setup = (resolution) => ({
  model_id: 'bench',
  name: 'sfera',
  pivot: [0, 0, 0.5],
  model_size: [D, D, D],
  body_box: [-D / 2, -D / 2, -D / 2, D / 2, D / 2, D / 2],
  frontal_area_m2: (Math.PI * D * D) / 4,
  speed: 10,
  resolution,
})

function voxels(plan) {
  const runs = []
  const r = D / 2 / plan.dx
  const [ox, oy, oz] = plan.offset.map((v) => v / plan.dx)
  for (let z = 0; z < plan.nz; z++)
    for (let y = 0; y < plan.ny; y++)
      for (let x = 0; x < plan.nx; x++) {
        const d = (x + 0.5 - ox) ** 2 + (y + 0.5 - oy) ** 2 + (z + 0.5 - oz) ** 2
        if (d < r * r) {
          const i = x + plan.nx * (y + plan.ny * z)
          if (runs.length && runs[runs.length - 2] + runs[runs.length - 1] === i) runs[runs.length - 1]++
          else runs.push(i, 1)
        }
      }
  return runs
}

const plans = JSON.parse(
  execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `import json,sys
from gdv.physics.planner3d import CaseSetup3D, plan3d
print(json.dumps([plan3d(CaseSetup3D(**s)).model_dump() for s in json.loads(sys.argv[1])]))`,
      JSON.stringify(['bozza', 'normale', 'fine'].map(setup)),
    ],
    { encoding: 'utf8' },
  ),
)
const cases = plans.map((p) => ({
  params: {
    nx: p.nx,
    ny: p.ny,
    nz: p.nz,
    tau: p.tau,
    uLat: p.u_lat,
    rampSteps: p.ramp_steps,
    ground: p.ground,
    boundaryLayer: false,
    inletExponent: p.inlet_exponent,
    inletReferenceCells: p.inlet_reference_cells,
    spongeStart: p.sponge_start,
    spongeFactor: p.sponge_factor,
    spongeDamping: p.sponge_damping,
    cs: p.smagorinsky_cs,
  },
  mask: voxels(p),
  seconds,
  batch: 32,
}))
const dir = tmpdir()
const input = join(dir, 'gdv-bench3d-in.json')
const output = join(dir, 'gdv-bench3d-out.json')
writeFileSync(input, JSON.stringify({ mode: 'bench', cases }))
execFileSync('node', ['tests/e2e/selftest3d.mjs', input, output, '--gpu', ...flags], { stdio: 'inherit' })
const results = JSON.parse((await import('node:fs')).readFileSync(output, 'utf8'))
for (const [i, name] of ['bozza', 'normale', 'fine'].entries()) {
  const p = plans[i]
  const r = results[i]
  console.log(
    `${name}: ${p.nx}×${p.ny}×${p.nz} = ${(r.cells / 1e6).toFixed(2)} M celle, ` +
      `${r.stepsPerSecond.toFixed(0)} passi/s, ${r.mlups.toFixed(0)} MLUPS, ` +
      `${(p.tc_steps / r.stepsPerSecond).toFixed(1)} s per T_c, ${p.memory_mb.toFixed(0)} MB (${r.adapter})`,
  )
}
