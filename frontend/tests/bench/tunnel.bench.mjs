// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §17, the tunnel: steps per second and frames per second over 20 s (mean
// and 5th percentile) at the Normale and Fine resolutions on a NACA 0012, and
// while the depth of a 1M-triangle model scrolls back and forth every frame
// (`?bench=depth`), with the longest mask update. The pages measure themselves
// (`?bench=1`); this script only drives them, in the system Chrome on the real
// GPU (ANGLE on Vulkan; other flags may be given).
//
//   node tests/bench/tunnel.bench.mjs [extra Chrome flags...]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { naca4, uvSphere } from '../synthetic.ts'
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

const flags = process.argv.slice(2)
const app = await startApp()
const browser = await launchChrome({ extraArgs: flags.length ? flags : ['--use-angle=vulkan', '--enable-features=Vulkan'] })
const results = {}
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const origin = app.url.slice(0, -1)
  const profile = await fetch(`${app.url}api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'NACA 0012', loops: [{ points: naca4('0012', 160, 1) }], source: { kind: 'editor', derived_from: null, origin: null }, spline: null }),
  }).then((r) => r.json())
  const run = async (path, resolution) => {
    await page.goto(app.url)
    await page.evaluate((res) => localStorage.setItem('tunnel-case', JSON.stringify({ resolution: res })), resolution)
    await page.goto(`${app.url}${path}`)
    const out = page.getByTestId('bench-result')
    await out.waitFor({ timeout: 120000 })
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''
    })
    return { ...JSON.parse(await out.textContent()), renderer }
  }
  results.normale = await run(`galleria/profilo/${profile.id}?bench=1`, 'normale')
  results.fine = await run(`galleria/profilo/${profile.id}?bench=1`, 'fine')

  const file = join(app.home, 'sfera-1M.stl')
  writeFileSync(file, stlOf(uvSphere(1, 500, 1000)))
  await page.goto(app.url)
  await page.getByTestId('import-input').setInputFiles(file)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/, { timeout: 120000 })
  const units = page.getByRole('dialog', { name: 'Unità del file' })
  await units.getByRole('button', { name: 'Conferma' }).click()
  await units.waitFor({ state: 'detached' })
  const id = page.url().split('/').pop()
  results.depth = await run(`galleria/modello/${id}?bench=depth`, 'normale')
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  await app.stop()
}
