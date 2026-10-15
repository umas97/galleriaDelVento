// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 2 end to end: import a tapered wing, cut it live (depth and rotation),
// save the section as a profile, edit it («Rendi modificabile», symmetric
// mode, undo), find it in the library, import an SVG drawing. No console errors.
//
//   node tests/e2e/phase2.e2e.mjs [screenshot-dir]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taperedWing } from '../synthetic.ts'
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

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">
<path d="M 10 20 C 10 5 60 5 110 20 C 60 30 10 30 10 20 Z"/></svg>`

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

  // --- import the wing (2 m span, in metres) ---------------------------------------
  const wingFile = join(app.home, 'ala.stl')
  writeFileSync(wingFile, stlOf(taperedWing(2, 1, 0.4, 12, 60)))
  await page.getByTestId('import-input').setInputFiles(wingFile)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/)
  const units = page.getByRole('dialog', { name: 'Unità del file' })
  assert(await units.getByRole('radio', { name: /^metri/ }).isChecked(), 'metres proposed for a 2 m wing')
  await units.getByRole('button', { name: 'Conferma' }).click()
  await units.waitFor({ state: 'detached' })
  await page.getByLabel('Tipo di studio').selectOption('ala')
  await page.getByText('Aggiornamento del modello…').waitFor({ state: 'detached' })

  // --- sections ------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Sezioni' }).click()
  await page.waitForURL(/\/sezioni$/)
  const stats = page.getByTestId('section-stats')
  await stats.getByText(/^1 anello /).waitFor({ timeout: 20000 })
  await page.getByTestId('section-scene').locator('canvas').waitFor()
  // Ala / drone: vertical plane at 40% of the span; the model is centred in y.
  const at40 = await page.getByTestId('section-depth').textContent()
  assert(at40.startsWith('-0,2'), `depth at 40% of a 2 m span centred on 0, got ${at40}`)
  await shot(page, 'section')
  const depthBefore = await page.getByTestId('section-depth').textContent()
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(60)
  }
  await page.waitForFunction(
    (before) => document.querySelector('[data-testid="section-depth"]')?.textContent !== before,
    depthBefore,
  )
  await stats.getByText(/^1 anello /).waitFor()
  // At 100% the plane lies on the tip face: its outline is the section (an empty
  // cut, beyond the model, is covered by test 8 in vitest).
  await page.getByTestId('depth-slider').fill('1000')
  await page.getByTestId('section-depth').getByText('1 m').waitFor()
  await stats.getByText(/^1 anello /).waitFor()
  await page.getByTestId('depth-slider').fill('500')
  await stats.getByText(/^1 anello /).waitFor()
  // A rotation about z (yaw) changes the section: index rebuilt, cut again.
  const yaw = page.getByLabel('Imbardata (attorno a z)')
  await yaw.focus()
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowRight')
  await page.keyboard.up('ArrowRight')
  await yaw.blur()
  await stats.getByText(/^1 anello /).waitFor()
  await page.getByRole('button', { name: 'Azzera' }).click()
  await shot(page, 'section-rotated')

  await page.getByRole('button', { name: 'Salva sezione come profilo' }).click()
  const naming = page.getByRole('dialog', { name: 'Salva sezione come profilo' })
  await naming.getByLabel('Nome').fill('Ala a metà')
  await naming.getByRole('button', { name: 'Conferma' }).click()
  await page.getByText('Sezione salvata come «Ala a metà».').waitFor()

  // --- the editor --------------------------------------------------------------------
  await page.getByRole('button', { name: 'Apri nell’editor' }).click()
  await page.waitForURL(/\/profili\/[0-9a-f-]{36}$/)
  await page.getByText(/contorno importato/).waitFor()
  const chord = await page.getByTestId('metrics').locator('dd').first().textContent()
  const chordM = Number(chord.replace(' m', '').replace(',', '.'))
  assert(Math.abs(chordM / 0.7 - 1) < 0.01, `chord of the mid-span section is 0.7 m, got ${chord}`)
  await page.getByRole('button', { name: 'Rendi modificabile' }).click()
  await page.getByTestId('fit-info').waitFor()
  await page.getByText('24 punti di controllo').waitFor()
  await page.getByLabel('Simmetrico rispetto alla corda').check()
  await page.keyboard.press('Control+z')
  await page.getByLabel('Simmetrico rispetto alla corda').isChecked().then((on) => assert(!on, 'undo turns symmetric off'))
  await page.keyboard.press('Control+Shift+z')
  await page.getByText('modifiche non salvate').waitFor()
  await shot(page, 'editor')
  await page.getByRole('button', { name: 'Salva', exact: true }).click()
  await page.getByText('Salvato', { exact: true }).waitFor()

  // --- the library -----------------------------------------------------------------------
  await page.getByRole('button', { name: '← Libreria' }).click()
  await page.getByRole('tab', { name: /Profili 2D/ }).click()
  await page.getByText('Ala a metà').waitFor()
  await page.waitForTimeout(300)
  await shot(page, 'library-profiles')

  // --- an SVG drawing ----------------------------------------------------------------------
  const svgFile = join(app.home, 'goccia.svg')
  writeFileSync(svgFile, SVG)
  await page.getByTestId('import-input').setInputFiles(svgFile)
  const drawing = page.getByRole('dialog', { name: 'Importa disegno' })
  await drawing.getByText('1 contorno chiuso').waitFor()
  await drawing.getByText('Unità del file (mm)').waitFor()
  await drawing.getByText(/Dimensioni risultanti: 0,1 m ×/).waitFor()
  await shot(page, 'drawing')
  await drawing.getByRole('button', { name: 'Crea profilo' }).click()
  await page.waitForURL(/\/profili\/[0-9a-f-]{36}$/)
  await page.getByText(/contorno importato/).waitFor()

  // --- a new profile from scratch -------------------------------------------------------------
  await page.goto(app.url + 'profili/nuovo')
  await page.getByTestId('editor-canvas').waitFor()
  await page.getByText('8 punti di controllo').waitFor()

  assert(errors.length === 0, `console errors: ${errors.join(' | ')}`)
  console.log('phase2 e2e: OK')
} catch (error) {
  console.error(app.log())
  throw error
} finally {
  await browser.close()
  await app.stop()
}
