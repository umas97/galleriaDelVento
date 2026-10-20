// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 6 end to end: the settings screen (written, persisted, used by the
// tunnel), tooltips above the side panels, the guide ("?", contextual links),
// the tunnel view's zoom and pan, the model's mini-scene enlarged and free
// during a series, and test 34: a lost WebGL context, «Riprendi», and the flow
// running again. No console errors.
//
//   node tests/e2e/phase6.e2e.mjs [screenshot-dir] [extra Chrome flags...]
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
const running = (page) =>
  page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 60000 })
const zoomOf = async (page) => Number((await page.getByTestId('zoom-level').textContent()).replace('×', '').replace(',', '.'))

const app = await startApp()
const browser = await launchChrome({ extraArgs: flags })
const errors = []
const api = (path, init = {}) =>
  fetch(`${app.url}api/${path}`, { ...init, headers: { 'Content-Type': 'application/json', Origin: app.url.slice(0, -1), ...(init.headers ?? {}) } }).then((r) => r.json())

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || (msg.type() === 'warning' && /READ-usage buffer/.test(msg.text()))) errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  const profile = await api('profiles', {
    method: 'POST',
    body: JSON.stringify({ name: 'NACA 0012', loops: [{ points: naca4('0012', 160, 1) }], source: { kind: 'editor', derived_from: null, origin: null }, spline: null }),
  })

  // --- settings ------------------------------------------------------------------------------
  await page.goto(app.url)
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-page').waitFor()
  await page.getByTestId('setting-unita_velocita').selectOption('km/h')
  await page.getByTestId('setting-risoluzione').selectOption('bozza')
  await page.getByTestId('setting-csv_separatore').selectOption(',')
  await page.waitForFunction(async () => {
    const r = await fetch('/api/settings').then((x) => x.json())
    return r.values.unita_velocita === 'km/h' && r.values.risoluzione === 'bozza' && r.values.csv_separatore === ','
  })
  await page.getByTestId('storage-total').waitFor()
  await shot(page, 'settings')
  // Survives a reload: it is on disk, not in the page.
  await page.reload()
  // (the page shows the defaults until the settings arrive: wait for them)
  await page.waitForFunction(() => document.querySelector('[data-testid="setting-unita_velocita"]')?.value === 'km/h', null, { timeout: 10000 })

  // --- the tunnel uses them --------------------------------------------------------------------
  await page.goto(`${app.url}galleria/profilo/${profile.id}`)
  await page.getByTestId('tunnel-top').getByText(/Re reale/).waitFor({ timeout: 30000 })
  assert((await page.getByTestId('resolution').inputValue()) === 'bozza', 'resolution from the settings')
  assert(await page.getByText('Velocità (km/h)').isVisible(), 'speed in km/h from the settings')
  await running(page)

  // --- a tooltip in the left panel is above everything -------------------------------------------
  await page.getByText('Incidenza (°) ⓘ').hover()
  const tip = page.getByRole('tooltip')
  await tip.waitFor()
  const placement = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { parentIsBody: el.parentElement === document.body, z: getComputedStyle(el).zIndex, r: [r.left, r.top, r.right, r.bottom], w: innerWidth, h: innerHeight }
  })
  assert(placement.parentIsBody, 'the tooltip lives on <body>, outside the scrolling panel')
  assert(Number(placement.z) >= 1000, `tooltip z-index ${placement.z}`)
  assert(placement.r[0] >= 0 && placement.r[1] >= 0 && placement.r[2] <= placement.w && placement.r[3] <= placement.h, 'tooltip inside the window')
  await shot(page, 'tooltip')
  await page.mouse.move(700, 450)
  await tip.waitFor({ state: 'detached' })

  // --- the guide ---------------------------------------------------------------------------------
  await page.keyboard.press('?')
  const guide = page.getByTestId('guide')
  await guide.waitFor()
  assert(await page.getByTestId('guide-entry-shortcuts-tunnel').isVisible(), '"?" opens on the shortcuts')
  await shot(page, 'guide-shortcuts')
  await page.keyboard.press('Escape')
  await guide.waitFor({ state: 'detached' })
  await page.getByTestId('nav-guide').click()
  await guide.waitFor()
  assert((await guide.textContent()).includes('Re = V · L_ref / ν'), 'the guide has the formulas')
  await page.getByTestId('nav-guide').click()
  await guide.waitFor({ state: 'detached' })

  // --- zoom and pan of the flow view, with the flow running ---------------------------------------
  const overlay = page.getByTestId('tunnel-overlay')
  const box = await overlay.boundingBox()
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5)
  for (let k = 0; k < 4; k++) await page.mouse.wheel(0, -300)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="zoom-level"]').textContent.replace('×', '').replace(',', '.')) > 2)
  // Drag the fluid with «Sposta»: the view moves, the body does not.
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 5 })
  await page.mouse.up()
  await running(page)
  await shot(page, 'tunnel-zoomed')
  await page.keyboard.press('0')
  assert((await zoomOf(page)) === 1, 'key 0: whole chamber')
  await page.keyboard.press('+')
  assert((await zoomOf(page)) === 1.5, 'key +')
  await page.getByTestId('zoom-fit').click()
  assert((await zoomOf(page)) === 1, '«Intera»')

  // --- the contextual guide link -------------------------------------------------------------------
  await page.getByTestId('coef-cd').getByTestId('guide-link-coefficients-cd').click()
  const entry = page.getByTestId('guide-entry-coefficients-cd')
  await entry.waitFor()
  assert((await entry.getAttribute('class')).includes('border-accent'), 'the entry is highlighted')
  assert(await entry.isVisible(), 'and scrolled into view')
  await shot(page, 'guide-cd')
  await page.keyboard.press('Escape')

  // --- test 34: the GPU stops the simulation -----------------------------------------------------
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="tunnel-canvas"]')
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()
  })
  await page.getByText('La GPU ha interrotto la simulazione').waitFor({ timeout: 10000 })
  await shot(page, 'context-lost')
  await page.getByRole('button', { name: 'Riprendi' }).click()
  await page.getByText('La GPU ha interrotto la simulazione').waitFor({ state: 'detached' })
  await running(page)
  assert((await page.getByTestId('tunnel-top').textContent()).includes('NACA 0012'), 'the same profile after «Riprendi»')

  // --- the theme follows the system (SPEC §12.3) -------------------------------------------------
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.emulateMedia({ colorScheme: 'dark' })
  assert((await background()) === 'rgb(17, 17, 17)', `dark background: ${await background()}`)
  await page.waitForTimeout(500)
  await shot(page, 'tunnel-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  assert((await background()) === 'rgb(246, 246, 247)', `light background: ${await background()}`)

  // --- a model: the mini-scene, enlarged ------------------------------------------------------------
  await page.goto(app.url)
  const wingFile = join(app.home, 'ala.stl')
  writeFileSync(wingFile, stlOf(taperedWing(2, 1, 0.4, 12, 60)))
  await page.getByTestId('import-input').setInputFiles(wingFile)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/)
  const units = page.getByRole('dialog', { name: 'Unità del file' })
  await units.getByRole('button', { name: 'Conferma' }).click()
  await units.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Apri in galleria' }).click()
  await page.waitForURL(/\/galleria\/modello\//)
  await page.getByTestId('tunnel-scene').waitFor({ timeout: 30000 })
  await running(page)
  await page.getByTestId('scene-enlarge').click()
  const big = page.getByTestId('tunnel-scene-big')
  await big.waitFor()
  const sceneBox = await big.boundingBox()
  assert(sceneBox.width > 500 && sceneBox.height > 300, `enlarged scene ${sceneBox.width}×${sceneBox.height}`)
  await page.mouse.move(sceneBox.x + sceneBox.width / 2, sceneBox.y + sceneBox.height / 2)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(300)
  await shot(page, 'scene-big')
  await page.getByTestId('scene-shrink').click()
  await big.waitFor({ state: 'detached' })
  await page.getByTestId('tunnel-scene').waitFor()

  assert(errors.length === 0, `console errors:\n${errors.join('\n')}`)
  console.log('OK')
} finally {
  await browser.close()
  await app.stop()
}
