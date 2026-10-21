// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's engine (SPEC §24): it runs a CasePlan3D on the WebGPU solver
// and draws it, frame by frame, from the camera the user moves. Like the 2D
// engine it owns no physics: the plan comes from the backend (SPEC §4, decision
// 4), the voxels and their walls from the geometry thread.
//
// Frames. Each one runs a number of time steps -- measuring every 8, as in 2D
// -- then turns the populations into the field texture, moves the tracers and
// draws. The measurements become the coefficients of the whole body (SPEC
// §24.2 #5): on the reference area, normalised with ρ∞, corrected for the
// blockage as the plan says (SPEC §24.6); averages, convergence and the time
// averages of the field follow the 2D rules (SPEC §9.5). The steps per frame follow the GPU: the time from one frame's
// completion to the next is held near FRAME_BUDGET_MS (≥ 30 fps, SPEC §24.4);
// at most two frames wait on the GPU, so it never idles between them and the
// page never queues more.
import type { CasePlan3D } from '../lib/types'
import { OrbitCamera, type CameraView, type Vec3 } from './camera'
import { requestGpu, type Gpu } from './gpu'
import { Solver3D, latticeParams3D, packMask, type Sample3D } from './solver'
import {
  autoRange,
  modelMatrix,
  planePoints,
  rakeNozzles,
  rotationMatrix,
  surfacePoints,
  voxelSurface,
  type BodyMesh,
  type PlaneAxis,
  type Rake,
} from './scene'
import type { WallLinks } from './voxelize'
import { CoefficientSeries, type CoefSample, type SeriesOptions, type SeriesStats } from '../sim2d/series'
import { MAX_NOZZLES, SAMPLE_COUNT, SMOKE_POINTS, Views3D, type FrameUniforms, type Target } from './views'
import type { DivergingMap, SequentialMap } from '../sim2d/colormaps'

const MEASURE_EVERY = 8
/** Steps between two samples of the field's time averages (a multiple of MEASURE_EVERY). */
const AVERAGE_EVERY = 32
const FRAME_BUDGET_MS = 27
const MAX_STEPS_PER_FRAME = 64
const RANGE_EVERY_MS = 400
/** Particle tails: this many cells at the undisturbed speed. */
const TAIL_CELLS = 2.5

/** A case ready to run: the plan, and the voxels of the body on its grid with their walls. */
export type Case3D = {
  plan: CasePlan3D
  voxels: Uint8Array
  walls: WallLinks
  /** Changes when the voxels do (rotations, grid). */
  voxelKey: string
  pivot: Vec3
}

export type PlaneOptions = { shown: boolean; axis: PlaneAxis; position: number; field: 'speed' | 'cp' }

export type ViewOptions3D = {
  plane: PlaneOptions
  surfaceCp: boolean
  /** «Mostra i voxel» (SPEC §24.8): the voxels' faces in place of the model. */
  voxels: boolean
  smoke: boolean
  particles: boolean
  rake: Rake | null
  sequential: SequentialMap
  diverging: DivergingMap
  /** «Blocca scala»: the ranges held. */
  locked: Ranges3D | null
}

export type Ranges3D = { plane: [number, number]; surface: [number, number]; speed: [number, number] }

export type Colors3D = { background: number[]; body: number[]; floor: number[]; line: number[]; smoke: number[] }

export type Snapshot3D = {
  ready: boolean
  step: number
  running: boolean
  stepsPerSecond: number
  fps: number
  stepsPerFrame: number
  unstable: boolean
  ramping: boolean
  rhoInf: number
  /** Plane: m/s or Cp; surface: Cp; tracers: m/s. */
  ranges: Ranges3D
  /** Cd, Cl (up, +z) and the side force Cs (+y, in the cm slot), corrected for the blockage. */
  stats: SeriesStats
  chart: CoefSample[]
}

/** Everything a saved 3D result needs from the GPU side (SPEC §24.2 #7). */
export type Engine3DResult = {
  step: number
  unstable: boolean
  stats: SeriesStats
  rhoInf: number
  /** Cd, Cl, Cs (cm slot) per measurement, corrected. */
  history: CoefSample[]
  /** Sums of (δρ, ux, uy, uz) per cell, or null before averaging starts. */
  mean: { sums: Float32Array<ArrayBuffer>; samples: number; rhoInf: number } | null
  voxels: Uint8Array
}

/** The 3D series: the side force, in the cm slot, may carry the shedding too. */
function seriesOptions(p: CasePlan3D): SeriesOptions {
  return { tcSteps: p.tc_steps, transientSteps: p.transient_steps, lLat: p.l_lat, uLat: p.u_lat, shedding: ['cl', 'cm'] }
}

const EMPTY_STATS: SeriesStats = {
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

const unstableSample = (s: Sample3D) => s.nan > 0 || !(s.rhoMin >= 0.7 && s.rhoMax <= 1.3)

/** Same grid, τ, velocity, boundaries and body: a new plan that needs no restart. */
function sameLattice(a: CasePlan3D, b: CasePlan3D): boolean {
  const keys: (keyof CasePlan3D)[] = ['nx', 'ny', 'nz', 'tau', 'u_lat', 'ramp_steps', 'ground', 'inlet_profile', 'inlet_reference_cells', 'sponge_start', 'smagorinsky_cs']
  return keys.every((k) => a[k] === b[k]) && a.offset.every((v, i) => v === b.offset[i])
}

export class Engine3D {
  readonly camera = new OrbitCamera()
  onUpdate: (s: Snapshot3D) => void = () => undefined
  onUnstable: () => void = () => undefined
  /** The device was lost (driver reset, GPU hang): «Riprendi» makes a new engine. */
  onLost: (message: string) => void = () => undefined
  /** Called after each frame is submitted (video: the canvas still holds the frame). */
  onFrame: (() => void) | null = null

  private solver: Solver3D | null = null
  private series: CoefficientSeries | null = null
  private current: Case3D | null = null
  private bodyMesh: BodyMesh | null = null
  /** «Mostra i voxel»: the body as the flow sees it, made once per case. */
  private voxelMesh: { key: string; mesh: BodyMesh } | null = null
  /** The mesh the views hold now. */
  private drawn: BodyMesh | null = null
  private yaw = 0
  private pitch = 0
  private running = false
  private pendingSingle = 0
  private unstable = false
  private disposed = false
  private lost = false
  private handle = 0
  private outstanding = 0
  private lastDone = 0
  /** Steps per frame, smoothed (a frame runs its rounding). */
  private spf = 4
  /**
   * The fraction of a step carried to the next frame: frames run whole steps,
   * but on average `spf` of them (rounding 4.4 to 4 would lose a tenth).
   */
  private carry = 0
  private fixedSpf: number | null = null
  private frameTimes: number[] = []
  private stepTimes: { t: number; step: number }[] = []
  private rhoInf = 1
  private fieldFresh = false
  private smokeHead = 0
  private nozzleCount = 0
  /** The rake the filaments were emitted from: same rake, same smoke. */
  private nozzleKey = ''
  private planeRange: [number, number] = [0, 1]
  private surfaceRange: [number, number] = [-1.5, 1.5]
  private speedRange: [number, number] = [0, 1]
  private rangesKnown = false
  private lastRange = 0
  private lastPublish = 0
  private surfaceSamples: Float32Array<ArrayBuffer> = new Float32Array(0)
  private colors: Colors3D = {
    background: [0.07, 0.07, 0.07, 1],
    body: [0.79, 0.81, 0.85, 1],
    floor: [0.15, 0.15, 0.15, 1],
    line: [0.55, 0.55, 0.55, 1],
    smoke: [0.96, 0.96, 0.96, 0.85],
  }
  private options: ViewOptions3D = {
    plane: { shown: true, axis: 1, position: 0, field: 'speed' },
    surfaceCp: false,
    voxels: false,
    smoke: false,
    particles: false,
    rake: null,
    sequential: 'viridis',
    diverging: 'coolwarm',
    locked: null,
  }
  private targets: { color: GPUTexture; depth: GPUTexture; width: number; height: number } | null = null

  private constructor(
    private readonly gpu: Gpu,
    readonly canvas: HTMLCanvasElement,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly views: Views3D,
  ) {
    views.setMaps(this.options.sequential, this.options.diverging)
    gpu.device.lost.then((info) => {
      this.lost = true
      if (!this.disposed) this.onLost(info.message)
    })
    this.handle = requestAnimationFrame(this.frame)
  }

  /** WebGPU, the canvas and the view pipelines; throws WebGpuUnsupported without WebGPU. */
  static async create(canvas: HTMLCanvasElement): Promise<Engine3D> {
    const gpu = await requestGpu()
    try {
      const context = canvas.getContext('webgpu')
      if (!context) throw new Error('contesto WebGPU del canvas non disponibile')
      const format = navigator.gpu.getPreferredCanvasFormat()
      context.configure({ device: gpu.device, format, alphaMode: 'opaque' })
      const views = await Views3D.create(gpu.device, format)
      return new Engine3D(gpu, canvas, context, format, views)
    } catch (error) {
      gpu.device.destroy()
      throw error
    }
  }

  get adapter(): string {
    return this.gpu.adapter
  }

  get plan(): CasePlan3D | null {
    return this.current?.plan ?? null
  }

  get isRunning(): boolean {
    return this.running
  }

  get step(): number {
    return this.solver?.step ?? 0
  }

  /**
   * A new case. The flow starts from rest -- unless only the numbers of the
   * plan changed (the reference length: same grid, τ, boundaries and body), as
   * in 2D (SPEC §9.4).
   */
  async setCase(c: Case3D): Promise<void> {
    const before = this.current
    if (before && this.solver && before.voxelKey === c.voxelKey && sameLattice(before.plan, c.plan)) {
      // New numbers on the same flow (the reference length or area): averages restart.
      this.current = c
      this.series?.setOptions(seriesOptions(c.plan), this.solver.step)
      this.solver.clearMean()
      this.refreshGeometry()
      return
    }
    const solver = await Solver3D.create(this.gpu, latticeParams3D(c.plan), packMask(c.voxels), c.walls)
    if (this.disposed) {
      solver.dispose()
      return
    }
    const old = this.solver
    this.solver = solver
    this.series = new CoefficientSeries(seriesOptions(c.plan))
    this.current = c
    this.voxelMesh = null
    this.views.setGrid(c.plan, solver)
    this.nozzleKey = ''
    old?.dispose()
    this.unstable = false
    this.rhoInf = 1
    this.stepTimes = []
    this.fieldFresh = false
    this.smokeHead = 0
    this.rangesKnown = false
    if (!this.options.locked) this.defaultRanges()
    this.refreshGeometry()
  }

  /** The model's view mesh and the rotations it is drawn with. */
  setBody(body: BodyMesh | null, yaw: number, pitch: number): void {
    this.bodyMesh = body
    this.yaw = yaw
    this.pitch = pitch
    this.refreshGeometry()
  }

  /**
   * The voxels when asked for and when they are the drawn rotations' (while a
   * rotation is dragged the model turns on screen and the voxels wait for the
   * release); the model otherwise.
   */
  private chooseMesh(): void {
    const c = this.current
    let mesh = this.bodyMesh
    if (this.options.voxels && c && c.plan.yaw_deg === this.yaw && c.plan.pitch_deg === this.pitch) {
      if (this.voxelMesh?.key !== c.voxelKey) this.voxelMesh = { key: c.voxelKey, mesh: voxelSurface(c.voxels, c.plan, c.pivot) }
      mesh = this.voxelMesh.mesh
    }
    if (mesh !== this.drawn) {
      this.drawn = mesh
      this.views.setBody(mesh)
    }
  }

  setOptions(options: ViewOptions3D): void {
    const before = this.options
    this.options = options
    if (options.sequential !== before.sequential || options.diverging !== before.diverging) this.views.setMaps(options.sequential, options.diverging)
    if (options.rake !== before.rake) this.refreshGeometry()
    if (options.voxels !== before.voxels) this.chooseMesh()
    if (options.locked) {
      this.planeRange = options.locked.plane
      this.surfaceRange = options.locked.surface
      this.speedRange = options.locked.speed
    }
    if (options.plane.field !== before.plane.field || options.plane.axis !== before.plane.axis) {
      this.rangesKnown = false
      if (!options.locked) this.planeRange = options.plane.field === 'cp' ? [-1, 1] : this.speedRange
    }
    this.lastRange = 0
  }

  setColors(colors: Colors3D): void {
    this.colors = colors
  }

  setStepsPerFrame(fixed: number | null): void {
    this.fixedSpf = fixed
  }

  play(): void {
    this.running = true
  }

  pause(): void {
    this.running = false
  }

  stepOnce(): void {
    this.running = false
    this.pendingSingle += MEASURE_EVERY
  }

  /** Back to a fluid at rest. */
  restart(): void {
    this.solver?.restart()
    this.series?.clear()
    this.unstable = false
    this.rhoInf = 1
    this.stepTimes = []
    this.fieldFresh = false
    this.views.resetTracers()
    this.smokeHead = 0
    if (!this.options.locked) this.defaultRanges()
  }

  /** The camera on the body: its centre a little downstream, the wake in view. */
  frameBody(box: readonly number[], view: Parameters<OrbitCamera['fit']>[2] = 'iso'): void {
    const [x0, y0, z0, x1, y1, z1] = box
    const size = Math.max(x1 - x0, y1 - y0, z1 - z0)
    this.camera.fit([(x0 + x1) / 2 + 0.6 * (x1 - x0), (y0 + y1) / 2, (z0 + z1) / 2], 2.6 * size, view)
  }

  /** Chamber edges and rake, model placement, nozzles and sample points: after any change of them. */
  private refreshGeometry(): void {
    this.chooseMesh()
    const c = this.current
    if (!c) return
    const p = c.plan
    const [lx, ly, lz] = [p.nx * p.dx, p.ny * p.dx, p.nz * p.dx]
    const lines: number[] = []
    const seg = (a: number[], b: number[], accent = 0) => lines.push(...a, accent, ...b, accent)
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? lx : 0, i & 2 ? ly : 0, i & 4 ? lz : 0])
    for (const [a, b] of [
      [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
    ])
      seg(corners[a], corners[b])
    const rake = this.options.rake
    this.nozzleCount = 0
    if (rake) {
      const cells = rakeNozzles({ ...rake, nozzles: Math.min(MAX_NOZZLES, rake.nozzles) }, p)
      this.nozzleCount = cells.length / 4
      const key = `${this.solver ? this.solver.cells : 0}:${cells.join(',')}`
      if (key !== this.nozzleKey) {
        this.nozzleKey = key
        this.views.setNozzles(cells)
        this.smokeHead = 0
      }
      const at = (k: number) => [cells[4 * k] * p.dx, cells[4 * k + 1] * p.dx, cells[4 * k + 2] * p.dx]
      seg(at(0), at(this.nozzleCount - 1), 1)
      const tick = 1.2 * p.dx
      for (let k = 0; k < this.nozzleCount; k++) {
        const q = at(k)
        seg([q[0] - tick, q[1], q[2]], q, 1)
      }
    }
    this.views.setLines(new Float32Array(lines))
    const body = this.bodyMesh
    this.surfaceSamples = body
      ? surfacePoints(body, modelMatrix(c.pivot, p.offset, this.yaw, this.pitch), rotationMatrix(this.yaw, this.pitch), p)
      : new Float32Array(0)
  }

  private resize(): { width: number; height: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    return { width, height }
  }

  private targetsFor(width: number, height: number) {
    const t = this.targets
    if (t && t.width === width && t.height === height) return t
    t?.color.destroy()
    t?.depth.destroy()
    const device = this.gpu.device
    const color = device.createTexture({ size: [width, height], format: this.format, sampleCount: SAMPLE_COUNT, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const depth = device.createTexture({ size: [width, height], format: 'depth24plus', sampleCount: SAMPLE_COUNT, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.targets = { color, depth, width, height }
    return this.targets
  }

  private uniforms(width: number, height: number, scale: number): FrameUniforms {
    const c = this.current
    const p = c?.plan
    const o = this.options
    const pivot = c?.pivot ?? [0, 0, 0]
    const offset: Vec3 = p ? p.offset : pivot
    const uLat = p?.u_lat ?? 0.08
    return {
      viewProj: this.camera.viewProj(width / height),
      model: modelMatrix(pivot, offset, this.yaw, this.pitch),
      normal: rotationMatrix(this.yaw, this.pitch),
      eye: this.camera.eye(),
      dx: p?.dx ?? 1,
      uLat,
      rhoInf: this.rhoInf,
      speedScale: p ? p.speed / p.u_lat : 1,
      plane: { axis: o.plane.axis, position: o.plane.position, field: o.plane.field, shown: o.plane.shown && this.fieldFresh },
      planeRange: this.planeRange,
      surfaceRange: this.surfaceRange,
      speedRange: this.speedRange,
      surfaceCp: o.surfaceCp && this.fieldFresh,
      floorShift: p ? (uLat * this.step) % 8 : 0,
      ground: p?.ground ?? 'none',
      colors: this.colors,
      smokeHead: this.smokeHead,
      nozzles: this.nozzleCount,
      smoke: o.smoke && this.fieldFresh,
      particles: o.particles && this.fieldFresh,
      tail: TAIL_CELLS / uLat,
      scale,
    }
  }

  private frame = (now: number): void => {
    if (this.disposed || this.lost) return
    this.handle = requestAnimationFrame(this.frame)
    if (this.outstanding >= 2) return
    const { width, height } = this.resize()
    const device = this.gpu.device
    const solver = this.solver

    let steps = 0
    if (solver && !this.unstable) {
      if (this.running) {
        if (this.fixedSpf !== null) steps = this.fixedSpf
        else {
          this.carry += this.spf
          steps = Math.max(1, Math.floor(this.carry))
          this.carry = Math.max(0, this.carry - steps)
        }
      }
      else if (this.pendingSingle > 0) {
        steps = this.pendingSingle
        this.pendingSingle = 0
      }
    }
    if (solver && steps > 0) {
      // Measure at every multiple of 8 steps (forces, NaNs, density range, ρ∞).
      let left = steps
      while (left > 0) {
        const n = Math.min(left, MEASURE_EVERY - (solver.step % MEASURE_EVERY))
        solver.run(n)
        left -= n
        // Past the transient every fourth measurement also feeds the time averages of
        // the field: a sample every 32 steps is plenty (T_c is hundreds of steps), and
        // summing 24 MB at every measurement made frames stall.
        const averaging =
          this.series !== null && solver.step >= this.series.averagingFrom && !this.unstable && solver.step % AVERAGE_EVERY === 0
        if (solver.step % MEASURE_EVERY === 0) solver.measure(averaging)
      }
      this.stepTimes.push({ t: now, step: solver.step })
    }
    while (this.stepTimes.length > 1 && this.stepTimes[0].t < now - 1000) this.stepTimes.shift()

    const encoder = device.createCommandEncoder({ label: 'fotogramma' })
    if (solver && (steps > 0 || !this.fieldFresh)) {
      this.views.updateField(encoder, solver)
      this.fieldFresh = true
    }
    if (solver && steps > 0) {
      const o = this.options
      if (o.smoke && this.nozzleCount) this.smokeHead = (this.smokeHead + 1) % SMOKE_POINTS
      this.views.advect(encoder, steps, { particles: o.particles, smoke: o.smoke, smokeHead: this.smokeHead, nozzles: this.nozzleCount })
    }
    const t = this.targetsFor(width, height)
    const target: Target = {
      color: t.color.createView(),
      resolve: this.context.getCurrentTexture().createView(),
      depth: t.depth.createView(),
      width,
      height,
    }
    this.views.render(encoder, target, this.uniforms(width, height, 1), this.colors.background.slice(0, 3) as [number, number, number])
    device.queue.submit([encoder.finish()])
    this.outstanding++
    const submitted = performance.now()
    void device.queue.onSubmittedWorkDone().then(() => {
      this.outstanding--
      const done = performance.now()
      // GPU time of this frame: from when it could start (submitted, or the previous one done).
      const gpuMs = done - Math.max(submitted, this.lastDone)
      this.lastDone = done
      if (steps > 0 && this.fixedSpf === null) this.adapt(steps, gpuMs)
    })
    this.frameTimes.push(now)
    while (this.frameTimes.length && this.frameTimes[0] < now - 1000) this.frameTimes.shift()
    this.onFrame?.()

    if (solver) this.absorb(solver.collect())
    if (now - this.lastRange > RANGE_EVERY_MS) {
      this.lastRange = now
      this.measureRanges()
    }
    if (now - this.lastPublish > 200) {
      this.lastPublish = now
      this.onUpdate(this.snapshot())
    }
  }

  /**
   * The ranges before the flow is up to speed: the start-up ramp would have
   * the automatic scale chase speeds a thousandth of the wind's.
   */
  private defaultRanges(): void {
    const p = this.current?.plan
    const v = p ? p.speed : 1
    this.speedRange = [0, 1.3 * v]
    this.planeRange = this.options.plane.field === 'cp' ? [-1, 1] : this.speedRange
    this.surfaceRange = [-1, 1]
  }

  /** Steps per frame toward the frame budget, smoothed so that one slow frame does not halve them. */
  private adapt(steps: number, gpuMs: number): void {
    if (!(gpuMs > 0)) return
    const wanted = (steps * FRAME_BUDGET_MS) / gpuMs
    this.spf = Math.max(1, Math.min(MAX_STEPS_PER_FRAME, 0.75 * this.spf + 0.25 * wanted))
  }

  private absorb(samples: Sample3D[]): void {
    const p = this.current?.plan
    for (const s of samples) {
      if (this.unstable) break
      if (unstableSample(s)) {
        this.unstable = true
        this.running = false
        this.onUnstable()
        break
      }
      this.rhoInf = s.rhoInf
      if (p && this.series) {
        // On the reference area with the measured ρ∞, then as in open air (SPEC §24.6).
        const per = p.blockage_correction / (0.5 * s.rhoInf * p.u_lat * p.u_lat * p.a_lat)
        this.series.add({ step: s.step, cd: s.fx * per, cl: s.fz * per, cm: s.fy * per })
      }
    }
  }

  /** The colour ranges from the plane's fluid cells and from just off the surface (SPEC §10.6). */
  private measureRanges(): void {
    void this.rangesFor(this.options)
  }

  /** The ranges of what `o` shows, measured on the GPU; resolves once they are in place. */
  private rangesFor(o: ViewOptions3D): Promise<void> {
    const c = this.current
    if (!c || !this.fieldFresh || o.locked || this.step < c.plan.ramp_steps) return Promise.resolve()
    const plane = o.plane.shown || o.particles ? planePoints(o.plane.axis, o.plane.position, c.plan, c.voxels) : new Float32Array(0)
    const surface = o.surfaceCp ? this.surfaceSamples : new Float32Array(0)
    if (!plane.length && !surface.length) return Promise.resolve()
    const points = new Float32Array(plane.length + surface.length)
    points.set(plane, 0)
    points.set(surface, plane.length)
    const read = this.views.probe(points)
    if (!read) return Promise.resolve()
    const p = c.plan
    const split = plane.length / 4
    const field = o.plane.field
    return read
      .then((values) => {
        if (this.current !== c || this.options.locked) return
        const q = 0.5 * this.rhoInf * p.u_lat * p.u_lat
        const cp = (k: number) => (values[4 * k + 3] - (this.rhoInf - 1)) / 3 / q
        const speed = (k: number) => Math.hypot(values[4 * k], values[4 * k + 1], values[4 * k + 2]) * (p.speed / p.u_lat)
        const count = values.length / 4
        const speeds: number[] = []
        const cps: number[] = []
        const surfaceValues: number[] = []
        for (let k = 0; k < count; k++) {
          if (k < split) {
            speeds.push(speed(k))
            if (field === 'cp') cps.push(cp(k))
          } else surfaceValues.push(cp(k))
        }
        const sp = autoRange(speeds, false)
        const pr = field === 'cp' ? autoRange(cps, true) : sp
        const sr = autoRange(surfaceValues, true)
        if (sp) this.speedRange = sp
        if (pr) this.planeRange = pr
        if (sr) this.surfaceRange = sr
        this.rangesKnown = true
      })
      .catch(() => undefined)
  }

  /**
   * A picture for a study (SPEC §24.2 #7): what `change` shows, from `look`
   * framed on the body's `box` (chamber metres), `scale` times the canvas, with
   * the ranges that view gets now. The tunnel's own options, camera and ranges
   * come back afterwards.
   */
  async renderStudyView(
    change: Partial<ViewOptions3D>,
    look: CameraView,
    box: readonly number[],
    scale: number,
  ): Promise<{ canvas: HTMLCanvasElement; ranges: Ranges3D } | null> {
    const options = this.options
    const cam = this.camera
    const saved = { target: [...cam.target] as Vec3, distance: cam.distance, azimuth: cam.azimuth, elevation: cam.elevation }
    const ranges = { plane: this.planeRange, surface: this.surfaceRange, speed: this.speedRange }
    try {
      this.options = { ...options, ...change, locked: null }
      this.chooseMesh()
      this.frameBody(box, look)
      await this.rangesFor(this.options)
      const canvas = await this.renderLarge(scale)
      return canvas ? { canvas, ranges: { plane: this.planeRange, surface: this.surfaceRange, speed: this.speedRange } } : null
    } finally {
      this.options = options
      this.chooseMesh()
      Object.assign(cam, saved)
      this.planeRange = ranges.plane
      this.surfaceRange = ranges.surface
      this.speedRange = ranges.speed
    }
  }

  snapshot(): Snapshot3D {
    const first = this.stepTimes[0]
    const last = this.stepTimes[this.stepTimes.length - 1]
    const sps = first && last && last.t > first.t ? ((last.step - first.step) * 1000) / (last.t - first.t) : 0
    const p = this.current?.plan
    return {
      ready: this.solver !== null && this.rangesKnown,
      step: this.step,
      running: this.running,
      stepsPerSecond: this.running ? sps : 0,
      fps: this.frameTimes.length,
      stepsPerFrame: this.fixedSpf ?? Math.round(this.spf * 10) / 10,
      unstable: this.unstable,
      ramping: p ? this.step < p.ramp_steps : false,
      rhoInf: this.rhoInf,
      ranges: { plane: this.planeRange, surface: this.surfaceRange, speed: this.speedRange },
      stats: this.series?.stats() ?? EMPTY_STATS,
      chart: this.series?.chart() ?? [],
    }
  }

  /** What a study saves of the current case (SPEC §24.2 #7). */
  async result(): Promise<Engine3DResult | null> {
    const solver = this.solver
    const c = this.current
    if (!solver || !c || !this.series) return null
    const samples = solver.meanSamples
    const rhoInf = solver.meanRhoInf
    const sums = samples && !this.unstable ? await solver.readMean() : null
    if (this.disposed || solver !== this.solver) return null
    return {
      step: solver.step,
      unstable: this.unstable,
      stats: this.series.stats(),
      rhoInf: this.rhoInf,
      history: this.series.all(),
      mean: sums ? { sums, samples, rhoInf } : null,
      voxels: c.voxels,
    }
  }

  /**
   * The current view rendered `scale` times larger (SPEC §10.7: the snapshot
   * at double resolution), as a 2D canvas.
   */
  async renderLarge(scale: number): Promise<HTMLCanvasElement | null> {
    if (this.disposed || this.lost) return null
    const device = this.gpu.device
    const width = Math.min(device.limits.maxTextureDimension2D, Math.round(this.canvas.width * scale))
    const height = Math.min(device.limits.maxTextureDimension2D, Math.round(this.canvas.height * scale))
    const usage = GPUTextureUsage.RENDER_ATTACHMENT
    const color = device.createTexture({ size: [width, height], format: this.format, sampleCount: SAMPLE_COUNT, usage })
    const depth = device.createTexture({ size: [width, height], format: 'depth24plus', sampleCount: SAMPLE_COUNT, usage })
    const resolved = device.createTexture({ size: [width, height], format: this.format, usage: usage | GPUTextureUsage.COPY_SRC })
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256
    const read = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    try {
      const encoder = device.createCommandEncoder({ label: 'istantanea' })
      const target: Target = { color: color.createView(), resolve: resolved.createView(), depth: depth.createView(), width, height }
      this.views.render(encoder, target, this.uniforms(width, height, scale), this.colors.background.slice(0, 3) as [number, number, number])
      encoder.copyTextureToBuffer({ texture: resolved }, { buffer: read, bytesPerRow }, [width, height])
      device.queue.submit([encoder.finish()])
      await read.mapAsync(GPUMapMode.READ)
      const bytes = new Uint8Array(read.getMappedRange())
      const image = new ImageData(width, height)
      const bgra = this.format === 'bgra8unorm'
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const s = y * bytesPerRow + 4 * x
          const d = 4 * (y * width + x)
          image.data[d] = bytes[s + (bgra ? 2 : 0)]
          image.data[d + 1] = bytes[s + 1]
          image.data[d + 2] = bytes[s + (bgra ? 0 : 2)]
          image.data[d + 3] = 255
        }
      read.unmap()
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      return canvas
    } finally {
      color.destroy()
      depth.destroy()
      resolved.destroy()
      read.destroy()
    }
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.handle)
    this.solver?.dispose()
    this.solver = null
    this.views.dispose()
    this.targets?.color.destroy()
    this.targets?.depth.destroy()
    if (!this.lost) this.context.unconfigure()
    this.gpu.device.destroy()
  }
}
