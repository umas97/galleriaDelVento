// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A finished case on its way to the server (SPEC §11.1, §11.2): the numbers
// and history from the engine, the mean fields as the GPU summed them, and
// the instantaneous pictures -- speed, Cp, vorticity and the smoke if it is
// on -- at the grid's resolution with legend and conditions underneath.
// Everything travels in one body, a container of named parts that the backend
// reads in memory (routes_studies.py):
//
//   "GDV1" · ( u32 name length · name · u64 data length · data )*
import type { CasePlan, CaseSetup, Coefficients, PointUpload, ResultStatus, StudyMeta, ViewName } from '../lib/types'
import { colorAt, type ColorMap } from '../sim2d/colormaps'
import type { EngineResult, TunnelEngine, ViewKind } from '../sim2d/engine'
import type { FieldMode } from '../sim2d/views'
import { num } from '../lib/format'
import { t } from '../i18n/it'
import { digitsFor } from './parts'

export type Part = { name: string; data: Blob | ArrayBuffer | Uint8Array | string }

/** The upload container of routes_studies.py. */
export function packParts(parts: Part[]): Blob {
  const encoder = new TextEncoder()
  const chunks: BlobPart[] = [encoder.encode('GDV1')]
  for (const part of parts) {
    const name = encoder.encode(part.name)
    const data = typeof part.data === 'string' ? encoder.encode(part.data) : part.data
    const size = data instanceof Blob ? data.size : data.byteLength
    const head = new DataView(new ArrayBuffer(4 + name.length + 8))
    head.setUint32(0, name.length, true)
    new Uint8Array(head.buffer).set(name, 4)
    head.setBigUint64(4 + name.length, BigInt(size), true)
    chunks.push(head.buffer, data as BlobPart)
  }
  return new Blob(chunks, { type: 'application/octet-stream' })
}

/** The colour bar of a view, in real units (as the tunnel's legend). */
export function legendOf(mode: FieldMode, range: [number, number], plan: CasePlan): { title: string; range: [number, number] } {
  if (mode === 'speed') return { title: t('tunnel.legend.speed'), range: [(range[0] * plan.speed) / plan.u_lat, (range[1] * plan.speed) / plan.u_lat] }
  if (mode === 'vorticity') return { title: t('tunnel.legend.vorticity'), range: [range[0] / plan.dt, range[1] / plan.dt] }
  return { title: t('tunnel.legend.pressure'), range }
}

/** Lines broken at spaces so that none is wider than `width` pixels. */
function wrap(ctx: CanvasRenderingContext2D, lines: string[], width: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    let current = ''
    for (const word of line.split(' ')) {
      const next = current ? `${current} ${word}` : word
      if (current && ctx.measureText(next).width > width) {
        out.push(current)
        current = word
      } else current = next
    }
    out.push(current)
  }
  return out
}

/** A view with its legend (if it has one) and the conditions in a band underneath (SPEC §2.3). */
export function composeView(image: HTMLCanvasElement, map: ColorMap, legend: { title: string; range: [number, number] } | null, conditions: string[]): HTMLCanvasElement {
  const size = Math.max(12, Math.round(image.width / 70))
  const pad = Math.round(size * 0.8)
  const lineHeight = Math.round(size * 1.45)
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = `${size}px sans-serif`
  const lines = wrap(measure, conditions, image.width - 2 * pad)
  const out = document.createElement('canvas')
  out.width = image.width
  out.height = image.height + pad * 3 + size + lineHeight * (lines.length + 1)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(image, 0, 0)
  let y = image.height + pad
  ctx.fillStyle = '#d4d4d4'
  ctx.font = `${size}px sans-serif`
  ctx.textBaseline = 'top'
  if (legend) {
    const barWidth = Math.min(out.width - 2 * pad, size * 20)
    for (let x = 0; x < barWidth; x++) {
      ctx.fillStyle = colorAt(map, x / Math.max(1, barWidth - 1))
      ctx.fillRect(pad + x, y, 1, size)
    }
    ctx.fillStyle = '#d4d4d4'
    const digits = digitsFor(legend.range)
    ctx.fillText(`${legend.title}: ${num(legend.range[0], digits)} … ${num(legend.range[1], digits)}`, pad * 2 + barWidth, y)
  }
  y += size + pad
  for (const line of lines) {
    ctx.fillText(line, pad, y)
    y += lineHeight
  }
  return out
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

/** A 320 × 200 thumbnail of a view, the body region in the middle. */
export async function thumbnailOf(image: HTMLCanvasElement): Promise<Blob | null> {
  const out = document.createElement('canvas')
  out.width = 320
  out.height = 200
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, 320, 200)
  const scale = Math.max(320 / image.width, 200 / image.height)
  const w = image.width * scale
  const h = image.height * scale
  // The body sits in the upstream third of the chamber: favour that part.
  const x = Math.min(0, Math.max(320 - w, 160 - w * 0.3))
  ctx.drawImage(image, x, (200 - h) / 2, w, h)
  return toBlob(out)
}

const VIEWS: { kind: ViewKind; name: ViewName }[] = [
  { kind: 'speed', name: 'velocita' },
  { kind: 'pressure', name: 'cp' },
  { kind: 'vorticity', name: 'vorticita' },
  { kind: 'smoke', name: 'fumo' },
]

export type PointContext = {
  setup: CaseSetup
  plan: CasePlan
  value: number | null
  elapsedSeconds: number
  /** The conditions under the pictures. */
  lines: string[]
  smoke: boolean
  sequential: ColorMap
  diverging: ColorMap
  /** The mini-scene of a model's section, with the plane (for the report). */
  scene: Blob | null
}

const finite = (v: number) => Number.isFinite(v)
const stat = (s: { mean: number; std: number } | null) => (s && finite(s.mean) && finite(s.std) ? { mean: s.mean, std: s.std } : null)

export function statusOf(result: EngineResult): ResultStatus {
  if (result.unstable) return 'unstable'
  return result.stats.status === 'converged' ? 'converged' : 'provisional'
}

/** The JSON of a point: never a NaN (the backend refuses them, SPEC §9.5). */
export function pointUpload(result: EngineResult, ctx: PointContext): PointUpload {
  const s = result.stats
  const unstable = result.unstable
  const coefficients: Coefficients = {
    cd: unstable ? null : stat(s.cd),
    cl: unstable ? null : stat(s.cl),
    cm: unstable ? null : stat(s.cm),
    clcd: !unstable && s.clcd !== null && finite(s.clcd) ? s.clcd : null,
    strouhal: !unstable && s.strouhal !== null && finite(s.strouhal) ? s.strouhal : null,
    regime: s.regime,
    change: s.change !== null && finite(s.change) ? s.change : null,
    averaged_steps: Math.round(s.averagedSteps),
    rho_inf: finite(result.rhoInf) ? result.rhoInf : 1,
  }
  const history = result.history.filter((h) => finite(h.cd) && finite(h.cl) && finite(h.cm))
  const cp = result.cp.filter((c) => finite(c.cp))
  return {
    value: ctx.value,
    case: ctx.setup,
    plan: ctx.plan,
    status: statusOf(result),
    coefficients,
    history: { every: 8, step: history.map((h) => h.step), cd: history.map((h) => h.cd), cl: history.map((h) => h.cl), cm: history.map((h) => h.cm) },
    contour: {
      chord: ctx.plan.reference_kind === 'chord',
      xc: cp.map((c) => c.xc),
      s: cp.map((c) => c.s),
      upper: cp.map((c) => c.upper),
      cp: cp.map((c) => c.cp),
      x: cp.map((c) => c.x),
      y: cp.map((c) => c.y),
    },
    mean: result.mean && !unstable ? { samples: result.mean.samples, rho_inf: result.mean.rhoInf } : null,
    steps: result.step,
    elapsed_s: ctx.elapsedSeconds,
  }
}

/** The GPU's sums followed by the mask: the `fields` part (studies/fields.py). */
function fieldsPart(result: EngineResult): Blob | null {
  if (!result.mean || result.unstable) return null
  return new Blob([result.mean.sums.buffer as ArrayBuffer, result.mask.buffer as ArrayBuffer])
}

/**
 * Everything of the current case as parts: the point, its fields, its
 * pictures; and a thumbnail of the speed view. Null if the engine has no case.
 */
export async function collectPoint(engine: TunnelEngine, ctx: PointContext): Promise<{ parts: Part[]; thumbnail: Blob | null; status: ResultStatus } | null> {
  const result = await engine.result()
  if (!result) return null
  const upload = pointUpload(result, ctx)
  const parts: Part[] = [{ name: 'point', data: JSON.stringify(upload) }]
  const fields = fieldsPart(result)
  if (fields) parts.push({ name: 'fields', data: fields })
  let thumbnail: Blob | null = null
  for (const { kind, name } of VIEWS) {
    if (kind === 'smoke' && !ctx.smoke) continue
    const view = await engine.renderView(kind)
    if (!view) continue
    const map = view.mode === 'speed' ? ctx.sequential : ctx.diverging
    const composed = composeView(view.canvas, map, legendOf(view.mode, view.range, ctx.plan), ctx.lines)
    const png = await toBlob(composed)
    if (png) parts.push({ name, data: png })
    if (kind === 'speed') thumbnail = await thumbnailOf(view.canvas)
  }
  if (ctx.scene) parts.push({ name: 'modello', data: ctx.scene })
  return { parts, thumbnail, status: upload.status }
}

export function metaPart(meta: StudyMeta): Part {
  return { name: 'study', data: JSON.stringify(meta) }
}
