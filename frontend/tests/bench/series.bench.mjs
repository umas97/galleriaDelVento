// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SPEC §17, the incidence series: a NACA 0012 at the Normale resolution, the
// default series of 11 incidences (−4…16°, step 2°), each point from rest to
// convergence or to its ceiling (ramp + 20 T_c), timed from «Avvia la serie»
// to the series saved. Prints the total, and for each point its steps, time
// and status. In the system Chrome on the real GPU (ANGLE on Vulkan; other
// flags may be given).
//
//   node tests/bench/series.bench.mjs [speed m/s] [extra Chrome flags...]
import { naca4 } from '../synthetic.ts'
import { launchChrome, startApp } from '../e2e/harness.mjs'

const [speedArg, ...flags] = process.argv.slice(2)
const speed = Number(speedArg ?? 15)
const app = await startApp()
const browser = await launchChrome({ extraArgs: flags.length ? flags : ['--use-angle=vulkan', '--enable-features=Vulkan'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const origin = app.url.slice(0, -1)
  const profile = await fetch(`${app.url}api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'NACA 0012', loops: [{ points: naca4('0012', 160, 1) }], source: { kind: 'editor', derived_from: null, origin: null }, spline: null }),
  }).then((r) => r.json())
  await page.goto(app.url)
  await page.evaluate((v) => localStorage.setItem('tunnel-case', JSON.stringify({ resolution: 'normale', speed: v })), speed)
  await page.goto(`${app.url}galleria/profilo/${profile.id}`)
  await page.waitForFunction(() => /[1-9]\d* passi\/s/.test(document.querySelector('[data-testid="top-steps"]')?.textContent ?? ''), null, { timeout: 60000 })
  const plan = await page.getByTestId('tunnel-top').textContent()
  const started = performance.now()
  await page.getByTestId('series-start').click()
  await page.getByTestId('series-saved').waitFor({ timeout: 30 * 60 * 1000 })
  const total = (performance.now() - started) / 1000
  const studies = await fetch(`${app.url}api/studies`).then((r) => r.json())
  const study = await fetch(`${app.url}api/studies/${studies[0].id}`).then((r) => r.json())
  const points = study.study.points.map((p) => ({
    angle: p.value,
    steps: p.steps,
    seconds: Number(p.elapsed_s.toFixed(1)),
    stepsPerSecond: Math.round(p.steps / p.elapsed_s),
    status: p.result.status,
    regime: p.result.coefficients.regime,
    cap: p.result.plan.max_steps,
    cl: p.result.coefficients.cl?.mean ?? null,
    cd: p.result.coefficients.cd?.mean ?? null,
  }))
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''
  })
  console.log(JSON.stringify({ total: Number(total.toFixed(1)), plan, renderer, points }, null, 1))
} finally {
  await browser.close()
  await app.stop()
}
