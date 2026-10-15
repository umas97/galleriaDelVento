// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 3 end to end: a NACA 0012 in the tunnel (views 1-6, a probe, the
// snapshot, pause and restart), then a tapered wing opened in the tunnel from
// its setup screen: the live section in the flow, the depth scrolled with the
// flow running, the section saved as a profile. No console errors.
//
//   node tests/e2e/phase3.e2e.mjs [screenshot-dir] [extra Chrome flags...]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { naca4, taperedWing } from '../synthetic.ts'
import { assert, launchChrome, startApp } from './harness.mjs'

function stlOf({ positions, indices }) {
  const count = indices.length / 3
  const buf = Buffer.alloc(84 + 50 * count)
  buf.write('e2e wing', 0)
  buf.writeUInt32LE(count, 80)
  for (let k = 0; k < count; k++) {
    const o = 84 + 50 * k
    for (let n = 0; n < 3; n++)
      for (let m = 0; m < 3; m++) buf.writeFloatLE(positions[3 * indices[3 * k + n] + m], o + 12 + 12 * n + 4 * m)
  }
  return buf
}

const [shots, ...flags] = process.argv.slice(2)
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
/** The first number of an Italian text ("0,043 ± 0,001" → 0.043). */
const number = (text) => Number((text.match(/-?\d+(?:,\d+)?/) ?? ['NaN'])[0].replace(',', '.'))

const app = await startApp()
const browser = await launchChrome({ extraArgs: flags })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, acceptDownloads: true })
  page.on('console', (msg) => {
    // Errors, and the tunnel's own read-back warning. Driver performance notes
    // (e.g. a 2D canvas read back for a thumbnail on SwiftShader) are not errors.
    if (msg.type() === 'error' || (msg.type() === 'warning' && /READ-usage buffer/.test(msg.text()))) errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  const origin = app.url.slice(0, -1)
  const created = await fetch(`${app.url}api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      name: 'NACA 0012',
      loops: [{ points: naca4('0012', 160, 1) }],
      source: { kind: 'editor', derived_from: null, origin: null },
      spline: null,
    }),
  }).then((r) => r.json())

  // --- a saved profile in the tunnel ---------------------------------------------------
  await page.goto(`${app.url}profili/${created.id}`)
  await page.getByRole('button', { name: 'Apri in galleria' }).click()
  await page.waitForURL(/\/galleria\/profilo\//)
  await page.getByTestId('resolution').selectOption('bozza')
  const top = page.getByTestId('tunnel-top')
  await top.getByText(/Re reale .* Re simulato/).waitFor({ timeout: 20000 })
  await top.getByTestId('badge-partial').waitFor()
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 30000 })
  // The coefficients appear after the start-up: a positive drag, about no lift at 0°.
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="coef-cd"]')?.textContent ?? ''), null, { timeout: 120000 })
  const cd = number(await page.getByTestId('coef-cd').locator('span.font-mono').textContent())
  assert(cd > 0.005 && cd < 0.5, `Cd of a NACA 0012 at 0°: ${cd}`)
  assert((await page.getByTestId('result-conditions').textContent()).includes('L_ref'), 'conditions next to the numbers')
  await shot(page, 'tunnel-speed')
  for (const key of ['2', '3', '4', '5', '6']) {
    await page.keyboard.press(key)
    await page.waitForTimeout(400)
  }
  await shot(page, 'tunnel-views')
  // A probe in the wake.
  await page.getByRole('button', { name: 'Sonde', exact: true }).click()
  const box = await page.getByTestId('tunnel-overlay').boundingBox()
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await page.getByTestId('probes').getByText('Sonda 1').waitFor()
  // Incidence by the keyboard: the plan is asked again, the chamber stays.
  const grid = await top.textContent()
  for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(800)
  assert((await page.getByTestId('incidence').inputValue()) === '2', 'incidence 2° after four arrows')
  assert((await top.textContent()).includes(grid.match(/\d+ × \d+ celle/)[0]), 'same grid after a small incidence')
  // The snapshot is a PNG download.
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')])
  assert(/\.png$/.test(download.suggestedFilename()), `snapshot name ${download.suggestedFilename()}`)
  // Pause stops the steps; R starts again from zero.
  await page.keyboard.press(' ')
  await page.waitForTimeout(600)
  await page.getByText(/^0 passi\/s$/).waitFor()
  await page.keyboard.press('r')
  await page.keyboard.press(' ')

  // --- a tapered wing: the live section in the flow ---------------------------------------
  await page.goto(app.url)
  const wingFile = join(app.home, 'ala.stl')
  writeFileSync(wingFile, stlOf(taperedWing(2, 1, 0.4, 12, 60)))
  await page.getByTestId('import-input').setInputFiles(wingFile)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/)
  const units = page.getByRole('dialog', { name: 'Unità del file' })
  await units.getByRole('button', { name: 'Conferma' }).click()
  await units.waitFor({ state: 'detached' })
  await page.getByLabel('Tipo di studio').selectOption('ala')
  await page.getByText('Aggiornamento del modello…').waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Apri in galleria' }).click()
  await page.waitForURL(/\/galleria\/modello\//)
  await page.getByTestId('resolution').selectOption('bozza')
  await page.getByTestId('model-panel').waitFor()
  await top.getByTestId('badge-2d').waitFor()
  await top.getByText(/celle da/).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 30000 })
  const gridBefore = (await top.textContent()).match(/\d+ × \d+ celle/)[0]
  const depthBefore = await page.getByTestId('section-depth').textContent()
  const stepsBefore = await page.getByTestId('top-steps').textContent()
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(250)
  }
  const depthAfter = await page.getByTestId('section-depth').textContent()
  assert(depthAfter !== depthBefore, 'the depth moved')
  await page.waitForTimeout(1000)
  assert(/[1-9]\d* passi\/s/.test(await page.getByTestId('top-steps').textContent()), `the flow keeps running (${stepsBefore})`)
  assert((await top.textContent()).includes(gridBefore), 'scrolling the depth does not replan')
  await shot(page, 'tunnel-wing')
  await page.getByRole('button', { name: 'Salva sezione come profilo' }).click()
  const naming = page.getByRole('dialog', { name: 'Salva sezione come profilo' })
  await naming.getByRole('button', { name: 'Conferma' }).click()
  await page.getByText(/Sezione salvata come/).waitFor({ timeout: 20000 })

  assert(errors.length === 0, `console errors:\n${errors.join('\n')}`)
  console.log('OK')
} finally {
  await browser.close()
  await app.stop()
}
