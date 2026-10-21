// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §24.4: the 3D tunnel with every view on -- plane, Cp on the surface,
// smoke and particles -- at the three presets: steps per second and frames
// per second (mean and 5th percentile over 20 s, after 4 s), through the
// page's `?bench=1` mode. The simplified Ahmed body on the moving floor, in
// the system Chrome on the real GPU (WebGPU on Vulkan).
//
//   node tests/bench/gallery3d.bench.mjs [presets, default bozza,normale,fine] [extra Chrome flags...]
//   GDV_BENCH_SMOKE=griglia: the smoke from a full 16 x 16 grid of nozzles (SPEC §24.10)
import { ahmedBody } from '../synthetic.ts'
import { launchChrome, startApp } from '../e2e/harness.mjs'

function stlOf({ positions, indices }) {
  const count = indices.length / 3
  const buf = Buffer.alloc(84 + 50 * count)
  buf.writeUInt32LE(count, 80)
  for (let k = 0; k < count; k++) {
    const o = 84 + 50 * k
    for (let n = 0; n < 3; n++)
      for (let m = 0; m < 3; m++) buf.writeFloatLE(positions[3 * indices[3 * k + n] + m], o + 12 + 12 * n + 4 * m)
  }
  return buf
}

const [presets = 'bozza,normale,fine', ...flags] = process.argv.slice(2)
const app = await startApp()
const browser = await launchChrome({ extraArgs: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', ...flags] })
try {
  const origin = app.url.slice(0, -1)
  const imported = await fetch(`${app.url}api/models/import?nome=ahmed.stl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin },
    body: stlOf(ahmedBody()),
  }).then((r) => r.json())
  const id = imported.model.id
  await fetch(`${app.url}api/models/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ units: 'm', study_type: 'veicolo' }),
  })
  for (const preset of presets.split(',')) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const smoke = process.env.GDV_BENCH_SMOKE === 'griglia' ? '&fumo=griglia' : ''
    await page.goto(`${app.url}galleria3d/${id}?bench=1&risoluzione=${preset}${smoke}`)
    const text = await page.getByTestId('bench-result').innerText({ timeout: 180_000 })
    const r = JSON.parse(text)
    console.log(
      `${preset}: ${r.nx}×${r.ny}×${r.nz} = ${(r.cells / 1e6).toFixed(2)} M celle, ` +
        `${r.stepsMean.toFixed(0)} passi/s (P5 ${r.stepsP5.toFixed(0)}), ${r.fpsMean.toFixed(1)} fps (P5 ${r.fpsP5}), ` +
        `${r.stepsPerFrame} passi per fotogramma (${r.adapter})`,
    )
    await page.close()
  }
} finally {
  await browser.close()
  await app.stop()
}
