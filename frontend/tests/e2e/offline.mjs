// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 4's browser half (SPEC §2.2), and test 42 (SPEC §24.4): a session in
// the tunnel and one in the 3D tunnel, in the system Chrome with the program's
// offline flags, behind the recording proxy that pytest runs on loopback. The
// proxy -- not this script -- decides whether anything left: here we only
// drive the sessions. WebGPU runs on the real GPU (Vulkan): a WebGPU canvas on
// SwiftShader does not survive its first frame in headless Chrome. With
// GDV_HEADFUL=1 Chrome opens a window instead, with its own GPU settings, as
// the program's window does (it needs WAYLAND_DISPLAY or DISPLAY).
//
//   node tests/e2e/offline.mjs <app-url> <proxy-port> [extra Chrome flags...]
import { ahmedBody, naca4 } from '../synthetic.ts'
import { assert, launchChrome } from './harness.mjs'

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

const [url, proxyPort, ...flags] = process.argv.slice(2)
const browser = await launchChrome({
  headless: !process.env.GDV_HEADFUL,
  extraArgs: [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    ...(process.env.GDV_HEADFUL ? [] : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']),
    ...flags,
  ],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url)
  await page.getByText('Nessun modello 3D').waitFor()
  const id = await page.evaluate(async (points) => {
    const r = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NACA 0012', loops: [{ points }], source: { kind: 'editor', derived_from: null, origin: null }, spline: null }),
    })
    return (await r.json()).id
  }, naca4('0012', 120, 1))
  await page.goto(`${url}galleria/profilo/${id}`)
  await page.getByTestId('resolution').selectOption('bozza')
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 60000 })
  for (const key of ['2', '3', '4', '6']) {
    await page.keyboard.press(key)
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(3000)

  // Test 42: the 3D tunnel, with every view on.
  const stl = Array.from(stlOf(ahmedBody()))
  const model = await page.evaluate(async (bytes) => {
    const r = await fetch('/api/models/import?nome=ahmed.stl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    })
    const id = (await r.json()).model.id
    await fetch(`/api/models/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: 'm', study_type: 'veicolo' }) })
    return id
  }, stl)
  await page.goto(`${url}galleria3d/${model}`)
  await page.getByTestId('resolution').selectOption('bozza')
  await page.waitForFunction(() => /[1-9][\d.]* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 120000 })
  for (const key of ['2', '3', '4', '5']) {
    await page.keyboard.press(key)
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(3000)
  assert(errors.length === 0, errors.join('\n'))
  console.log('OK')
} finally {
  await browser.close()
}
