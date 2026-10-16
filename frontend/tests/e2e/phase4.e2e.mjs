// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 4 end to end: a photographed sketch of a NACA 0012 goes through the
// four steps (sheet, cleaning, outline, scale) into a profile; the editor
// reopens the wizard with the same settings; an open stroke is welded; a HEIC
// photo gets its own message. No console errors.
//
//   node tests/e2e/phase4.e2e.mjs [screenshot-dir]
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assert, launchChrome, startApp } from './harness.mjs'

/** A synthetic sketch photo, made by the Python fixtures (tests/synthetic.py). */
function photo(path, code) {
  const script = `
import sys
sys.path.insert(0, 'tests')
from synthetic import *
${code}
open(sys.argv[1], 'wb').write(data)
`
  execFileSync('uv', ['run', '--project', ROOT, 'python', '-c', script, path], { cwd: ROOT })
}

/** Set a range input the way a user does, so React sees the change. */
async function setRange(locator, value) {
  await locator.evaluate((input, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

const shots = process.argv[2]
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
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

  // --- a closed sketch, the four steps ----------------------------------------------------
  const naca = join(app.home, 'ala.jpg')
  photo(naca, 'data, _ = sketch_photo([(on_sheet(naca4("0012", 200)), True)], 2)')
  await page.getByTestId('import-input').setInputFiles(naca)
  await page.waitForURL(/\/schizzi\/[0-9a-f]{16}$/)
  await page.getByTestId('sheet-status').getByText('Foglio trovato').waitFor()
  await page.getByText(/Formato A \(√2\)/).waitFor()
  const preview = page.getByTestId('sheet-preview')
  await preview.waitFor()
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="sheet-preview"]')
    return img && img.complete && img.naturalWidth > 0
  })
  // Drag a corner a little and back: the straightened sheet follows.
  const corner = page.getByTestId('corner-0').locator('circle').first()
  const box = await corner.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await shot(page, 'sketch-1')

  await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('sketch-ink').waitFor()
  await setRange(page.getByTestId('closing'), 0.02)
  await page.getByText('2%', { exact: true }).waitFor()
  await shot(page, 'sketch-2')

  await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('region-selected').waitFor()
  assert((await page.getByTestId('region-selected').count()) === 1, 'one region chosen')
  await page.getByTestId('regions-status').getByText('1 regione chiusa').waitFor()
  await setRange(page.getByTestId('smoothing'), 0.001)
  await shot(page, 'sketch-3')

  await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('wind-arrow').waitFor()
  await page.getByText('Indica la scala per vedere il profilo.').waitFor()
  const length = page.getByTestId('length')
  await length.fill('1,2')
  await length.press('Enter')
  await page.getByTestId('sketch-size').getByText(/Dimensioni risultanti: 1,2 m ×/).waitFor()
  await page.getByTestId('sketch-result').waitFor()
  assert(!(await page.getByRole('button', { name: 'Avanti' }).isEnabled()), 'no step after 4')
  await shot(page, 'sketch-4')
  await page.getByRole('button', { name: 'Crea profilo' }).click()
  await page.waitForURL(/\/profili\/[0-9a-f-]{36}$/)
  const profileUrl = page.url()
  await page.getByText('Dallo schizzo fotografato «ala.jpg».').waitFor()

  // --- reopen the wizard from the profile ------------------------------------------------
  await page.getByRole('button', { name: 'Riapri la procedura dello schizzo' }).click()
  await page.waitForURL(/\/schizzi\/[0-9a-f]{16}\?profilo=/)
  await page.getByText(/Impostazioni ripristinate dal profilo «ala»/).waitFor()
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('sketch-size').getByText(/1,2 m ×/).waitFor()
  await page.getByRole('button', { name: 'Aggiorna «ala»' }).waitFor()
  await page.getByRole('link', { name: '← Profilo' }).click()
  await page.waitForURL(profileUrl)

  // --- an open stroke: the gap is shown, then welded ---------------------------------------
  const open = join(app.home, 'aperto.jpg')
  photo(open, 'line, _ = open_ellipse(0.03)\ndata, _ = sketch_photo([(line, False)], 0)')
  await page.getByTestId('import-input').setInputFiles(open)
  await page.waitForURL(/\/schizzi\/[0-9a-f]{16}$/)
  await page.getByTestId('sheet-status').waitFor()
  await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('sketch-ink').waitFor()
  await page.getByRole('button', { name: 'Avanti' }).click()
  await page.getByTestId('gap').waitFor()
  await page.getByText(/Il contorno non è chiuso/).waitFor()
  assert(!(await page.getByRole('button', { name: 'Avanti' }).isEnabled()), 'no step 4 while open')
  await shot(page, 'sketch-gap')
  await page.getByRole('button', { name: 'Aumenta chiusura varchi' }).click()
  await page.getByTestId('region-selected').waitFor()
  assert(await page.getByRole('button', { name: 'Avanti' }).isEnabled(), 'step 4 once welded')

  // --- a HEIC photo ---------------------------------------------------------------------------
  const heic = join(app.home, 'iphone.heic')
  const bytes = Buffer.alloc(64)
  bytes.write('ftypheic', 4, 'latin1')
  writeFileSync(heic, bytes)
  await page.getByTestId('import-input').setInputFiles(heic)
  await page.getByText(/Le foto HEIC non sono supportate/).waitFor()
  await page.getByRole('button', { name: 'OK' }).click()

  // --- the library lists the profile as a sketch -----------------------------------------------
  await page.goto(app.url)
  await page.getByRole('tab', { name: /Profili 2D/ }).click()
  await page.getByText('Schizzo').first().waitFor()

  assert(errors.length === 0, `console errors: ${errors.join(' | ')}`)
  console.log('phase4 e2e: OK')
} catch (error) {
  console.error(app.log())
  throw error
} finally {
  await browser.close()
  await app.stop()
}
