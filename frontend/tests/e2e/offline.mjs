// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 4's browser half (SPEC §2.2): a session in the tunnel, in the system
// Chrome with the program's offline flags, behind the recording proxy that
// pytest runs on loopback. The proxy -- not this script -- decides whether
// anything left: here we only drive the session.
//
//   node tests/e2e/offline.mjs <app-url> <proxy-port> [extra Chrome flags...]
import { naca4 } from '../synthetic.ts'
import { assert, launchChrome } from './harness.mjs'

const [url, proxyPort, ...flags] = process.argv.slice(2)
const browser = await launchChrome({
  extraArgs: [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', ...flags],
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
  assert(errors.length === 0, errors.join('\n'))
  console.log('OK')
} finally {
  await browser.close()
}
