// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phase 6: the tunnel view's zoom, where a tooltip goes, the guide's entries,
// and the last case against the settings.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placeTip } from '../src/components/Tip'
import { GUIDE_SECTIONS } from '../src/guide/content'
import { has } from '../src/i18n/it'
import { DEFAULT_SETTINGS } from '../src/lib/settings'
import { MAX_ZOOM, clampCentre, viewTransform } from '../src/sim2d/viewport'
import { remember, rememberedCase } from '../src/tunnel/lastCase'
import type { CaseState } from '../src/tunnel/TunnelCore'

const cellAt = (t: { originX: number; originY: number; cellsPerPixel: number }, px: number, py: number) => [(px - t.originX) * t.cellsPerPixel, (py - t.originY) * t.cellsPerPixel]

describe('tunnel view zoom', () => {
  it('at zoom 1 shows the whole chamber, letterboxed and centred', () => {
    const t = viewTransform(1200, 600, 1024, 384, 1, null)
    expect(t.cellsPerPixel).toBeCloseTo(1024 / 1200)
    expect(t.originX).toBeCloseTo(0)
    expect(cellAt(t, 600, 300)).toEqual([512, 192])
    // The letterbox: the chamber is centred vertically.
    expect(t.originY).toBeCloseTo((600 - 384 * (1200 / 1024)) / 2)
  })

  it('zoomed in, the centre given is in the middle of the canvas', () => {
    const t = viewTransform(1200, 600, 1024, 384, 4, [300, 200])
    const [x, y] = cellAt(t, 600, 300)
    expect(x).toBeCloseTo(300)
    expect(y).toBeCloseTo(200)
    expect(t.cellsPerPixel).toBeCloseTo(1024 / 1200 / 4)
  })

  it('never lets the chamber slide out of a view it fills', () => {
    const scale = (1200 / 1024) * 4
    const [cx, cy] = clampCentre(1200, 600, 1024, 384, scale, [-500, 9999])
    // The view's left edge on cell 0, its top edge on the last row.
    expect(cx - 1200 / (2 * scale)).toBeCloseTo(0)
    expect(cy + 600 / (2 * scale)).toBeCloseTo(384)
  })

  it('a dimension the view does not fill stays centred', () => {
    // Zoom 1.2 on a wide chamber: the height is still letterboxed.
    const scale = (1200 / 1024) * 1.2
    const [, cy] = clampCentre(1200, 600, 1024, 200, scale, [512, 10])
    expect(cy).toBe(100)
  })

  it('zooming about a point keeps that point under the pointer', () => {
    // The rule the engine uses: C' = P + (C − P) · old / new.
    const w = 1200
    const h = 600
    const before = viewTransform(w, h, 1024, 384, 2, [400, 190])
    const pointer: [number, number] = [900, 420]
    const p = cellAt(before, ...pointer)
    const c = cellAt(before, w / 2, h / 2)
    const k = 2 / 3
    const after = viewTransform(w, h, 1024, 384, 3, [p[0] + (c[0] - p[0]) * k, p[1] + (c[1] - p[1]) * k])
    const q = cellAt(after, ...pointer)
    expect(q[0]).toBeCloseTo(p[0])
    expect(q[1]).toBeCloseTo(p[1])
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(16)
  })
})

describe('tooltip placement', () => {
  const view = { width: 1280, height: 800 }
  it('goes above the anchor when there is room', () => {
    const p = placeTip({ left: 600, right: 640, top: 400, bottom: 420 }, { width: 200, height: 40 }, view)
    expect(p.top).toBe(400 - 6 - 40)
    expect(p.left).toBe(620 - 100)
  })
  it('goes below near the top of the window', () => {
    const p = placeTip({ left: 600, right: 640, top: 10, bottom: 30 }, { width: 200, height: 40 }, view)
    expect(p.top).toBe(36)
  })
  it('stays inside the window at the edges (the side panels)', () => {
    const left = placeTip({ left: 2, right: 20, top: 400, bottom: 420 }, { width: 250, height: 40 }, view)
    expect(left.left).toBe(6)
    const right = placeTip({ left: 1260, right: 1278, top: 400, bottom: 420 }, { width: 250, height: 40 }, view)
    expect(right.left + 250).toBe(1280 - 6)
  })
})

describe('guide', () => {
  it('every entry has a term and a text, every section a title', () => {
    for (const [section, ids] of Object.entries(GUIDE_SECTIONS)) {
      expect(has(`guide.section.${section}`)).toBe(true)
      for (const id of ids) {
        expect(has(`guide.${section}.${id}.term`), `${section}.${id}.term`).toBe(true)
        expect(has(`guide.${section}.${id}.text`), `${section}.${id}.text`).toBe(true)
      }
    }
  })
  it('explains the coefficients and the symbols of the top bar', () => {
    for (const id of ['cd', 'cl', 'cm', 'clcd', 'cp', 'st']) expect(GUIDE_SECTIONS.coefficients).toContain(id)
    for (const id of ['re', 'resim', 'ma', 'tau', 'blockage', 'tc']) expect(GUIDE_SECTIONS.symbols).toContain(id)
  })
})

describe('last case and settings', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
  afterEach(() => store.clear())
  const state = (over: Partial<CaseState>): CaseState => ({
    fluid: 'aria',
    temperature_c: 20,
    speed: 15,
    angle_deg: 0,
    ground: 'none',
    inlet_profile: 'uniform',
    resolution: 'normale',
    reference_kind: 'chord',
    reference_mode: 'fixed',
    max_blockage: 0.05,
    re_sim_scale: 1,
    ...over,
  })

  it('without a last case, the settings decide', () => {
    const s = { ...DEFAULT_SETTINGS, fluido_predefinito: 'acqua' as const, temperatura_predefinita_c: 15, risoluzione: 'fine' as const }
    expect(rememberedCase(s)).toMatchObject({ fluid: 'acqua', temperature_c: 15, resolution: 'fine', reference_mode: 'fixed' })
  })

  it('the last case wins while the defaults stay the same', () => {
    remember(state({ fluid: 'acqua', temperature_c: 30, speed: 2, resolution: 'bozza' }), DEFAULT_SETTINGS)
    expect(rememberedCase(DEFAULT_SETTINGS)).toMatchObject({ fluid: 'acqua', temperature_c: 30, speed: 2, resolution: 'bozza' })
  })

  it('a default changed since then wins over the last case', () => {
    remember(state({ fluid: 'acqua', temperature_c: 30, resolution: 'bozza' }), DEFAULT_SETTINGS)
    const changed = { ...DEFAULT_SETTINGS, risoluzione: 'fine' as const }
    expect(rememberedCase(changed)).toMatchObject({ fluid: 'acqua', temperature_c: 30, resolution: 'fine' })
    const air = { ...DEFAULT_SETTINGS, temperatura_predefinita_c: 25 }
    // Fluid and temperature go together.
    expect(rememberedCase(air)).toMatchObject({ fluid: 'aria', temperature_c: 25, resolution: 'bozza' })
  })

  it('a last case saved before the settings existed stands as it is', () => {
    store.set('tunnel-case', JSON.stringify({ resolution: 'bozza', speed: 15 }))
    expect(rememberedCase({ ...DEFAULT_SETTINGS, risoluzione: 'fine' })).toMatchObject({ resolution: 'bozza', speed: 15, fluid: 'aria' })
  })

  it('the depth reference follows the settings', () => {
    expect(rememberedCase({ ...DEFAULT_SETTINGS, riferimento_in_profondita: 'sezione' }).reference_mode).toBe('section')
  })
})
