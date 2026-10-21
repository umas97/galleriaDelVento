// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Averages, convergence and Strouhal from coefficient samples (SPEC §9.5).
import { describe, expect, it } from 'vitest'
import { CoefficientSeries, dominantFrequency } from '../src/sim2d/series'

const options = { tcSteps: 500, transientSteps: 2000, lLat: 40, uLat: 0.08 }

describe('coefficient series', () => {
  it('waits for the transient, then averages and converges on a steady flow', () => {
    const s = new CoefficientSeries(options)
    for (let step = 8; step < 2000; step += 8) s.add({ step, cd: 3, cl: 0, cm: 0 })
    expect(s.stats().status).toBe('transient')
    for (let step = 2000; step < 4000; step += 8)
      s.add({ step, cd: 2 + 0.05 * Math.exp(-(step - 2000) / 200), cl: 0.001, cm: 0 })
    const stats = s.stats()
    expect(stats.regime).toBe('steady')
    expect(stats.status).toBe('converged')
    expect(stats.cd!.mean).toBeCloseTo(2.006, 2)
  })

  it('stays provisional while Cd still drifts', () => {
    const s = new CoefficientSeries(options)
    for (let step = 2000; step < 4000; step += 8) s.add({ step, cd: 2 + step * 1e-4, cl: 0, cm: 0 })
    expect(s.stats().status).toBe('provisional')
  })

  it('recognises shedding and gives the Strouhal number', () => {
    const s = new CoefficientSeries(options)
    const st = 0.165
    const f = (st * options.uLat) / options.lLat // cycles per step
    for (let step = 2000; step < 2000 + 12 / f; step += 8)
      s.add({ step, cd: 1.35 + 0.02 * Math.sin(4 * Math.PI * f * step), cl: 0.33 * Math.sin(2 * Math.PI * f * step), cm: 0 })
    const stats = s.stats()
    expect(stats.regime).toBe('periodic')
    expect(stats.strouhal!).toBeGreaterThan(0.155)
    expect(stats.strouhal!).toBeLessThan(0.175)
    expect(stats.status).toBe('converged')
    expect(stats.cl!.std).toBeCloseTo(0.33 / Math.SQRT2, 1)
  })

  it('in 3D the shedding may be sideways: the side force (cm slot) is analysed too', () => {
    const st = 0.165
    const f = (st * options.uLat) / options.lLat
    const feed = (s: CoefficientSeries) => {
      for (let step = 2000; step < 2000 + 12 / f; step += 8)
        s.add({ step, cd: 0.5 + 0.01 * Math.sin(4 * Math.PI * f * step), cl: 0.0005, cm: 0.2 * Math.sin(2 * Math.PI * f * step) })
    }
    const flat = new CoefficientSeries(options)
    feed(flat)
    expect(flat.stats().regime).toBe('steady')
    const sideways = new CoefficientSeries({ ...options, shedding: ['cl', 'cm'] })
    feed(sideways)
    const stats = sideways.stats()
    expect(stats.regime).toBe('periodic')
    expect(stats.strouhal!).toBeGreaterThan(0.155)
    expect(stats.strouhal!).toBeLessThan(0.175)
  })

  it('a change restarts the averages one convective time later', () => {
    const s = new CoefficientSeries(options)
    for (let step = 2000; step < 4000; step += 8) s.add({ step, cd: 2, cl: 0, cm: 0 })
    s.resetAverages(4000)
    for (let step = 4000; step < 4400; step += 8) s.add({ step, cd: 5, cl: 0, cm: 0 })
    expect(s.stats().status).toBe('transient')
    for (let step = 4400; step < 6000; step += 8) s.add({ step, cd: 1, cl: 0, cm: 0 })
    expect(s.stats().cd!.mean).toBeCloseTo(1, 6)
  })

  it('finds a frequency and ignores noise', () => {
    const values = Array.from({ length: 1024 }, (_, i) => Math.sin(2 * Math.PI * 0.01 * i * 8))
    const peak = dominantFrequency(values, 8)!
    expect(peak.frequency).toBeCloseTo(0.01, 3)
    expect(peak.ratio).toBeGreaterThan(10)
    let seed = 1
    const noise = Array.from({ length: 1024 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5)
    expect(dominantFrequency(noise, 8)!.ratio).toBeLessThan(10)
  })
})
