// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The D3Q19 solver on WebGPU (SPEC §24.3): two population buffers ping-ponged
// by the fused step, the body as a bit mask with its interpolated walls
// (SPEC §24.8), and the measurements -- forces by
// momentum exchange, NaNs, the density range and ρ∞ through a reduction --
// read back without stalling (every 8 steps, as in 2D). It consumes lattice
// numbers only: they come from the 3D planner (SPEC §4, decision 4);
// `latticeParams3D` just copies them out of a CasePlan3D.
import type { CasePlan3D } from '../lib/types'
import { Q } from './lattice3d.generated'
import { shaderModule, type Gpu } from './gpu'
import { PARAMS_SIZE, PARAMS_STRIDE, RECORD_BYTES, WORKGROUP, measureShader, reduceShader, stepShader } from './shaders'
import { noWalls, type WallLinks } from './voxelize'

export type LatticeParams3D = {
  nx: number
  ny: number
  nz: number
  tau: number
  uLat: number
  rampSteps: number
  ground: 'none' | 'fixed' | 'moving'
  boundaryLayer: boolean
  inletExponent: number
  inletReferenceCells: number
  /** First sponge plane; nx for none. */
  spongeStart: number
  spongeFactor: number
  spongeDamping: number
  /** Smagorinsky constant; 0 switches the subgrid model off. */
  cs: number
}

export function latticeParams3D(plan: CasePlan3D): LatticeParams3D {
  return {
    nx: plan.nx,
    ny: plan.ny,
    nz: plan.nz,
    tau: plan.tau,
    uLat: plan.u_lat,
    rampSteps: plan.ramp_steps,
    ground: plan.ground,
    boundaryLayer: plan.inlet_profile === 'boundary_layer',
    inletExponent: plan.inlet_exponent,
    inletReferenceCells: plan.inlet_reference_cells,
    spongeStart: plan.sponge_start,
    spongeFactor: plan.sponge_factor,
    spongeDamping: plan.sponge_damping,
    cs: plan.smagorinsky_cs,
  }
}

/** Inlet speed at a step, as float32 like the reference's (the same ramp as in 2D). */
export function rampedSpeed3D(step: number, p: LatticeParams3D): number {
  const r = p.rampSteps <= 0 || step >= p.rampSteps ? 1 : 0.5 * (1 - Math.cos((Math.PI * step) / p.rampSteps))
  return Math.fround(Math.fround(p.uLat) * Math.fround(r))
}

/** Inlet shape per row z, float32: ones, or the boundary-layer power law. */
export function inletShape3D(p: LatticeParams3D): Float32Array<ArrayBuffer> {
  const out = new Float32Array(p.nz).fill(1)
  if (p.boundaryLayer)
    for (let z = 0; z < p.nz; z++) out[z] = Math.pow((z + 0.5) / p.inletReferenceCells, p.inletExponent)
  return out
}

/** The Smagorinsky factor 18 √2 Cs², rounded step by step in float32 as the reference does. */
export function smagorinskyFactor(cs: number): number {
  const c = Math.fround(cs)
  return Math.fround(Math.fround(Math.fround(18 * Math.fround(Math.SQRT2)) * c) * c)
}

/** Voxels (one byte per cell, x fastest) as the solver's bit mask, 32 cells to a word. */
export function packMask(voxels: Uint8Array): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(Math.ceil(voxels.length / 32) + 1)
  for (let i = 0; i < voxels.length; i++) if (voxels[i]) out[i >>> 5] |= 1 << (i & 31)
  return out
}

/**
 * One measurement, lattice units, at the end of step `step`; the forces are
 * relative to the undisturbed pressure ρ∞ / 3 (SPEC §9.5).
 */
export type Sample3D = {
  step: number
  fx: number
  fy: number
  fz: number
  nan: number
  rhoMin: number
  rhoMax: number
  rhoInf: number
}

type Dispatch = { x: number; y: number; rowStride: number }

function dispatchFor(items: number, maxPerDimension: number): Dispatch {
  const groups = Math.max(1, Math.ceil(items / WORKGROUP))
  const x = Math.min(groups, maxPerDimension)
  return { x, y: Math.ceil(groups / x), rowStride: x * WORKGROUP }
}

const GROUND = { none: 0, fixed: 1, moving: 2 } as const
/** Steps encoded in one command buffer (one uniform slot each). */
const BATCH = 64
const READERS = 4

type Compiled = {
  pipelines: { step: GPUComputePipeline; measure: GPUComputePipeline; reduce: GPUComputePipeline }
  layouts: { step: GPUBindGroupLayout; measure: GPUBindGroupLayout; reduce: GPUBindGroupLayout }
}

/** The kernels, compiled once per device: a new case (a new grid) reuses them. */
const PIPELINES = new WeakMap<GPUDevice, Promise<Compiled>>()

async function compile(device: GPUDevice): Promise<Compiled> {
  const storage = (binding: number, readOnly: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' },
  })
  const params = (dynamic: boolean): GPUBindGroupLayoutEntry => ({
    binding: 0,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: 'uniform', hasDynamicOffset: dynamic, minBindingSize: PARAMS_SIZE },
  })
  const layouts = {
    step: device.createBindGroupLayout({
      label: 'passo',
      entries: [params(true), storage(1, true), storage(2, false), storage(3, true), storage(4, true), storage(6, true), storage(7, true)],
    }),
    measure: device.createBindGroupLayout({
      label: 'misura',
      entries: [params(false), storage(1, true), storage(3, true), storage(5, false), storage(6, true), storage(7, true), storage(8, false)],
    }),
    reduce: device.createBindGroupLayout({
      label: 'riduzione',
      entries: [params(false), storage(1, true), storage(5, false)],
    }),
  }
  const pipeline = async (label: string, code: string, layout: GPUBindGroupLayout) =>
    device.createComputePipelineAsync({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: await shaderModule(device, label, code), entryPoint: 'main' },
    })
  const [step, measure, reduce] = await Promise.all([
    pipeline('passo', stepShader(), layouts.step),
    pipeline('misura', measureShader(), layouts.measure),
    pipeline('riduzione', reduceShader(), layouts.reduce),
  ])
  return { pipelines: { step, measure, reduce }, layouts }
}

export class Solver3D {
  /** Steps done since the start. */
  step = 0
  readonly cells: number
  private readonly device: GPUDevice
  private readonly pops: [GPUBuffer, GPUBuffer]
  private readonly mask: GPUBuffer
  private readonly wallIndex: GPUBuffer
  private readonly wallQ: GPUBuffer
  private readonly inlet: GPUBuffer
  /** Sums of (δρ, ux, uy, uz) per cell over the samples of the time averages. */
  private readonly sums: GPUBuffer
  private readonly params: GPUBuffer
  private readonly stepGroups: [GPUBindGroup, GPUBindGroup]
  private readonly measureGroups: [GPUBindGroup, GPUBindGroup]
  private readonly levels: { group: GPUBindGroup; dispatch: Dispatch }[] = []
  private readonly partials: GPUBuffer[] = []
  private readonly finalPartial: GPUBuffer
  private readonly cellDispatch: Dispatch
  private readonly slot = new ArrayBuffer(PARAMS_STRIDE * BATCH)
  private readers: { buffer: GPUBuffer; busy: boolean }[] = []
  private finished: Sample3D[] = []
  /** Bumped by restart(): samples of an older run are dropped. */
  private epoch = 0
  /** Samples in the time averages; their ρ∞, summed. */
  meanSamples = 0
  private meanRho = 0
  private lastRhoInf = 1
  private accumulating = false

  private constructor(
    gpu: Gpu,
    readonly lattice: LatticeParams3D,
    voxels: Uint32Array<ArrayBuffer>,
    walls: WallLinks,
    private readonly pipelines: { step: GPUComputePipeline; measure: GPUComputePipeline; reduce: GPUComputePipeline },
    layouts: { step: GPUBindGroupLayout; measure: GPUBindGroupLayout; reduce: GPUBindGroupLayout },
  ) {
    const device = gpu.device
    this.device = device
    const p = lattice
    this.cells = p.nx * p.ny * p.nz
    const bytes = this.cells * Q * 4
    if (bytes > gpu.maxBuffer) throw new Error(`griglia troppo grande per la GPU: ${bytes} byte`)
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    this.pops = [0, 1].map((i) => device.createBuffer({ label: `popolazioni ${i}`, size: bytes, usage: storage })) as [
      GPUBuffer,
      GPUBuffer,
    ]
    this.mask = device.createBuffer({ label: 'maschera', size: voxels.byteLength, usage: storage })
    device.queue.writeBuffer(this.mask, 0, voxels)
    this.wallIndex = device.createBuffer({ label: 'pareti', size: walls.index.byteLength, usage: storage })
    device.queue.writeBuffer(this.wallIndex, 0, walls.index)
    this.wallQ = device.createBuffer({ label: 'pareti q', size: Math.max(16, walls.q.byteLength), usage: storage })
    device.queue.writeBuffer(this.wallQ, 0, walls.q)
    this.sums = device.createBuffer({ label: 'medie', size: this.cells * 16, usage: storage })
    const shape = inletShape3D(p)
    this.inlet = device.createBuffer({ label: 'ingresso', size: Math.max(16, shape.byteLength), usage: storage })
    device.queue.writeBuffer(this.inlet, 0, shape)
    const maxDim = device.limits.maxComputeWorkgroupsPerDimension
    this.cellDispatch = dispatchFor(this.cells, maxDim)

    // Records of each reduction level: one per workgroup actually dispatched
    // (a 2D dispatch may have a few more than needed; they add neutral records),
    // so that no workgroup ever writes past its buffer.
    const counts = [this.cellDispatch.x * this.cellDispatch.y]
    while (counts[counts.length - 1] > 1) {
      const d = dispatchFor(counts[counts.length - 1], maxDim)
      counts.push(d.x * d.y)
    }
    // Slots 0..BATCH-1 for the steps, BATCH for the measurement, then one per reduction level.
    const slots = BATCH + 1 + counts.length
    this.params = device.createBuffer({
      label: 'parametri',
      size: PARAMS_STRIDE * slots,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const uniform = (size = PARAMS_SIZE, offset = 0) => ({ buffer: this.params, offset, size })
    const binding = (buffer: GPUBuffer) => ({ buffer })
    this.stepGroups = [0, 1].map((i) =>
      device.createBindGroup({
        layout: layouts.step,
        entries: [
          { binding: 0, resource: uniform() },
          { binding: 1, resource: binding(this.pops[i]) },
          { binding: 2, resource: binding(this.pops[1 - i]) },
          { binding: 3, resource: binding(this.mask) },
          { binding: 4, resource: binding(this.inlet) },
          { binding: 6, resource: binding(this.wallIndex) },
          { binding: 7, resource: binding(this.wallQ) },
        ],
      }),
    ) as [GPUBindGroup, GPUBindGroup]

    for (const n of counts) {
      this.partials.push(device.createBuffer({ label: 'riduzione', size: n * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }))
    }
    this.finalPartial = this.partials[this.partials.length - 1]
    const measureSlot = PARAMS_STRIDE * BATCH
    this.measureGroups = [0, 1].map((i) =>
      device.createBindGroup({
        layout: layouts.measure,
        entries: [
          { binding: 0, resource: uniform(PARAMS_SIZE, measureSlot) },
          { binding: 1, resource: binding(this.pops[i]) },
          { binding: 3, resource: binding(this.mask) },
          { binding: 5, resource: binding(this.partials[0]) },
          { binding: 6, resource: binding(this.wallIndex) },
          { binding: 7, resource: binding(this.wallQ) },
          { binding: 8, resource: binding(this.sums) },
        ],
      }),
    ) as [GPUBindGroup, GPUBindGroup]
    const init = new ArrayBuffer(PARAMS_STRIDE * slots)
    this.fillParams(new DataView(init, measureSlot), 0, this.cells, this.cellDispatch.rowStride)
    for (let l = 1; l < counts.length; l++) {
      const dispatch = dispatchFor(counts[l - 1], maxDim)
      const offset = PARAMS_STRIDE * (BATCH + 1 + l)
      this.fillParams(new DataView(init, offset), 0, counts[l - 1], dispatch.rowStride)
      const group = device.createBindGroup({
        layout: layouts.reduce,
        entries: [
          { binding: 0, resource: uniform(PARAMS_SIZE, offset) },
          { binding: 1, resource: binding(this.partials[l - 1]) },
          { binding: 5, resource: binding(this.partials[l]) },
        ],
      })
      this.levels.push({ group, dispatch })
    }
    device.queue.writeBuffer(this.params, 0, init)
    for (let i = 0; i < READERS; i++)
      this.readers.push({
        buffer: device.createBuffer({ label: 'lettura', size: RECORD_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
      })
  }

  /** `walls`: the body's interpolated walls (SPEC §24.8); none = halfway bounce-back. */
  static async create(
    gpu: Gpu,
    lattice: LatticeParams3D,
    voxels: Uint32Array<ArrayBuffer>,
    walls: WallLinks = noWalls(lattice.nx * lattice.ny * lattice.nz),
  ): Promise<Solver3D> {
    let compiled = PIPELINES.get(gpu.device)
    if (!compiled) PIPELINES.set(gpu.device, (compiled = compile(gpu.device)))
    const { pipelines, layouts } = await compiled
    return new Solver3D(gpu, lattice, voxels, walls, pipelines, layouts)
  }

  private fillParams(view: DataView, u: number, count: number, rowStride: number, accumulate = false): void {
    const p = this.lattice
    const ints = [p.nx, p.ny, p.nz, this.cells, rowStride, GROUND[p.ground], p.spongeStart, count]
    ints.forEach((v, i) => view.setUint32(4 * i, v, true))
    const floats = [p.tau, u, p.spongeFactor, p.spongeDamping, smagorinskyFactor(p.cs), accumulate ? 1 : 0, 0, 0]
    floats.forEach((v, i) => view.setFloat32(32 + 4 * i, v, true))
  }

  /** The buffer holding the current state (for the views). */
  get current(): GPUBuffer {
    return this.pops[this.step % 2]
  }

  /** The body's bit mask (for the views: tracers die in it, the plane shows its cells). */
  get maskBuffer(): GPUBuffer {
    return this.mask
  }

  /** Advance `steps` time steps. */
  run(steps: number): void {
    const device = this.device
    while (steps > 0) {
      const batch = Math.min(BATCH, steps)
      for (let i = 0; i < batch; i++)
        this.fillParams(
          new DataView(this.slot, PARAMS_STRIDE * i),
          rampedSpeed3D(this.step + i, this.lattice),
          this.cells,
          this.cellDispatch.rowStride,
        )
      device.queue.writeBuffer(this.params, 0, this.slot, 0, PARAMS_STRIDE * batch)
      const encoder = device.createCommandEncoder({ label: 'passi' })
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.pipelines.step)
      for (let i = 0; i < batch; i++) {
        pass.setBindGroup(0, this.stepGroups[(this.step + i) % 2], [PARAMS_STRIDE * i])
        pass.dispatchWorkgroups(this.cellDispatch.x, this.cellDispatch.y)
      }
      pass.end()
      device.queue.submit([encoder.finish()])
      this.step += batch
      steps -= batch
    }
  }

  /**
   * Start a measurement of the current state; false when every read-back
   * buffer is busy. `accumulate`: the state also joins the time averages (it
   * does even when the read-back has to be skipped).
   */
  measure(accumulate = false): boolean {
    const reader = this.readers.find((r) => !r.busy)
    if (!reader && !accumulate) return false
    const device = this.device
    if (accumulate !== this.accumulating) {
      this.accumulating = accumulate
      const view = new DataView(new ArrayBuffer(PARAMS_SIZE))
      this.fillParams(view, 0, this.cells, this.cellDispatch.rowStride, accumulate)
      device.queue.writeBuffer(this.params, PARAMS_STRIDE * BATCH, view)
    }
    const encoder = device.createCommandEncoder({ label: 'misura' })
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.measure)
    pass.setBindGroup(0, this.measureGroups[this.step % 2])
    pass.dispatchWorkgroups(this.cellDispatch.x, this.cellDispatch.y)
    pass.setPipeline(this.pipelines.reduce)
    for (const level of this.levels) {
      pass.setBindGroup(0, level.group)
      pass.dispatchWorkgroups(level.dispatch.x, level.dispatch.y)
    }
    pass.end()
    if (accumulate) {
      this.meanSamples++
      this.meanRho += this.lastRhoInf
    }
    if (!reader) {
      device.queue.submit([encoder.finish()])
      return false
    }
    encoder.copyBufferToBuffer(this.finalPartial, 0, reader.buffer, 0, RECORD_BYTES)
    device.queue.submit([encoder.finish()])
    reader.busy = true
    const step = this.step
    const epoch = this.epoch
    reader.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const d = new Float32Array(reader.buffer.getMappedRange().slice(0))
        reader.buffer.unmap()
        reader.busy = false
        if (epoch !== this.epoch) return
        const rhoInf = d[7] > 0 ? d[6] / d[7] : 1
        this.lastRhoInf = rhoInf
        this.finished.push({
          step,
          // Relative to the undisturbed pressure (see measureShader).
          fx: d[0] - rhoInf * d[8],
          fy: d[1] - rhoInf * d[9],
          fz: d[2] - rhoInf * d[10],
          nan: d[3],
          rhoMin: d[4],
          rhoMax: d[5],
          rhoInf,
        })
      })
      .catch(() => {
        // The device is gone (lost or disposed): nothing to read.
        reader.busy = false
      })
    return true
  }

  /** Measurements finished since the last call, oldest first. */
  collect(): Sample3D[] {
    const out = this.finished.sort((a, b) => a.step - b.step)
    this.finished = []
    return out
  }

  /** Wait until the GPU has done everything submitted so far. */
  async idle(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone()
  }

  /** Mean ρ∞ over the samples of the time averages (the normalisation of their Cp). */
  get meanRhoInf(): number {
    return this.meanSamples ? this.meanRho / this.meanSamples : this.lastRhoInf
  }

  /** The time averages start again (a change that keeps the flow). */
  clearMean(): void {
    const encoder = this.device.createCommandEncoder()
    encoder.clearBuffer(this.sums)
    this.device.queue.submit([encoder.finish()])
    this.meanSamples = 0
    this.meanRho = 0
  }

  /** The sums of (δρ, ux, uy, uz) per cell (16 bytes a cell; divide by meanSamples). */
  async readMean(): Promise<Float32Array<ArrayBuffer>> {
    const device = this.device
    const size = this.cells * 16
    const staging = device.createBuffer({ label: 'medie lette', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.sums, 0, staging, 0, size)
    device.queue.submit([encoder.finish()])
    try {
      await staging.mapAsync(GPUMapMode.READ)
      const out = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      return out
    } finally {
      staging.destroy()
    }
  }

  /** The populations of the current state (tests and exports: 76 bytes a cell). */
  async readPopulations(): Promise<Float32Array> {
    const device = this.device
    const size = this.cells * Q * 4
    const staging = device.createBuffer({ label: 'stato', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.current, 0, staging, 0, size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = new Float32Array(staging.getMappedRange().slice(0))
    staging.unmap()
    staging.destroy()
    return out
  }

  /** Back to a fluid at rest, step 0. */
  restart(): void {
    const encoder = this.device.createCommandEncoder()
    for (const b of [...this.pops, this.sums]) encoder.clearBuffer(b)
    this.device.queue.submit([encoder.finish()])
    this.finished = []
    this.epoch++
    this.step = 0
    this.meanSamples = 0
    this.meanRho = 0
  }

  dispose(): void {
    for (const b of [...this.pops, this.mask, this.wallIndex, this.wallQ, this.inlet, this.sums, this.params, ...this.partials]) b.destroy()
    for (const r of this.readers) r.buffer.destroy()
    this.readers = []
  }
}
