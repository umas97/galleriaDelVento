// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 5 end to end: a NACA 0012 in the tunnel, saved as a study and
// reopened (pictures, mean fields, a CSV, the PDF made by headless Chrome,
// the report page); an incidence series of three points; two studies
// compared. Then test 33 -- a tapered wing opened in the tunnel, its depth
// scrolled with the flow running, saved as a study and reopened from the
// list -- and test 28, a depth series of five sections of the same wing:
// chords growing towards the root, one fixed reference length, each point
// saved with its depth. No console errors.
//
// Series need the averages, and the averages need thousands of steps: this
// script runs Chrome on the real GPU (ANGLE on Vulkan, as the benchmarks; on
// SwiftShader the tunnel makes ~50 steps/s). A test hook shortens each series
// point to the transient + 2 T_c instead of ramp + 20 T_c.
//
//   node tests/e2e/phase5.e2e.mjs [screenshot-dir] [Chrome flags...]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { naca4, taperedWing } from '../synthetic.ts'
import { assert, launchChrome, startApp } from './harness.mjs'

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

const [shots, ...flags] = process.argv.slice(2)
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const SHORT_POINTS = '(p) => p.transient_steps + 2 * Math.ceil(p.tc_steps)'

const app = await startApp()
const browser = await launchChrome({ extraArgs: flags.length ? flags : ['--use-angle=vulkan', '--enable-features=Vulkan'] })
const errors = []
const api = (path, init = {}) =>
  fetch(`${app.url}api/${path}`, { ...init, headers: { 'Content-Type': 'application/json', Origin: app.url.slice(0, -1), ...(init.headers ?? {}) } }).then((r) => r.json())

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, acceptDownloads: true })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || (msg.type() === 'warning' && /READ-usage buffer/.test(msg.text()))) errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('dialog', (d) => d.accept())
  const profile = await api('profiles', {
    method: 'POST',
    body: JSON.stringify({ name: 'NACA 0012', loops: [{ points: naca4('0012', 160, 1) }], source: { kind: 'editor', derived_from: null, origin: null }, spline: null }),
  })
  await page.goto(app.url)
  await page.evaluate(() => localStorage.setItem('tunnel-case', JSON.stringify({ resolution: 'bozza', speed: 15 })))

  // --- a single study ----------------------------------------------------------------------
  await page.goto(`${app.url}galleria/profilo/${profile.id}`)
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="coef-cd"]')?.textContent ?? ''), null, { timeout: 120000 })
  await page.getByTestId('study-panel').getByRole('button', { name: 'Salva studio' }).click()
  const naming = page.getByRole('dialog', { name: 'Salva studio' })
  await naming.getByLabel('Nome dello studio').fill('NACA a zero')
  await naming.getByRole('button', { name: 'Conferma' }).click()
  await page.getByTestId('study-saved').waitFor({ timeout: 60000 })
  await shot(page, 'tunnel-saved')
  await page.getByTestId('study-saved').getByRole('link', { name: 'Apri lo studio' }).click()
  await page.getByTestId('study-page').waitFor()
  const studyUrl = page.url()
  const views = page.getByTestId('study-views').locator('img')
  await views.first().waitFor()
  assert((await views.count()) >= 3, 'speed, Cp and vorticity pictures')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="study-views"] img')].every((i) => i.complete && i.naturalWidth > 100))
  await page.getByTestId('study-fields').locator('canvas').waitFor()
  assert((await page.getByTestId('study-conditions').textContent()).includes('Re'), 'conditions shown')
  await shot(page, 'study')
  // A CSV with the conditions on top.
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Storia (CSV)' }).click()])
  const csvText = readFileSync(await csv.path(), 'utf8')
  assert(csvText.includes('# ') && csvText.includes('passo;tempo_s;Cd;Cl;Cm'), 'CSV with conditions')
  // The PDF, from the program's own report page printed by headless Chrome.
  const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByTestId('study-pdf').click()])
  const pdfBytes = readFileSync(await pdf.path())
  assert(pdfBytes.subarray(0, 4).toString() === '%PDF', 'a PDF')
  const pages = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  assert(pages >= 3, `report pages: ${pages}`)
  if (shots) writeFileSync(join(shots, 'report.pdf'), pdfBytes)
  await page.getByRole('link', { name: 'Apri il report' }).click()
  await page.getByTestId('report-profile').waitFor()
  await shot(page, 'report')

  // --- an incidence series --------------------------------------------------------------------
  await page.goto(`${app.url}galleria/profilo/${profile.id}`)
  await page.getByTestId('top-steps').waitFor()
  await page.evaluate(`window.__gdvSeriesCap = ${SHORT_POINTS}`)
  for (const [id, value] of [
    ['series-from', '0'],
    ['series-to', '4'],
    ['series-step', '2'],
  ]) {
    await page.getByTestId(id).fill(value)
    await page.getByTestId(id).press('Enter')
  }
  await page.getByTestId('series-start').click()
  await page.getByTestId('series-progress').waitFor()
  assert(await page.getByTestId('resolution').isDisabled(), 'the controls are locked during a series')
  await shot(page, 'series-running')
  await page.getByTestId('series-saved').waitFor({ timeout: 300000 })
  const studies = await api('studies')
  const polar = studies.find((s) => s.kind === 'series')
  assert(polar && polar.points === 3 && polar.state === 'done', `series saved: ${JSON.stringify(polar)}`)
  const polarStudy = (await api(`studies/${polar.id}`)).study
  assert(JSON.stringify(polarStudy.points.map((p) => p.value)) === '[0,2,4]', 'incidences 0, 2, 4')
  const cl = polarStudy.points.map((p) => p.result.coefficients.cl?.mean ?? NaN)
  assert(cl[2] > cl[0] + 0.05, `Cl grows with incidence: ${cl}`)

  // --- compare the two -------------------------------------------------------------------------
  await page.goto(`${studyUrl}`)
  await page.getByRole('link', { name: '← Studi' }).click()
  await page.getByTestId('study-grid').waitFor()
  for (const name of ['NACA a zero', polar.name]) await page.getByLabel(`Scegli «${name}» per il confronto`).check()
  await page.getByTestId('compare-button').click()
  await page.getByTestId('compare-table').locator('tbody tr').nth(1).waitFor()
  await page.getByTestId('compare-fields').locator('canvas').first().waitFor()
  await shot(page, 'compare')

  // --- test 33: a tapered wing, a study from the live section --------------------------------------
  await page.goto(app.url)
  const wingFile = join(app.home, 'ala.stl')
  writeFileSync(wingFile, stlOf(taperedWing(2, 1, 0.4, 12, 60)))
  await page.getByTestId('import-input').setInputFiles(wingFile)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/)
  const modelUrl = page.url()
  const units = page.getByRole('dialog', { name: 'Unità del file' })
  await units.getByRole('button', { name: 'Conferma' }).click()
  await units.waitFor({ state: 'detached' })
  await page.getByLabel('Tipo di studio').selectOption('ala')
  await page.getByText('Aggiornamento del modello…').waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Apri in galleria' }).click()
  await page.waitForURL(/\/galleria\/modello\//)
  const wingTunnel = page.url()
  await page.getByTestId('model-panel').waitFor()
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 30000 })
  await page.waitForTimeout(1500) // well over 300 steps
  const depthBefore = await page.getByTestId('section-depth').textContent()
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(300)
  }
  assert((await page.getByTestId('section-depth').textContent()) !== depthBefore, 'the depth moved')
  assert(/[1-9]\d* passi\/s/.test(await page.getByTestId('top-steps').textContent()), 'the flow keeps running')
  await page.getByTestId('study-panel').getByRole('button', { name: 'Salva studio' }).click()
  const wingNaming = page.getByRole('dialog', { name: 'Salva studio' })
  await wingNaming.getByLabel('Nome dello studio').fill('Ala in sezione')
  await wingNaming.getByRole('button', { name: 'Conferma' }).click()
  await page.getByTestId('study-saved').waitFor({ timeout: 60000 })
  // Reopened from the list.
  await page.goto(app.url)
  await page.getByRole('tab', { name: /Studi/ }).click()
  await page.getByTestId('study-grid').getByText('Ala in sezione').click()
  await page.getByTestId('study-page').waitFor()
  assert((await page.getByTestId('study-conditions').textContent()).includes('Sezione verticale'), 'the cut is in the conditions')
  const profiles = await api('profiles')
  assert(profiles.some((p) => p.source_kind === 'section3d' && /sezione verticale/.test(p.name)), 'the live section was saved as a profile')

  // --- test 28: a depth series of five sections ------------------------------------------------
  await page.goto(wingTunnel)
  await page.getByTestId('model-panel').waitFor()
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 30000 })
  await page.evaluate(`window.__gdvSeriesCap = ${SHORT_POINTS}`)
  await page.getByTestId('series-parameter').selectOption('depth')
  await page.getByTestId('series-step').fill('5')
  await page.getByTestId('series-step').press('Enter')
  await page.getByTestId('series-start').click()
  await page.getByTestId('series-saved').waitFor({ timeout: 400000 })
  await shot(page, 'depth-series')
  const depth = (await api('studies')).find((s) => s.parameter === 'depth')
  const depthStudy = (await api(`studies/${depth.id}`)).study
  assert(depthStudy.points.length === 5, `five sections: ${depthStudy.points.length}`)
  const chords = depthStudy.points.map((p) => {
    const xs = p.result.case.profile.loops.flatMap((l) => l.points.map((q) => q[0]))
    return Math.max(...xs) - Math.min(...xs)
  })
  for (let k = 1; k < chords.length; k++) assert(chords[k] < chords[k - 1], `chords grow towards the root: ${chords}`)
  const references = new Set(depthStudy.points.map((p) => p.result.plan.reference_length.toFixed(9)))
  assert(references.size === 1, `one fixed reference length: ${[...references]}`)
  depthStudy.points.forEach((p) => {
    assert(Math.abs(p.result.case.profile.source.depth_fraction - p.value) < 1e-9, 'each point saved with its depth')
    assert(p.result.coefficients.cl !== null, 'each point has a Cl')
  })
  await page.goto(`${app.url}studi/${depth.id}`)
  await page.getByTestId('series-sections').waitFor()
  await page.getByTestId('series-coefficients').waitFor()
  await shot(page, 'depth-study')
  await page.goto(modelUrl)

  assert(errors.length === 0, `console errors:\n${errors.join('\n')}`)
  console.log('OK')
} finally {
  await browser.close()
  await app.stop()
}
