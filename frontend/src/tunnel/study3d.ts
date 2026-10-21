// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A finished case of the 3D tunnel on its way to the server (SPEC §24.2 #7):
// the whole body's numbers -- corrected for the blockage, with the measured Cd
// next to them (SPEC §24.6) -- the history of Cd, Cl and Cs, the time-averaged
// field as the GPU summed it, and three pictures with legend and conditions:
// the view as the user left it, the longitudinal plane coloured by speed seen
// from the side, and Cp on the surface. The same container of named parts as
// a 2D point (study.ts, routes_studies.py).
import type { CasePlan3D, CaseSetup3D, Coefficients3D, PointUpload3D, ResultStatus, Stat, ViewName } from '../lib/types'
import type { ColorMap, DivergingMap, SequentialMap } from '../sim2d/colormaps'
import type { Engine3D, Engine3DResult, Ranges3D, ViewOptions3D } from '../sim3d/engine'
import type { CameraView } from '../sim3d/camera'
import { t } from '../i18n/it'
import { composeView, type Part } from './study'

export type Point3DContext = {
  setup: CaseSetup3D
  plan: CasePlan3D
  elapsedSeconds: number
  /** The conditions under the pictures. */
  lines: string[]
  /** The body's box in the chamber, metres: the fixed pictures are framed on it. */
  box: readonly number[]
  options: ViewOptions3D
  sequential: SequentialMap
  diverging: DivergingMap
}

const finite = (v: number) => Number.isFinite(v)
const stat = (s: Stat | null, factor = 1): Stat | null =>
  s && finite(s.mean) && finite(s.std) ? { mean: s.mean * factor, std: Math.abs(s.std * factor) } : null

export function status3d(result: Engine3DResult): ResultStatus {
  if (result.unstable) return 'unstable'
  return result.stats.status === 'converged' ? 'converged' : 'provisional'
}

/** The JSON of a 3D point: never a NaN (the backend refuses them, SPEC §9.5). */
export function pointUpload3d(result: Engine3DResult, ctx: Point3DContext): PointUpload3D {
  const s = result.stats
  const unstable = result.unstable
  const factor = ctx.plan.blockage_correction
  const coefficients: Coefficients3D = {
    cd: unstable ? null : stat(s.cd),
    cl: unstable ? null : stat(s.cl),
    cs: unstable ? null : stat(s.cm),
    // The history holds corrected numbers: the chamber's Cd is the same divided back.
    cd_measured: unstable || !(factor > 0) ? null : stat(s.cd, 1 / factor),
    blockage_correction: factor,
    regime: s.regime,
    change: s.change !== null && finite(s.change) ? s.change : null,
    averaged_steps: Math.round(s.averagedSteps),
    rho_inf: finite(result.rhoInf) ? result.rhoInf : 1,
  }
  const history = result.history.filter((h) => finite(h.cd) && finite(h.cl) && finite(h.cm))
  return {
    dimension: '3d',
    value: null,
    case: ctx.setup,
    plan: ctx.plan,
    status: status3d(result),
    coefficients,
    history: { every: 8, step: history.map((h) => h.step), cd: history.map((h) => h.cd), cl: history.map((h) => h.cl), cs: history.map((h) => h.cm) },
    mean: result.mean && !unstable ? { samples: result.mean.samples, rho_inf: result.mean.rhoInf } : null,
    steps: result.step,
    elapsed_s: ctx.elapsedSeconds,
  }
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

/** A 320 × 200 thumbnail from the middle of a picture. */
async function thumbnail(image: HTMLCanvasElement): Promise<Blob | null> {
  const out = document.createElement('canvas')
  out.width = 320
  out.height = 200
  const ctx = out.getContext('2d')!
  const scale = Math.max(320 / image.width, 200 / image.height)
  const w = image.width * scale
  const h = image.height * scale
  ctx.drawImage(image, (320 - w) / 2, (200 - h) / 2, w, h)
  return toBlob(out)
}

type Picture = { name: ViewName; change: Partial<ViewOptions3D> | null; look: CameraView }

/** The legend a picture carries: the plane's, else the surface's, else the tracers'. */
function legendFor(o: ViewOptions3D, ranges: Ranges3D): { map: 'sequential' | 'diverging'; title: string; range: [number, number] } | null {
  if (o.plane.shown)
    return o.plane.field === 'speed'
      ? { map: 'sequential', title: t('tunnel3d.legend.plane.speed'), range: ranges.plane }
      : { map: 'diverging', title: t('tunnel3d.legend.plane.cp'), range: ranges.plane }
  if (o.surfaceCp) return { map: 'diverging', title: t('tunnel3d.legend.surface'), range: ranges.surface }
  if (o.particles) return { map: 'sequential', title: t('tunnel3d.legend.speed'), range: ranges.speed }
  return null
}

/**
 * Everything of the current 3D case as parts: the point, its mean field, its
 * three pictures; and a thumbnail. Null if the engine has no case.
 */
export async function collectPoint3d(
  engine: Engine3D,
  ctx: Point3DContext,
): Promise<{ parts: Part[]; thumbnail: Blob | null; status: ResultStatus } | null> {
  const result = await engine.result()
  if (!result) return null
  const upload = pointUpload3d(result, ctx)
  const parts: Part[] = [{ name: 'point', data: JSON.stringify(upload) }]
  if (result.mean && !result.unstable) parts.push({ name: 'fields', data: new Blob([result.mean.sums.buffer, result.voxels.slice().buffer]) })
  const [, y0, , , y1] = ctx.box
  const pictures: Picture[] = [
    { name: 'vista', change: null, look: 'iso' },
    {
      name: 'piano',
      change: { plane: { shown: true, axis: 1, position: (y0 + y1) / 2, field: 'speed' }, surfaceCp: false, smoke: false, particles: false, voxels: false },
      look: 'side',
    },
    {
      name: 'superficie',
      change: { plane: { ...ctx.options.plane, shown: false }, surfaceCp: true, smoke: false, particles: false, voxels: false },
      look: 'iso',
    },
  ]
  let thumb: Blob | null = null
  for (const p of pictures) {
    const shot = p.change ? await engine.renderStudyView(p.change, p.look, ctx.box, 2) : await engine.renderLarge(2).then((canvas) => (canvas ? { canvas, ranges: engine.snapshot().ranges } : null))
    if (!shot) continue
    const options = p.change ? { ...ctx.options, ...p.change } : ctx.options
    const legend = legendFor(options, shot.ranges)
    const map: ColorMap = legend?.map === 'diverging' ? ctx.diverging : ctx.sequential
    const png = await toBlob(composeView(shot.canvas, map, legend, ctx.lines))
    if (png) parts.push({ name: p.name, data: png })
    if (p.name === 'piano') thumb = await thumbnail(shot.canvas)
  }
  return { parts, thumbnail: thumb, status: upload.status }
}
