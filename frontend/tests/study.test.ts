// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Studies on the interface side (SPEC §11): the values of a series, the time
// left, the upload container and a point's JSON (never a NaN), the saved
// mean fields read back and framed, a study JSON recognised on drop.
import { describe, expect, it } from 'vitest'
import { bodyBox, frameAround, parseFields, rangeOf, valuesOf } from '../src/lib/fields'
import { num } from '../src/lib/format'
import { sniffBytes } from '../src/lib/sniff'
import type { CasePlan, CaseSetup } from '../src/lib/types'
import type { EngineResult } from '../src/sim2d/engine'
import { evenValues, rangeValues, remainingSeconds, type SeriesProgress } from '../src/tunnel/series'
import { packParts, pointUpload, statusOf } from '../src/tunnel/study'

describe('series values', () => {
  it('runs a range inclusive, either way, with a step that may not divide it', () => {
    expect(rangeValues(-4, 16, 2)).toEqual([-4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16])
    expect(rangeValues(0, 5, 2)).toEqual([0, 2, 4])
    expect(rangeValues(4, 0, 2)).toEqual([4, 2, 0])
    expect(rangeValues(0, 1, 0)).toEqual([])
    expect(rangeValues(0, 0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3])
  })
  it('spreads depths evenly, ends included (default 11 sections from 5% to 95%)', () => {
    const v = evenValues(0.05, 0.95, 11)
    expect(v).toHaveLength(11)
    expect(v[0]).toBe(0.05)
    expect(v[10]).toBe(0.95)
    expect(v[5]).toBeCloseTo(0.5)
    expect(evenValues(0.3, 0.9, 1)).toEqual([0.3])
  })
  it('estimates the time left from the points done', () => {
    const p: SeriesProgress = { index: 2, total: 11, value: 0, step: 0, cap: 1, durations: [20, 30], statuses: [], state: 'running', error: null }
    expect(remainingSeconds(p)).toBe(25 * 9)
    expect(remainingSeconds({ ...p, durations: [] })).toBeNull()
  })
})

describe('the upload', () => {
  it('packs named parts as routes_studies.py reads them', async () => {
    const blob = packParts([
      { name: 'point', data: '{"a":1}' },
      { name: 'fields', data: new Uint8Array([1, 2, 3]) },
    ])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('GDV1')
    expect(view.getUint32(4, true)).toBe(5)
    expect(new TextDecoder().decode(bytes.subarray(8, 13))).toBe('point')
    expect(Number(view.getBigUint64(13, true))).toBe(7)
    const second = 21 + 7
    expect(new TextDecoder().decode(bytes.subarray(second + 4, second + 10))).toBe('fields')
    expect(bytes.length).toBe(4 + (4 + 5 + 8 + 7) + (4 + 6 + 8 + 3))
  })

  const plan = { reference_kind: 'chord' } as CasePlan
  const result = (over: Partial<EngineResult> = {}): EngineResult => ({
    step: 4000,
    unstable: false,
    stats: {
      status: 'converged',
      regime: 'steady',
      cd: { mean: 0.05, std: 0.001 },
      cl: { mean: 0.4, std: 0.002 },
      cm: { mean: -0.01, std: 0 },
      clcd: 8,
      strouhal: null,
      change: 0.001,
      averagedSteps: 1600,
    },
    rhoInf: 1.0002,
    history: [
      { step: 8, cd: 0.1, cl: 0, cm: 0 },
      { step: 16, cd: NaN, cl: 0, cm: 0 },
      { step: 24, cd: 0.09, cl: 0.01, cm: 0 },
    ],
    cp: [
      { xc: 0, s: 0.5, upper: true, cp: 1, x: 10, y: 20 },
      { xc: 0.5, s: 0.2, upper: true, cp: Infinity, x: 15, y: 21 },
    ],
    mean: { sums: new Float32Array(4), samples: 200, rhoInf: 1.0001 },
    mask: new Uint8Array(1),
    nx: 1,
    ny: 1,
    ...over,
  })
  const ctx = { setup: {} as CaseSetup, plan, value: 4, elapsedSeconds: 12, lines: [], smoke: false, sequential: 'viridis' as const, diverging: 'coolwarm' as const, scene: null }

  it('never sends a NaN: unfinite samples and Cp points are left out', () => {
    const up = pointUpload(result(), ctx)
    expect(up.history.step).toEqual([8, 24])
    expect(up.contour.cp).toEqual([1])
    expect(up.contour.chord).toBe(true)
    expect(JSON.stringify(up)).not.toMatch(/NaN|Infinity|\[[^\]]*null/)
    expect(up.coefficients.cl).toEqual({ mean: 0.4, std: 0.002 })
    expect(up.mean).toEqual({ samples: 200, rho_inf: 1.0001 })
    expect(up.value).toBe(4)
  })
  it('an unstable case keeps no numbers and no fields', () => {
    const r = result({ unstable: true })
    const up = pointUpload(r, ctx)
    expect(statusOf(r)).toBe('unstable')
    expect(up.status).toBe('unstable')
    expect([up.coefficients.cd, up.coefficients.cl, up.coefficients.cm, up.coefficients.clcd]).toEqual([null, null, null, null])
    expect(up.mean).toBeNull()
  })
  it('a case still in its transient is provisional', () => {
    const r = result({ stats: { ...result().stats, status: 'transient', cd: null, cl: null, cm: null, clcd: null } })
    expect(statusOf(r)).toBe('provisional')
    expect(pointUpload(r, ctx).coefficients.cd).toBeNull()
  })
})

describe('saved mean fields', () => {
  function encode(nx: number, ny: number, dx: number): ArrayBuffer {
    let header = new TextEncoder().encode(JSON.stringify({ nx, ny, dx, names: ['u', 'v', 'cp', 'vorticity'], units: {}, samples: 7 }))
    const padded = new Uint8Array(Math.ceil(header.length / 4) * 4).fill(32)
    padded.set(header)
    header = padded
    const n = nx * ny
    const out = new Uint8Array(4 + header.length + 16 * n + n)
    new DataView(out.buffer).setUint32(0, header.length, true)
    out.set(header, 4)
    const floats = new Float32Array(4 * n)
    for (let k = 0; k < n; k++) {
      floats[k] = 3 // u
      floats[n + k] = 4 // v
      floats[2 * n + k] = k % 2 ? -0.5 : 0.5 // cp
    }
    out.set(new Uint8Array(floats.buffer), 4 + header.length)
    // A solid block at i 4-5, j 1-2.
    const solid = out.subarray(4 + header.length + 16 * n)
    for (const [i, j] of [[4, 1], [5, 1], [4, 2], [5, 2]]) solid[j * nx + i] = 1
    return out.buffer
  }

  it('reads back the arrays, frames the body and ranges the fluid', () => {
    const f = parseFields(encode(20, 4, 0.1))
    expect([f.nx, f.ny, f.samples]).toEqual([20, 4, 7])
    expect(valuesOf(f, 'speed')[0]).toBe(5)
    const box = bodyBox(f)!
    expect(box.x0).toBeCloseTo(0.4)
    expect(box.x1).toBeCloseTo(0.6)
    expect(box.y0).toBeCloseTo(0.1)
    const frame = frameAround(f, 1, 0.5)
    expect(frame.x1 - frame.x0).toBeCloseTo(1)
    expect(frame.x0).toBeCloseTo(0.2)
    expect((frame.y0 + frame.y1) / 2).toBeCloseTo(0.2)
    expect(rangeOf(f, valuesOf(f, 'cp'), true)).toEqual([-0.5, 0.5])
  })
})

describe('odds and ends', () => {
  it('recognises a study exported as JSON', () => {
    const json = new TextEncoder().encode('{\n "formato": "galleriadelvento-studio", "versione": 1, "study": {}}')
    expect(sniffBytes(json, json.length)).toBe('study')
    expect(sniffBytes(new TextEncoder().encode('{"x": 1}'), 8)).toBe('unknown')
  })
  it('a value that rounds to zero reads 0, not -0', () => {
    expect(num(-0.00001, 3)).toBe('0')
    expect(num(-0.4, 0)).toBe('0')
    expect(num(-0.6, 0)).toBe('-1')
  })
})
