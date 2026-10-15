// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 25's browser half: runs the lattice cases of <in.json> in the shader
// (window.gdvSelfTest, sim2d/selftest.ts) inside the real program, in the
// system Chrome, and writes the fields to <out.json>. Extra Chrome flags may
// follow (e.g. --use-angle=vulkan for the real GPU).
import { readFileSync, writeFileSync } from 'node:fs'
import { launchChrome, startApp } from './harness.mjs'

const [input, output, ...flags] = process.argv.slice(2)
const cases = JSON.parse(readFileSync(input, 'utf8'))
const app = await startApp()
const browser = await launchChrome({ extraArgs: flags })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${app.url}?selftest=1`)
  await page.waitForFunction(() => typeof window.gdvSelfTest === 'function', null, { timeout: 30000 })
  const results = []
  for (const c of cases) results.push(await page.evaluate((x) => window.gdvSelfTest(x), c))
  if (errors.length) throw new Error(errors.join('\n'))
  writeFileSync(output, JSON.stringify(results))
  console.log('OK', results.map((r) => `${Math.round(r.ms)} ms`).join(' '), results[0]?.renderer)
} finally {
  await browser.close()
  await app.stop()
}
