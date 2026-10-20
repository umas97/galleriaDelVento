// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 41, the Phase 7b half (SPEC §24.4): a simplified Ahmed body opened in
// the 3D tunnel from its setup screen; the flow runs; the cut plane (speed and
// Cp, three orientations), Cp on the surface, smoke from the rake (moved and
// turned vertical), particles; the camera; a rotation and a new speed restart
// the flow; snapshot and video; the WebGPU device lost and resumed; a browser
// without WebGPU gets its message. No console errors.
//
// Chrome runs WebGPU on the real GPU (Vulkan, as the benchmarks): in headless
// Chrome a WebGPU canvas on SwiftShader loses its instance at the first frame
// ("A valid external Instance reference no longer exists", Chrome 155) --
// compute alone works there, which is why test 39 can use it.
//
//   node tests/e2e/phase7.e2e.mjs [screenshot-dir] [extra Chrome flags...]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ahmedBody } from '../synthetic.ts'
import { assert, launchChrome, startApp } from './harness.mjs'

function stlOf({ positions, indices }) {
  const count = indices.length / 3
  const buf = Buffer.alloc(84 + 50 * count)
  buf.write('e2e ahmed', 0)
  buf.writeUInt32LE(count, 80)
  for (let k = 0; k < count; k++) {
    const o = 84 + 50 * k
    for (let n = 0; n < 3; n++)
      for (let m = 0; m < 3; m++) buf.writeFloatLE(positions[3 * indices[3 * k + n] + m], o + 12 + 12 * n + 4 * m)
  }
  return buf
}

const args = process.argv.slice(2)
const shots = args[0] && !args[0].startsWith('--') ? args.shift() : null
const flags = args
const webgpu = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
/** The first number of an Italian text ("1.234 passi/s" → 1234). */
const number = (text) => Number((text.match(/-?[\d.]+(?:,\d+)?/) ?? ['NaN'])[0].replace(/\./g, '').replace(',', '.'))

const app = await startApp()
const browser = await launchChrome({ extraArgs: [...webgpu, ...flags] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || (msg.type() === 'warning' && /WebGPU|GPU|Invalid/.test(msg.text()))) errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
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

  // --- from the setup screen into the 3D tunnel ------------------------------------------
  await page.goto(`${app.url}modelli/${id}`)
  await page.getByRole('link', { name: 'Galleria 3D' }).click()
  await page.waitForURL(`**/galleria3d/${id}`)
  await page.getByTestId('resolution').selectOption('bozza')
  const running = async (what) =>
    page.waitForFunction(
      () => /[1-9][\d.]* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''),
      null,
      { timeout: 180_000 },
    ).catch((e) => {
      throw new Error(`${what}: il flusso non parte (${e.message})`)
    })
  await running('primo caso')
  const top = await page.getByTestId('tunnel-top').innerText()
  assert(/Galleria 3D — «ahmed»/.test(top), top)
  assert(/Re reale .* — Re simulato/.test(top), `similitudine nel titolo: ${top}`)
  assert(/Bloccaggio d’area \d/.test(top), top)
  assert(await page.getByTestId('badge-partial').isVisible(), 'badge «Similitudine parziale»')
  assert(await page.getByTestId('badge-coarse').isVisible(), 'badge «Griglia grossolana»')
  assert(/celle solide/.test(await page.getByTestId('voxel-info').innerText()), 'voxel')
  const ground = await page.getByTestId('ground').inputValue()
  assert(ground === 'moving', `pavimento del tipo «veicolo»: ${ground}`)
  await page.waitForTimeout(3000)
  await shot(page, 'p7-plane')

  // --- views ------------------------------------------------------------------------------
  const legends = () => page.getByTestId('legends3d').innerText()
  assert(/Velocità sul piano \(m\/s\)/.test(await legends()), 'legenda del piano')
  await page.keyboard.press('2')
  await page.waitForFunction(() => /Cp sul piano/.test(document.querySelector('[data-testid="legends3d"]')?.textContent ?? ''))
  for (const axis of ['0', '2', '1']) {
    await page.getByTestId('plane-axis').selectOption(axis)
    await page.waitForTimeout(400)
  }
  const before = await page.getByTestId('plane-position').innerText()
  await page.getByTestId('plane-slider').focus()
  await page.keyboard.press('PageUp')
  await page.keyboard.press('Shift+PageUp')
  await page.waitForTimeout(200)
  assert((await page.getByTestId('plane-position').innerText()) !== before, 'PagSu sposta il piano')
  await page.keyboard.press('1')
  await page.keyboard.press('3')
  await page.waitForFunction(() => /Cp sulla superficie/.test(document.querySelector('[data-testid="legends3d"]')?.textContent ?? ''))
  await page.keyboard.press('4')
  await page.getByTestId('rake-panel').waitFor()
  await page.getByTestId('rake-across').fill('400')
  await page.getByTestId('rake-panel').getByRole('combobox').selectOption('vertical')
  await page.keyboard.press('5')
  assert(await page.getByTestId('particles').isChecked(), 'particelle')
  await page.keyboard.press('6')
  await page.waitForFunction(() => /Velocità delle particelle/.test(document.querySelector('[data-testid="legends3d"]')?.textContent ?? ''))
  await page.keyboard.press('6')
  await page.waitForTimeout(4000)
  await shot(page, 'p7-views')

  // --- the camera -------------------------------------------------------------------------
  const canvas = page.getByTestId('tunnel3d-canvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  await page.mouse.wheel(0, -400)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  for (const view of ['Dall’alto', 'Laterale', 'Frontale', 'Isometrica']) await page.getByRole('button', { name: view, exact: true }).click()
  await canvas.dblclick()

  // --- snapshot: twice the canvas, with something drawn on it -------------------------------
  const [snapshot] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')])
  assert(/^galleria3d-.*\.png$/.test(snapshot.suggestedFilename()), snapshot.suggestedFilename())
  const png = readFileSync(await snapshot.path()).toString('base64')
  const stats = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = document.createElement('canvas')
    c.width = image.width
    c.height = image.height
    const ctx = c.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const shown = document.querySelector('[data-testid="tunnel3d-canvas"]')
    const px = ctx.getImageData(0, 0, image.width, Math.round(shown.height * 2)).data
    const colours = new Set()
    for (let i = 0; i < px.length; i += 4 * 97) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])
    return { width: image.width, canvas: shown.width, colours: colours.size }
  }, png)
  assert(stats.width === 2 * stats.canvas, `istantanea al doppio: ${JSON.stringify(stats)}`)
  assert(stats.colours > 200, `l’istantanea ha la vista: ${JSON.stringify(stats)}`)

  // --- video ------------------------------------------------------------------------------
  await page.keyboard.press('v')
  await page.waitForTimeout(2500)
  const [video] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('v')])
  assert(/\.webm$/.test(video.suggestedFilename()), video.suggestedFilename())
  assert(readFileSync(await video.path()).length > 1000, 'video vuoto')

  // --- a rotation and a new speed restart the flow -------------------------------------------
  const area = async () => (await page.getByTestId('voxel-info').innerText()).match(/area frontale ([\d,]+)/)[1]
  const straight = await area()
  await page.getByTestId('yaw').fill('20')
  await page.getByTestId('yaw').press('Enter')
  await page.waitForFunction((a) => !document.querySelector('[data-testid="voxel-info"]')?.textContent?.includes(a), straight, { timeout: 120_000 })
  await running('dopo la rotazione')
  const turned = await area()
  assert(number(turned) > number(straight), `di traverso l’area frontale cresce: ${straight} → ${turned}`)
  const reynolds = await page.getByTestId('top-reynolds').innerText()
  await page.getByTestId('speed').fill('15')
  await page.getByTestId('speed').press('Enter')
  await page.waitForFunction((r) => document.querySelector('[data-testid="top-reynolds"]')?.textContent !== r, reynolds, { timeout: 60_000 })
  await running('dopo la velocità')
  await shot(page, 'p7-turned')

  // --- the device lost and resumed ----------------------------------------------------------
  await page.evaluate(() => document.querySelector('[data-testid="tunnel3d-canvas"]').getContext('webgpu').getConfiguration().device.destroy())
  await page.getByText('La GPU ha interrotto la simulazione').waitFor()
  await page.getByRole('button', { name: 'Riprendi' }).click()
  await page.waitForFunction(() => !document.body.textContent.includes('La GPU ha interrotto'))
  await running('dopo «Riprendi»')

  // The 2D tunnel of the same model is one click away.
  await page.getByRole('link', { name: 'Galleria 2D (sezioni)' }).click()
  await page.waitForURL(`**/galleria/modello/${id}`)

  const filtered = errors.filter((e) => !/Device was destroyed|lost|destroyed/i.test(e))
  assert(filtered.length === 0, filtered.join('\n'))
} finally {
  await browser.close()
}

// --- without WebGPU: the message, and the rest of the program works ------------------------
const plain = await launchChrome({ extraArgs: flags })
try {
  const page = await plain.newPage({ viewport: { width: 1280, height: 800 } })
  const list = await fetch(`${app.url}api/models`).then((r) => r.json())
  await page.goto(`${app.url}galleria3d/${list[0].id}`)
  await page.getByTestId('no-webgpu').waitFor({ timeout: 30_000 })
  await page.getByRole('link', { name: '← Preparazione del modello' }).click()
  await page.getByRole('link', { name: 'Galleria 3D' }).waitFor()
} finally {
  await plain.close()
  await app.stop()
}
console.log('OK')
