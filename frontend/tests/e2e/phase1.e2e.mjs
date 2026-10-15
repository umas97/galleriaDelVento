// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 1 end to end: import a model through the file input, confirm the
// units, turn it, apply a repair, go back to the library. No console errors.
//
//   node tests/e2e/phase1.e2e.mjs [screenshot-dir]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, launchChrome, startApp } from './harness.mjs'

/** A binary STL of a UV sphere (radius 0.3 "file units"), built here: no fixture files. */
function sphereStl(rings = 40, segments = 80, radius = 300) {
  const pts = []
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI * i) / rings
    for (let j = 0; j < segments; j++) {
      const ph = (2 * Math.PI * j) / segments
      pts.push([radius * Math.sin(th) * Math.cos(ph), radius * Math.sin(th) * Math.sin(ph), radius * Math.cos(th)])
    }
  }
  const tris = []
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j
      const b = i * segments + ((j + 1) % segments)
      const c = a + segments
      const d = b + segments
      if (i > 0) tris.push([a, c, b])
      if (i < rings - 1) tris.push([b, c, d])
    }
  const buf = Buffer.alloc(84 + 50 * tris.length)
  buf.write('e2e sphere', 0)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, k) => {
    const o = 84 + 50 * k
    t.forEach((v, n) => pts[v].forEach((x, m) => buf.writeFloatLE(x, o + 12 + 12 * n + 4 * m)))
  })
  return buf
}

const shots = process.argv[2]
const app = await startApp()
const browser = await launchChrome()
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto(app.url)
  await page.getByText('Nessun modello 3D').waitFor()

  const file = join(app.home, 'sfera.stl')
  writeFileSync(file, sphereStl())
  await page.getByTestId('import-input').setInputFiles(file)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/)

  // Units dialog opens by itself, with millimetres proposed (extent 600).
  const dialog = page.getByRole('dialog', { name: 'Unità del file' })
  await dialog.waitFor()
  assert(await dialog.getByText('proposta').isVisible(), 'a proposal is shown')
  await dialog.getByLabel('millimetri').check()
  await dialog.getByText('x 0,6 m · y 0,6 m · z 0,6 m').waitFor()
  await dialog.getByRole('button', { name: 'Conferma' }).click()
  await dialog.waitFor({ state: 'detached' })

  await page.getByText('Referto della mesh').waitFor()
  await page.getByTestId('model-scene').locator('canvas').waitFor()
  await page.getByRole('button', { name: 'Z −90°' }).click()
  await page.getByLabel('Appoggia al pavimento').click()
  await page.getByText('Luce a terra').waitFor()
  await page.waitForTimeout(800)
  if (shots) await page.screenshot({ path: join(shots, 'setup.png') })

  await page.getByRole('link', { name: '← Libreria' }).click()
  await page.getByText('sfera', { exact: true }).waitFor()
  await page.waitForTimeout(300)
  if (shots) await page.screenshot({ path: join(shots, 'library.png') })

  // Re-importing the same bytes offers the existing model.
  await page.getByTestId('import-input').setInputFiles(file)
  await page.getByRole('dialog', { name: 'Modello già presente' }).waitFor()

  assert(errors.length === 0, `console errors: ${errors.join(' | ')}`)
  console.log('phase1 e2e: OK')
} catch (error) {
  console.error(app.log())
  throw error
} finally {
  await browser.close()
  await app.stop()
}
