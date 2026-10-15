// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §17: index rebuild and section cut on a 1M-triangle mesh, measured in
// the slicer worker of the real interface in the system Chrome. The section
// screen runs the benchmark itself with `?bench=slicer` (index + 200 cuts
// spread over the whole depth).
//
//   node tests/bench/slicer.bench.mjs [runs]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { uvSphere } from '../synthetic.ts'
import { launchChrome, startApp } from '../e2e/harness.mjs'

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

const runs = Number(process.argv[2] ?? 3)
const app = await startApp()
const browser = await launchChrome()
try {
  const mesh = uvSphere(1, 500, 1000)
  const file = join(app.home, 'sfera-1M.stl')
  writeFileSync(file, stlOf(mesh))
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(app.url)
  await page.getByTestId('import-input').setInputFiles(file)
  await page.waitForURL(/\/modelli\/[0-9a-f]{16}$/, { timeout: 120000 })
  const id = page.url().split('/').pop()
  const results = []
  for (let r = 0; r < runs; r++) {
    await page.goto(`${app.url}modelli/${id}/sezioni?bench=slicer`)
    const text = await page.getByTestId('bench-result').textContent({ timeout: 120000 })
    results.push(JSON.parse(text))
    console.log(text)
  }
  const median = (k) => results.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(results.length / 2)]
  console.log(
    `triangoli ${results[0].triangles}: indice mediana ${median('indexMs').toFixed(0)} ms (≤ 400), ` +
      `taglio medio ${median('cutMeanMs').toFixed(2)} ms, p95 ${median('cutP95Ms').toFixed(2)} ms, ` +
      `max ${median('cutMaxMs').toFixed(2)} ms (≤ 10)`,
  )
} finally {
  await browser.close()
  await app.stop()
}
