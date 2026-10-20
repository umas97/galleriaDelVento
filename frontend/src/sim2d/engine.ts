// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The tunnel's engine: one WebGL2 context on the page's canvas, the solver,
// the views, and the frame loop. React only tells it what changed (a plan, a
// body, a placement, view options) and reads back a summary a few times a
// second (`onUpdate`); everything per frame happens here.
//
// Per frame: as many steps as fit (SPEC §10.1: about 12 ms of GPU, adjusted on
// the frame time), in blocks of 8 with a measurement after each (forces,
// density range, NaNs, probes, contour; read back asynchronously); the mask
// rebuilt at most once, from the latest body and placement (SPEC §10.3); then
// the view and, on the 2D canvas above, the outline, probes and streamlines.
import type { CasePlan } from '../lib/types'
import type { Pt } from '../profile/geometry'
import { colorAt, isDiverging, type ColorMap } from './colormaps'
import { boundaryCells, contourPoints, mainLoop, type ContourPoint } from './contour'
import { createContext } from './gl'
import { outerLoops, place, rasterize, type OuterRule, type Placement } from './mask'
import { CoefficientSeries, type CoefSample, type SeriesStats } from './series'
import { Solver, latticeParams, type LatticeParams, type Sample } from './solver'
import { defaultSeeds, type Field } from './streamlines'
import { FlowView, hex3, type FieldMode, type Transform } from './views'
import { MAX_ZOOM, clampCentre, viewTransform } from './viewport'

export { MAX_ZOOM, clampCentre, viewTransform }

export const MAX_PROBES = 6
/** Instability (SPEC §9.5): a NaN, or a fluid density outside this range. */
export const RHO_RANGE: [number, number] = [0.7, 1.3]
const MEASURE_EVERY = 8
const FIELD_EVERY_MS = 500

export type ViewState = {
  field: FieldMode
  smoke: boolean
  particles: boolean
  streamlines: boolean
  sequential: ColorMap
  diverging: ColorMap
  /** A fixed colour-scale range, or null for the automatic one. */
  locked: [number, number] | null
}

export type Probe = { x: number; y: number }

export type ProbeReading = { x: number; y: number; speed: number; cp: number; history: { step: number; speed: number; cp: number }[] }

/** A point of the mean Cp along the contour; x, y: where it sits in the chamber, cells. */
export type CpPoint = { xc: number; s: number; upper: boolean; cp: number; x: number; y: number }

export type EngineSnapshot = {
  step: number
  running: boolean
  stepsPerSecond: number
  fps: number
  stepsPerFrame: number
  stats: SeriesStats
  rhoInf: number
  unstable: boolean
  ramping: boolean
  /** The automatic (or locked) colour range, in display units of the field. */
  range: [number, number]
  probes: ProbeReading[]
  cp: CpPoint[]
  chart: CoefSample[]
  maskMs: number
  /** Parts of the body outside the chamber (clipped). */
  clipped: boolean
  empty: boolean
}

export type Body = { loops: Pt[][]; rule: OuterRule }

/** A picture of a view for a study (SPEC §11.2). */
export type ViewKind = 'speed' | 'pressure' | 'vorticity' | 'smoke'

/** Everything a saved result needs from the GPU side (SPEC §11.1). */
export type EngineResult = {
  step: number
  unstable: boolean
  stats: SeriesStats
  rhoInf: number
  history: CoefSample[]
  cp: CpPoint[]
  /** Sums of (δρ, ux, uy, samples) per cell, or null before averaging starts. */
  mean: { sums: Float32Array; samples: number; rhoInf: number } | null
  mask: Uint8Array
  nx: number
  ny: number
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}

export class TunnelEngine {
  readonly gl: WebGL2RenderingContext
  plan: CasePlan | null = null
  private params: LatticeParams | null = null
  private solver: Solver | null = null
  private view: FlowView | null = null
  private series: CoefficientSeries | null = null
  private outer: Pt[][] = []
  private position: Pt = [0, 0]
  private angle = 0
  private maskDirty = false
  private probes: Probe[] = []
  private probeHistory: { step: number; speed: number; cp: number }[][] = []
  private contour: ContourPoint[] = []
  private cpSum = new Float64Array(0)
  private cpCount = 0
  private cpFrom = 0
  private lines: Float32Array[] = []
  private lastField = 0
  private worker: Worker | null = null
  private workerBusy = false
  private frameHandle = 0
  private lastFrame = 0
  private frameTimes: number[] = []
  private stepTimes: { t: number; step: number }[] = []
  private spf = MEASURE_EVERY
  /** A fence after each frame's GPU work: still pending a frame later = the GPU is behind. */
  private frameFence: WebGLSync | null = null
  private calm = 0
  private fixedSpf: number | null = null
  /** The view: 1 = the whole chamber; centre in cells (null = the chamber's). */
  private zoom = 1
  /** Around the chamber: the page's background, so the theme carries through (SPEC §12.3). */
  private outside: [number, number, number] = hex3('#111111')
  private centre: Pt | null = null
  private running = false
  private pendingSingle = 0
  private rhoInf = 1
  private unstable = false
  private range: [number, number] = [0, 0.1]
  private probeValues: { speed: number; cp: number }[] = []
  private maskMs = 0
  private clipped = false
  private lastPublish = 0
  private rakeSeeds: [number, number][] | null = null
  private disposed = false
  /** The body's mask as last rasterised. */
  private mask: Uint8Array = new Uint8Array(0)
  /** The latest downsampled field (a copy: the streamline worker takes the original). */
  private lastFieldData: Field | null = null
  /** Sum of ρ∞ over the samples in the GPU's time averages. */
  private meanRho = 0
  /** When the current flow started from rest. */
  private startedAt = performance.now()
  options: ViewState = {
    field: 'speed',
    smoke: false,
    particles: false,
    streamlines: false,
    sequential: 'viridis',
    diverging: 'coolwarm',
    locked: null,
  }

  onUpdate: (snapshot: EngineSnapshot) => void = () => undefined
  onUnstable: () => void = () => undefined
  /** Called after each frame (recording draws the composed frame here). */
  onFrame: (() => void) | null = null

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly overlay: HTMLCanvasElement,
  ) {
    this.gl = createContext(canvas, true)
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  // --- what React tells the engine -------------------------------------------------

  /**
   * A new plan. Same grid and lattice parameters (a new reference length):
   * the flow goes on and only the averages restart. Otherwise a new flow.
   */
  setPlan(plan: CasePlan): void {
    const params = latticeParams(plan)
    const same = this.params && JSON.stringify(this.params) === JSON.stringify(params) && this.solver
    this.plan = plan
    // The pivot may move with a plan that keeps the grid (a rotation released).
    this.maskDirty = true
    const seriesOptions = { tcSteps: plan.tc_steps, transientSteps: plan.transient_steps, lLat: plan.l_lat, uLat: plan.u_lat }
    if (same && this.solver && this.series) {
      this.series.setOptions(seriesOptions, this.solver.step)
      this.restartCp()
      return
    }
    this.solver?.dispose()
    this.view?.dispose()
    if (this.params && (this.params.nx !== params.nx || this.params.ny !== params.ny)) this.resetView()
    this.params = params
    this.solver = new Solver(this.gl, params)
    this.startedAt = performance.now()
    this.view = new FlowView(this.gl, params.nx, params.ny)
    this.view.setColorMap(this.mapFor(this.options.field))
    this.view.outside = this.outside
    this.series = new CoefficientSeries(seriesOptions)
    this.unstable = false
    this.rhoInf = 1
    this.rakeSeeds = null
    this.lines = []
    this.probeHistory = this.probes.map(() => [])
    this.maskDirty = true
  }

  /** The body in profile coordinates (a saved profile, or the live section). */
  setBody(body: Body, resetAverages = true): void {
    this.outer = outerLoops(body.loops, body.rule)
    this.maskDirty = true
    if (resetAverages) this.changed()
  }

  setPlacement(position: Pt, angleDeg: number): void {
    if (position[0] === this.position[0] && position[1] === this.position[1] && angleDeg === this.angle) return
    this.position = position
    this.angle = angleDeg
    this.maskDirty = true
    this.changed()
  }

  get placement(): Placement {
    return { pivot: this.plan?.pivot ?? [0, 0], position: this.position, angleDeg: this.angle }
  }

  setOptions(options: Partial<ViewState>): void {
    const before = this.options
    this.options = { ...before, ...options }
    if (this.view && (options.field || options.sequential || options.diverging)) this.view.setColorMap(this.mapFor(this.options.field))
    if (options.field && options.field !== before.field) this.lastField = 0
    if (options.smoke === false || options.particles === false) this.view?.clear()
  }

  setProbes(probes: Probe[]): void {
    const old = this.probes
    this.probes = probes.slice(0, MAX_PROBES)
    this.probeHistory = this.probes.map((p, i) => (old[i] && old[i].x === p.x && old[i].y === p.y ? (this.probeHistory[i] ?? []) : []))
    this.updateCells()
  }

  setRake(seeds: [number, number][] | null): void {
    this.rakeSeeds = seeds
    this.lastField = 0
  }

  /** Steps per frame: a number from the settings, or null for automatic. */
  setStepsPerFrame(value: number | null): void {
    this.fixedSpf = value
  }

  play(): void {
    this.running = true
  }

  pause(): void {
    this.running = false
  }

  /** "." : one block of steps, then stop. */
  stepOnce(): void {
    this.running = false
    this.pendingSingle += MEASURE_EVERY
  }

  /** R: the flow from rest, same plan. */
  restart(): void {
    this.startedAt = performance.now()
    this.solver?.restart()
    this.view?.clear()
    this.series?.clear()
    this.unstable = false
    this.rhoInf = 1
    this.probeHistory = this.probes.map(() => [])
    this.restartCp()
    this.maskDirty = true
  }

  get isRunning(): boolean {
    return this.running
  }

  get step(): number {
    return this.solver?.step ?? 0
  }

  /** Seconds since the current flow started from rest. */
  get runSeconds(): number {
    return (performance.now() - this.startedAt) / 1000
  }

  /** Canvas pixel (CSS, from the top-left) → chamber cells. */
  toCells(clientX: number, clientY: number): Pt {
    const rect = this.overlay.getBoundingClientRect()
    const t = this.transform()
    const dpr = this.canvas.width / Math.max(1, rect.width)
    const px = (clientX - rect.left) * dpr
    const py = this.canvas.height - (clientY - rect.top) * dpr
    return [(px - t.originX) * t.cellsPerPixel, (py - t.originY) * t.cellsPerPixel]
  }

  /** How many times the view is enlarged (1 = the whole chamber). */
  get zoomLevel(): number {
    return this.zoom
  }

  /** Zoom by `factor` keeping the cell under the pointer where it is. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!this.params) return
    const before = this.toCells(clientX, clientY)
    const next = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor))
    if (next === this.zoom) return
    const centre = this.viewCentre(this.transform())
    // The pointer's cell stays put: C' = P + (C − P) · old / new.
    const k = this.zoom / next
    this.zoom = next
    this.centre = next === 1 ? null : [before[0] + (centre[0] - before[0]) * k, before[1] + (centre[1] - before[1]) * k]
  }

  /** Zoom about the middle of the view (the + and − keys). */
  zoomBy(factor: number): void {
    const rect = this.overlay.getBoundingClientRect()
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  /** Move the view by a drag of (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number): void {
    if (!this.params || this.zoom === 1) return
    const rect = this.overlay.getBoundingClientRect()
    const t = this.transform()
    const dpr = this.canvas.width / Math.max(1, rect.width)
    const [cx, cy] = this.viewCentre(t)
    const scale = 1 / t.cellsPerPixel
    this.centre = clampCentre(this.canvas.width, this.canvas.height, this.params.nx, this.params.ny, scale, [
      cx - (dx * dpr) / scale,
      cy + (dy * dpr) / scale,
    ])
  }

  /** The colour around the chamber, as `#rrggbb`. */
  setBackground(hex: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return
    this.outside = hex3(hex)
    if (this.view) this.view.outside = this.outside
  }

  /** Chamber cells per CSS pixel of the canvas, at the current zoom. */
  cellsPerCssPixel(): number {
    const rect = this.overlay.getBoundingClientRect()
    return this.transform().cellsPerPixel * (this.canvas.width / Math.max(1, rect.width))
  }

  /** Back to the whole chamber. */
  resetView(): void {
    this.zoom = 1
    this.centre = null
  }

  /** The cell at the middle of the canvas. */
  private viewCentre(t: Transform): Pt {
    return [(this.canvas.width / 2 - t.originX) * t.cellsPerPixel, (this.canvas.height / 2 - t.originY) * t.cellsPerPixel]
  }

  /** Whether a chamber point (cells) is on the body. */
  hitsBody(cell: Pt): boolean {
    if (!this.plan) return false
    const dx = this.plan.dx
    const placed = place(this.outer, this.placement)
    const x = cell[0] * dx
    const y = cell[1] * dx
    return placed.some((loop) => {
      let inside = false
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, yi] = loop[i]
        const [xj, yj] = loop[j]
        if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside
      }
      return inside
    })
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.worker?.terminate()
    this.solver?.dispose()
    this.view?.dispose()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  // --- internals ------------------------------------------------------------------

  private mapFor(field: FieldMode): ColorMap {
    return field === 'speed' ? this.options.sequential : this.options.diverging
  }

  /** Section, incidence or position changed: averages restart (SPEC §9.5). */
  private changed(): void {
    if (this.solver && this.series) this.series.resetAverages(this.solver.step)
    this.restartCp()
  }

  private restartCp(): void {
    this.solver?.resetMean()
    this.meanRho = 0
    this.cpSum = new Float64Array(this.contour.length)
    this.cpCount = 0
    this.cpFrom = this.solver ? this.solver.step + (this.plan?.tc_steps ?? 0) : 0
  }

  private transform(): Transform {
    return viewTransform(this.canvas.width, this.canvas.height, this.params?.nx ?? 1, this.params?.ny ?? 1, this.zoom, this.centre)
  }

  private updateMask(): void {
    if (!this.solver || !this.plan) return
    const start = performance.now()
    const { nx, ny } = this.params!
    const placed = place(this.outer, this.placement)
    const mask = rasterize(placed, nx, ny, this.plan.dx)
    this.solver.setMask(mask)
    this.mask = mask
    const w = nx * this.plan.dx
    const h = ny * this.plan.dx
    this.clipped = placed.some((l) => l.some(([x, y]) => x < 0 || y < 0 || x > w || y > h))
    const main = mainLoop(this.outer)
    this.contour = main ? contourPoints(boundaryCells(mask, nx, ny), main, this.placement, this.plan.dx) : []
    this.restartCp()
    this.updateCells()
    this.maskMs = performance.now() - start
    this.maskDirty = false
  }

  private updateCells(): void {
    if (!this.solver || !this.params) return
    const cells = new Int32Array(2 * (MAX_PROBES + this.contour.length))
    this.probes.forEach((p, k) => {
      cells[2 * k] = Math.min(this.params!.nx - 1, Math.max(0, Math.floor(p.x)))
      cells[2 * k + 1] = Math.min(this.params!.ny - 1, Math.max(0, Math.floor(p.y)))
    })
    this.contour.forEach((c, k) => {
      cells[2 * (MAX_PROBES + k)] = c.i
      cells[2 * (MAX_PROBES + k) + 1] = c.j
    })
    this.solver.setCells(cells)
    this.cpSum = new Float64Array(this.contour.length)
    this.cpCount = 0
  }

  private momentPoint(): Pt {
    const plan = this.plan!
    const [x, y] = place([[plan.moment_point]], this.placement)[0][0]
    return [x / plan.dx, y / plan.dx]
  }

  private absorb(samples: Sample[]): void {
    const plan = this.plan
    if (!plan || !this.series) return
    for (const s of samples) {
      if (this.unstable) return
      if (s.nan > 0 || s.rhoMin < RHO_RANGE[0] || s.rhoMax > RHO_RANGE[1]) {
        this.unstable = true
        this.running = false
        this.onUnstable()
        return
      }
      this.rhoInf = s.rhoInf
      // Normalised with the measured undisturbed density (decision of 2026-10-15).
      const q = 0.5 * s.rhoInf * plan.u_lat * plan.u_lat
      const l = plan.l_lat
      this.series.add({ step: s.step, cd: s.fx / (q * l), cl: s.fy / (q * l), cm: -s.mz / (q * l * l) })
      const cells = s.cells
      this.probeValues = this.probes.map((_, k) => {
        const drho = cells[4 * k]
        const ux = cells[4 * k + 1]
        const uy = cells[4 * k + 2]
        return { speed: (Math.hypot(ux, uy) * plan.speed) / plan.u_lat, cp: (1 + drho - s.rhoInf) / 3 / q }
      })
      this.probeValues.forEach((v, k) => {
        const h = this.probeHistory[k] ?? (this.probeHistory[k] = [])
        h.push({ step: s.step, ...v })
        if (h.length > 2500) h.splice(0, h.length - 2500)
      })
      if (s.step >= this.cpFrom && cells.length >= 4 * (MAX_PROBES + this.contour.length) && this.cpSum.length === this.contour.length) {
        for (let k = 0; k < this.contour.length; k++) {
          const drho = cells[4 * (MAX_PROBES + k)]
          this.cpSum[k] += (1 + drho - s.rhoInf) / 3 / q
        }
        this.cpCount++
      }
    }
  }

  private autoRange(field: Field): void {
    const range = this.rangeOf(field, this.options.field)
    if (range) this.range = range
  }

  /** The automatic colour range of a field mode on a downsampled field. */
  private rangeOf(field: Field, mode: FieldMode): [number, number] | null {
    const plan = this.plan
    if (!plan) return null
    const values: number[] = []
    const q = 0.5 * this.rhoInf * plan.u_lat * plan.u_lat
    const { w, h, data } = field
    for (let j = 1; j < h - 1; j += 1)
      for (let i = 1; i < w - 1; i += 1) {
        const k = 4 * (j * w + i)
        if (data[k + 3] > 0) continue
        if (mode === 'speed') values.push(Math.hypot(data[k + 1], data[k + 2]))
        else if (mode === 'pressure') values.push((1 + data[k] - this.rhoInf) / 3 / q)
        else {
          const dvdx = (data[k + 4 + 2] - data[k - 4 + 2]) / (2 * field.factor)
          const dudy = (data[k + 4 * w + 1] - data[k - 4 * w + 1]) / (2 * field.factor)
          values.push(dvdx - dudy)
        }
      }
    if (!values.length) return null
    let lo = percentile(values, 0.02)
    let hi = percentile(values, 0.98)
    if (mode !== 'speed' || isDiverging(this.mapFor(mode))) {
      const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-9)
      lo = -m
      hi = m
    } else {
      lo = 0
      hi = Math.max(hi, plan.u_lat * 0.1)
    }
    return [lo, hi]
  }

  /** The colour range a view of `mode` uses now: the locked one for the field shown, else automatic. */
  rangeFor(mode: FieldMode): [number, number] {
    if (mode === this.options.field) return this.options.locked ?? this.range
    return (this.lastFieldData && this.rangeOf(this.lastFieldData, mode)) ?? this.range
  }

  private requestStreamlines(field: Field): void {
    if (!this.options.streamlines || this.workerBusy || !this.params) return
    if (!this.worker) {
      this.worker = new Worker(new URL('./streamlines.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<{ lines: Float32Array[] }>) => {
        this.workerBusy = false
        this.lines = event.data.lines
      }
    }
    this.workerBusy = true
    const seeds = this.rakeSeeds ?? defaultSeeds(this.params.nx, this.params.ny)
    this.worker.postMessage({ id: 0, field, seeds }, [field.data.buffer])
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.overlay.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w
      this.overlay.height = h
    }
  }

  private frame = (now: number): void => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.frame)
    if (this.gl.isContextLost()) return
    this.resize()
    const interval = this.lastFrame ? now - this.lastFrame : 16.7
    this.lastFrame = now
    this.frameTimes.push(now)
    while (this.frameTimes.length && this.frameTimes[0] < now - 1000) this.frameTimes.shift()
    const solver = this.solver
    const view = this.view
    if (!solver || !view || !this.plan) {
      this.clearCanvas()
      return
    }
    if (this.maskDirty) this.updateMask()

    let steps = 0
    if (this.running && !this.unstable) {
      if (this.fixedSpf !== null) this.spf = this.fixedSpf
      else this.adapt(interval)
      steps = this.spf
    } else if (this.pendingSingle > 0 && !this.unstable) {
      steps = this.pendingSingle
      this.pendingSingle = 0
    }
    const ref = this.momentPoint()
    const averaging = this.series?.averagingFrom ?? Infinity
    for (let done = 0; done < steps; done += MEASURE_EVERY) {
      solver.run(MEASURE_EVERY)
      solver.measure(ref)
      // Time averages of the fields, over the same window as the coefficients.
      if (solver.step >= averaging && !this.unstable) {
        solver.accumulate()
        this.meanRho += this.rhoInf
      }
    }
    if (steps) {
      view.advance(solver, steps, this.options.smoke, this.options.particles)
      this.stepTimes.push({ t: now, step: solver.step })
    }
    while (this.stepTimes.length > 1 && this.stepTimes[0].t < now - 1000) this.stepTimes.shift()
    this.absorb(solver.collect())

    if (now - this.lastField > FIELD_EVERY_MS) {
      const factor = Math.max(1, Math.round(Math.max(this.params!.nx / 512, this.params!.ny / 192)))
      if (solver.requestField(factor)) this.lastField = now
    }
    for (const f of solver.collectFields()) {
      const field: Field = { w: f.w, h: f.h, factor: f.factor, data: f.data }
      this.lastFieldData = { ...field, data: f.data.slice() }
      if (!this.options.locked) this.autoRange(field)
      this.requestStreamlines(field)
    }

    const range = this.options.locked ?? this.range
    const t = this.transform()
    view.render(
      solver,
      {
        field: this.options.field,
        smoke: this.options.smoke,
        particles: this.options.particles,
        range,
        rhoInf: this.rhoInf,
        uLat: this.plan.u_lat,
      },
      t,
      null,
      this.canvas.width,
      this.canvas.height,
    )
    this.drawOverlay(t)
    const gl = this.gl
    if (this.frameFence) gl.deleteSync(this.frameFence)
    this.frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    this.onFrame?.()
    if (now - this.lastPublish > 200) {
      this.lastPublish = now
      this.onUpdate(this.snapshot())
    }
  }

  /**
   * Steps per frame (SPEC §10.1: as many as fit in about 12 ms of GPU). The
   * frame's fence tells whether the GPU finished the last frame within one
   * frame time: if not, fewer steps at once; after a few calm frames, a few
   * more. A long frame interval (the GPU queue has grown) cuts harder.
   */
  private adapt(interval: number): void {
    const gl = this.gl
    const behind = this.frameFence !== null && gl.clientWaitSync(this.frameFence, 0, 0) === gl.TIMEOUT_EXPIRED
    if (behind || interval > 25) {
      this.spf = Math.max(MEASURE_EVERY, Math.floor((this.spf * (interval > 40 ? 0.6 : 0.85)) / MEASURE_EVERY) * MEASURE_EVERY)
      this.calm = 0
    } else if (++this.calm >= 4) {
      this.spf = Math.min(400, this.spf + MEASURE_EVERY)
      this.calm = 0
    }
  }

  private clearCanvas(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(...this.outside, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.overlay.getContext('2d')?.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }

  /** Mean Cp along the contour since averaging started. */
  private cpCurve(): CpPoint[] {
    if (!this.cpCount) return []
    return this.contour.map((c, k) => ({ xc: c.xc, s: c.s, upper: c.upper, cp: this.cpSum[k] / this.cpCount, x: c.x, y: c.y }))
  }

  /** What a study saves of the current case (SPEC §11.1, §11.2). */
  async result(): Promise<EngineResult | null> {
    const solver = this.solver
    if (!solver || !this.params || !this.series) return null
    const samples = solver.meanSamples
    const rhoInf = samples ? this.meanRho / samples : this.rhoInf
    const sums = samples && !this.unstable ? await solver.readMean() : null
    if (this.disposed || solver !== this.solver) return null
    return {
      step: solver.step,
      unstable: this.unstable,
      stats: this.snapshot().stats,
      rhoInf: this.rhoInf,
      history: this.series.all(),
      cp: this.cpCurve(),
      mean: sums ? { sums, samples, rhoInf } : null,
      mask: this.mask.slice(),
      nx: this.params.nx,
      ny: this.params.ny,
    }
  }

  /**
   * One view at the grid's resolution, with the outline, for a study (SPEC
   * §11.2): speed, Cp, vorticity, or the smoke over the field shown. The
   * colour range is the one that view would get now.
   */
  async renderView(kind: ViewKind): Promise<{ canvas: HTMLCanvasElement; range: [number, number]; mode: FieldMode } | null> {
    const view = this.view
    const params = this.params
    if (!view || !params) return null
    const mode: FieldMode = kind === 'smoke' ? this.options.field : kind
    const range = this.rangeFor(mode)
    const shown = this.options.field
    if (mode !== shown) view.setColorMap(this.mapFor(mode))
    const canvas = await this.renderImage({ field: mode, smoke: kind === 'smoke', particles: false, range }, params.nx, params.ny, {
      originX: 0,
      originY: 0,
      cellsPerPixel: 1,
    })
    if (mode !== shown) this.view?.setColorMap(this.mapFor(shown))
    return canvas ? { canvas, range, mode } : null
  }

  snapshot(): EngineSnapshot {
    const first = this.stepTimes[0]
    const last = this.stepTimes[this.stepTimes.length - 1]
    const sps = first && last && last.t > first.t ? ((last.step - first.step) * 1000) / (last.t - first.t) : 0
    const stats = this.series?.stats() ?? {
      status: 'transient',
      regime: null,
      cd: null,
      cl: null,
      cm: null,
      clcd: null,
      strouhal: null,
      change: null,
      averagedSteps: 0,
    }
    return {
      step: this.step,
      running: this.running,
      stepsPerSecond: this.running ? sps : 0,
      fps: this.frameTimes.length,
      stepsPerFrame: this.spf,
      stats,
      rhoInf: this.rhoInf,
      unstable: this.unstable,
      ramping: this.plan ? this.step < this.plan.ramp_steps : false,
      range: this.options.locked ?? this.range,
      probes: this.probes.map((p, k) => ({
        ...p,
        speed: this.probeValues[k]?.speed ?? 0,
        cp: this.probeValues[k]?.cp ?? 0,
        history: (this.probeHistory[k] ?? []).slice(),
      })),
      cp: this.cpCurve(),
      chart: this.series?.chart() ?? [],
      maskMs: this.maskMs,
      clipped: this.clipped,
      empty: this.outer.length === 0,
    }
  }

  /** The outline (coloured by Cp when there is a curve), probes, streamlines, rake. */
  drawOverlay(t: Transform, target?: CanvasRenderingContext2D, scale = 1): void {
    const ctx = target ?? this.overlay.getContext('2d')
    if (!ctx || !this.plan) return
    const w = target ? target.canvas.width : this.overlay.width
    const h = target ? target.canvas.height : this.overlay.height
    if (!target) ctx.clearRect(0, 0, w, h)
    const px = (x: number, y: number): [number, number] => [x / t.cellsPerPixel + t.originX, h - (y / t.cellsPerPixel + t.originY)]
    const dpr = (window.devicePixelRatio || 1) * scale
    const dx = this.plan.dx
    // Streamlines.
    if (this.options.streamlines && this.lines.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth = 1 * dpr
      ctx.beginPath()
      for (const line of this.lines) {
        for (let k = 0; k < line.length; k += 2) {
          const [x, y] = px(line[k], line[k + 1])
          if (k === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
      }
      ctx.stroke()
    }
    // The outline: red where it leaves the chamber, else by Cp or light.
    const placed = place(this.outer, this.placement)
    const cw = this.params!.nx
    const ch = this.params!.ny
    for (const loop of placed) {
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k]
        const b = loop[(k + 1) % loop.length]
        const ax = a[0] / dx
        const ay = a[1] / dx
        const bx = b[0] / dx
        const by = b[1] / dx
        const out = ax < 0 || ay < 0 || ax > cw || ay > ch || bx < 0 || by < 0 || bx > cw || by > ch
        ctx.strokeStyle = out ? '#e06c6c' : 'rgba(245,245,245,0.9)'
        ctx.lineWidth = (out ? 2 : 1) * dpr
        ctx.beginPath()
        ctx.moveTo(...px(ax, ay))
        ctx.lineTo(...px(bx, by))
        ctx.stroke()
      }
    }
    const curve = this.cpCurve()
    if (curve.length) {
      const values = curve.map((c) => c.cp)
      const m = Math.max(1e-6, ...values.map(Math.abs))
      const map = this.options.diverging
      this.contour.forEach((c, k) => {
        ctx.fillStyle = colorAt(map, 0.5 + 0.5 * (curve[k].cp / m))
        const [x, y] = px(c.x, c.y)
        ctx.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr)
      })
    }
    // Probes.
    this.probes.forEach((p, k) => {
      const [x, y] = px(p.x, p.y)
      ctx.strokeStyle = '#f5c26b'
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.arc(x, y, 5 * dpr, 0, 2 * Math.PI)
      ctx.stroke()
      ctx.fillStyle = '#f5c26b'
      ctx.font = `${11 * dpr}px sans-serif`
      ctx.fillText(String(k + 1), x + 7 * dpr, y - 6 * dpr)
    })
    if (this.rakeSeeds && this.options.streamlines) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      for (const [sx, sy] of this.rakeSeeds) {
        const [x, y] = px(sx, sy)
        ctx.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr)
      }
    }
  }

  /**
   * The current view at twice the canvas size, with the overlay, as a 2D
   * canvas (the snapshot, SPEC §10.7). The page adds legend and conditions.
   * Read back through a pixel-pack buffer and a fence, so the GPU is not
   * stalled for it.
   */
  async renderLarge(factor = 2): Promise<HTMLCanvasElement | null> {
    const base = this.transform()
    const t: Transform = { originX: base.originX * factor, originY: base.originY * factor, cellsPerPixel: base.cellsPerPixel / factor }
    const o = this.options
    const options = { field: o.field, smoke: o.smoke, particles: o.particles, range: o.locked ?? this.range }
    return this.renderImage(options, this.canvas.width * factor, this.canvas.height * factor, t, factor)
  }

  /** A view into a w × h 2D canvas with the overlay, read back without stalling the GPU. */
  private async renderImage(
    options: { field: FieldMode; smoke: boolean; particles: boolean; range: [number, number] },
    w: number,
    h: number,
    t: Transform,
    overlayScale = 1 / (window.devicePixelRatio || 1),
  ): Promise<HTMLCanvasElement | null> {
    const solver = this.solver
    const view = this.view
    if (!solver || !view || !this.plan) return null
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    view.render(solver, { ...options, rhoInf: this.rhoInf, uLat: this.plan.u_lat }, t, fb, w, h)
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
    gl.flush()
    while (true) {
      await new Promise((r) => setTimeout(r, 8))
      if (gl.isContextLost()) return null
      const status = gl.clientWaitSync(fence, 0, 0)
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
    }
    const pixels = new Uint8ClampedArray(w * h * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.deleteSync(fence)
    gl.deleteBuffer(buffer)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(tex)
    // GL rows run bottom-up.
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) flipped.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')!
    ctx.putImageData(new ImageData(flipped, w, h), 0, 0)
    this.drawOverlay(t, ctx, overlayScale)
    return out
  }
}
