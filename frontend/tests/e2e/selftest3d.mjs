// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 39's browser half (and the 3D solver's benchmark): runs the cases of
// <in.json> in the WGSL solver (window.gdvSelfTest3D / gdvBench3D,
// sim3d/selftest.ts) inside the real program, in the system Chrome, and writes
// the results to <out.json>.
//
//   node tests/e2e/selftest3d.mjs <in.json> <out.json> [--gpu] [extra Chrome flags...]
//
// <in.json> is {"mode": "test" | "bench", "cases": [...]}. WebGPU runs on
// SwiftShader by default (any machine with Chrome); --gpu uses the real
// adapter through Vulkan.
import { readFileSync, writeFileSync } from 'node:fs'
import { launchChrome, startApp } from './harness.mjs'

const [input, output, ...rest] = process.argv.slice(2)
const real = rest.includes('--gpu')
const flags = rest.filter((f) => f !== '--gpu')
const { mode, cases } = JSON.parse(readFileSync(input, 'utf8'))
const webgpu = real
  ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']
  : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']
const app = await startApp()
const browser = await launchChrome({ extraArgs: [...webgpu, ...flags] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`${app.url}?selftest3d=1`)
  await page.waitForFunction(() => typeof window.gdvSelfTest3D === 'function', null, { timeout: 30000 })
  const results = []
  for (const c of cases)
    results.push(
      await page.evaluate(
        ([m, x]) => (m === 'bench' ? window.gdvBench3D(x) : window.gdvSelfTest3D(x)),
        [mode, c],
      ),
    )
  if (errors.length) throw new Error(errors.join('\n'))
  writeFileSync(output, JSON.stringify(results))
  console.log('OK', results.map((r) => (mode === 'bench' ? `${Math.round(r.stepsPerSecond)} passi/s` : `${Math.round(r.ms)} ms`)).join(' '), results[0]?.adapter)
} finally {
  await browser.close()
  await app.stop()
}
