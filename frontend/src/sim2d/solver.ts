// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The D2Q9 solver on the GPU (SPEC §10): state textures, the fused step, the
// live mask, and the measurements -- forces by momentum exchange, the density
// range, NaNs and ρ∞ through a reduction pyramid, plus the cells of the
// probes and of the contour -- read back without stalling (every 8 steps,
// SPEC §10.4). It consumes lattice numbers only: they come from the planner
// (SPEC §4, decision 4); `latticeParams` just copies them out of a CasePlan.
import type { CasePlan } from '../lib/types'
import {
  AsyncReader,
  bindTextures,
  framebuffer,
  program,
  texture,
  upload,
  type Program,
} from './gl'
import { ACCUM_FS, DOWNSAMPLE_FS, FORCES_FS, READOUT_FS, REDUCE_FS, REMASK_FS, STEP_FS } from './shaders'

export type LatticeParams = {
  nx: number
  ny: number
  tau: number
  uLat: number
  rampSteps: number
  ground: 'none' | 'fixed' | 'moving'
  boundaryLayer: boolean
  inletExponent: number
  inletReferenceCells: number
  /** First sponge column; nx for none. */
  spongeStart: number
  spongeFactor: number
  spongeDamping: number
  /** Smagorinsky constant; 0 switches the subgrid model off. */
  cs: number
}

export function latticeParams(plan: CasePlan): LatticeParams {
  return {
    nx: plan.nx,
    ny: plan.ny,
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

/** Fraction of the inlet speed at a step, as float32 like the reference's. */
export function rampedSpeed(step: number, p: LatticeParams): number {
  const r = p.rampSteps <= 0 || step >= p.rampSteps ? 1 : 0.5 * (1 - Math.cos((Math.PI * step) / p.rampSteps))
  return Math.fround(Math.fround(p.uLat) * Math.fround(r))
}

/** One measurement: lattice units, at the end of step `step`; forces relative to ρ∞ / 3. */
export type Sample = {
  step: number
  fx: number
  fy: number
  /** About the reference point passed to `measure`. */
  mz: number
  nan: number
  rhoMin: number
  rhoMax: number
  rhoInf: number
  /** (δρ, ux, uy, solid) at each listed cell. */
  cells: Float32Array
}

type StateSet = { a: WebGLTexture; b: WebGLTexture; c: WebGLTexture; fb: WebGLFramebuffer }
type Level = { w: number; h: number; s: WebGLTexture; t: WebGLTexture; u: WebGLTexture; fb: WebGLFramebuffer }

const GROUND = { none: 0, fixed: 1, moving: 2 } as const

export class Solver {
  /** Steps done since the start. */
  step = 0
  private sets: [StateSet, StateSet]
  private mask: WebGLTexture
  private spareMask: WebGLTexture
  private readonly stepProgram: Program
  private readonly remaskProgram: Program
  private readonly forcesProgram: Program
  private readonly reduceProgram: Program
  private readonly readoutProgram: Program
  private readonly downProgram: Program
  private readonly vao: WebGLVertexArrayObject
  private levels: Level[] = []
  private cellsTexture: WebGLTexture | null = null
  private cellCount = 0
  private readout: { tex: WebGLTexture; fb: WebGLFramebuffer; width: number } | null = null
  private readonly reader: AsyncReader<{ step: number; cells: number }>
  private down: { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number; factor: number } | null = null
  private readonly downReader: AsyncReader<{ w: number; h: number; factor: number; step: number }>
  private readonly accumProgram: Program
  /** Running sums of (δρ, ux, uy, samples), ping-pong (SPEC §11.1). */
  private sums: { tex: WebGLTexture; fb: WebGLFramebuffer }[]
  /** Samples in the sums. */
  meanSamples = 0

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly params: LatticeParams,
    initialMask?: Uint8Array,
  ) {
    const { nx, ny } = params
    const set = (): StateSet => {
      const a = texture(gl, nx, ny, 'rgba32f')
      const b = texture(gl, nx, ny, 'rgba32f')
      const c = texture(gl, nx, ny, 'rgba32f')
      return { a, b, c, fb: framebuffer(gl, [a, b, c]) }
    }
    this.sets = [set(), set()]
    this.mask = texture(gl, nx, ny, 'r8', initialMask ?? new Uint8Array(nx * ny))
    this.spareMask = texture(gl, nx, ny, 'r8')
    this.stepProgram = program(gl, STEP_FS)
    this.remaskProgram = program(gl, REMASK_FS)
    this.forcesProgram = program(gl, FORCES_FS)
    this.reduceProgram = program(gl, REDUCE_FS)
    this.readoutProgram = program(gl, READOUT_FS)
    this.downProgram = program(gl, DOWNSAMPLE_FS)
    this.accumProgram = program(gl, ACCUM_FS)
    const sum = () => {
      const tex = texture(gl, nx, ny, 'rgba32f')
      return { tex, fb: framebuffer(gl, [tex]) }
    }
    this.sums = [sum(), sum()]
    this.vao = gl.createVertexArray()!
    let w = nx
    let h = ny
    do {
      const s = texture(gl, w, h, 'rgba32f')
      const t = texture(gl, w, h, 'rgba32f')
      const u = texture(gl, w, h, 'rgba32f')
      this.levels.push({ w, h, s, t, u, fb: framebuffer(gl, [s, t, u]) })
      w = Math.ceil(w / 4)
      h = Math.ceil(h / 4)
    } while (this.levels[this.levels.length - 1].w > 1 || this.levels[this.levels.length - 1].h > 1)
    this.reader = new AsyncReader(gl, 4)
    this.downReader = new AsyncReader(gl, 2)
    this.setCells(new Int32Array(0))
  }

  /** The current state textures (for the views). */
  get current(): StateSet {
    return this.sets[0]
  }

  get maskTexture(): WebGLTexture {
    return this.mask
  }

  private draw(fb: WebGLFramebuffer | null, width: number, height: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.viewport(0, 0, width, height)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Advance `steps` time steps. */
  run(steps: number): void {
    const gl = this.gl
    const p = this.params
    const prog = this.stepProgram
    gl.useProgram(prog.program)
    gl.uniform1i(prog.uniform('uNx'), p.nx)
    gl.uniform1i(prog.uniform('uNy'), p.ny)
    gl.uniform1f(prog.uniform('uTau0'), p.tau)
    gl.uniform1i(prog.uniform('uGround'), GROUND[p.ground])
    gl.uniform1i(prog.uniform('uBL'), p.boundaryLayer ? 1 : 0)
    gl.uniform1f(prog.uniform('uRefCells'), p.inletReferenceCells)
    gl.uniform1f(prog.uniform('uExp'), p.inletExponent)
    gl.uniform1i(prog.uniform('uSpongeStart'), p.spongeStart)
    gl.uniform1f(prog.uniform('uSpongeFactor'), p.spongeFactor)
    gl.uniform1f(prog.uniform('uDamping'), p.spongeDamping)
    gl.uniform1f(prog.uniform('uCs'), p.cs)
    for (let n = 0; n < steps; n++) {
      const [from, to] = this.sets
      gl.uniform1f(prog.uniform('uU'), rampedSpeed(this.step, p))
      bindTextures(gl, prog, { uA: from.a, uB: from.b, uC: from.c, uMask: this.mask })
      this.draw(to.fb, p.nx, p.ny)
      this.sets = [to, from]
      this.step++
    }
  }

  /** A new body: the mask is replaced and the state adjusted around it (SPEC §10.3). */
  setMask(mask: Uint8Array): void {
    const gl = this.gl
    const p = this.params
    upload(gl, this.spareMask, p.nx, p.ny, 'r8', mask)
    const prog = this.remaskProgram
    gl.useProgram(prog.program)
    gl.uniform1i(prog.uniform('uNx'), p.nx)
    gl.uniform1i(prog.uniform('uNy'), p.ny)
    const [from, to] = this.sets
    bindTextures(gl, prog, { uA: from.a, uB: from.b, uC: from.c, uMask: this.mask, uNewMask: this.spareMask })
    this.draw(to.fb, p.nx, p.ny)
    this.sets = [to, from]
    ;[this.mask, this.spareMask] = [this.spareMask, this.mask]
  }

  /** Cells whose (δρ, ux, uy, solid) every measurement carries: probes, contour. */
  setCells(cells: Int32Array): void {
    const gl = this.gl
    this.cellCount = cells.length / 2
    const width = Math.max(1, this.cellCount)
    const coords = new Float32Array(width * 4)
    for (let i = 0; i < this.cellCount; i++) {
      coords[4 * i] = cells[2 * i]
      coords[4 * i + 1] = cells[2 * i + 1]
    }
    if (this.cellsTexture) gl.deleteTexture(this.cellsTexture)
    this.cellsTexture = texture(gl, width, 1, 'rgba32f', coords)
    const readWidth = 3 + this.cellCount
    if (!this.readout || this.readout.width !== readWidth) {
      if (this.readout) {
        gl.deleteFramebuffer(this.readout.fb)
        gl.deleteTexture(this.readout.tex)
      }
      const tex = texture(gl, readWidth, 1, 'rgba32f')
      this.readout = { tex, fb: framebuffer(gl, [tex]), width: readWidth }
    }
  }

  /**
   * Start a measurement of the current state (forces about `ref`, in cells).
   * False when the read-back buffers are all busy: the sample is skipped.
   */
  measure(ref: [number, number]): boolean {
    if (this.reader.busy()) return false
    const gl = this.gl
    const p = this.params
    const cur = this.sets[0]
    const f = this.forcesProgram
    gl.useProgram(f.program)
    gl.uniform1i(f.uniform('uNx'), p.nx)
    gl.uniform1i(f.uniform('uNy'), p.ny)
    gl.uniform2f(f.uniform('uRef'), ref[0], ref[1])
    bindTextures(gl, f, { uA: cur.a, uB: cur.b, uC: cur.c, uMask: this.mask })
    this.draw(this.levels[0].fb, p.nx, p.ny)
    const r = this.reduceProgram
    gl.useProgram(r.program)
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1]
      const dst = this.levels[i]
      gl.uniform2i(r.uniform('uIn'), src.w, src.h)
      bindTextures(gl, r, { uS: src.s, uT: src.t, uU: src.u })
      this.draw(dst.fb, dst.w, dst.h)
    }
    const top = this.levels[this.levels.length - 1]
    const o = this.readoutProgram
    gl.useProgram(o.program)
    bindTextures(gl, o, { uS: top.s, uT: top.t, uU: top.u, uC: cur.c, uMask: this.mask, uCells: this.cellsTexture! })
    const out = this.readout!
    this.draw(out.fb, out.width, 1)
    return this.reader.request(out.fb, out.width, 1, { step: this.step, cells: this.cellCount })
  }

  /** Measurements finished since the last call, oldest first. */
  collect(): Sample[] {
    return this.reader.collect().map(({ tag, data }) => {
      const rhoInf = data[7] > 0 ? data[6] / data[7] : 1
      return {
        step: tag.step,
        // Relative to the undisturbed pressure (see FORCES_FS).
        fx: data[0] - rhoInf * data[8],
        fy: data[1] - rhoInf * data[9],
        mz: data[2] - rhoInf * data[10],
        nan: data[3],
        rhoMin: data[4],
        rhoMax: data[5],
        rhoInf,
        cells: data.subarray(12, 12 + tag.cells * 4),
      }
    })
  }

  /** Ask for the field downsampled by `factor` (streamlines, colour scale). */
  requestField(factor: number): boolean {
    if (this.downReader.busy()) return false
    const gl = this.gl
    const p = this.params
    const w = Math.ceil(p.nx / factor)
    const h = Math.ceil(p.ny / factor)
    if (!this.down || this.down.w !== w || this.down.h !== h) {
      if (this.down) {
        gl.deleteFramebuffer(this.down.fb)
        gl.deleteTexture(this.down.tex)
      }
      const tex = texture(gl, w, h, 'rgba32f')
      this.down = { tex, fb: framebuffer(gl, [tex]), w, h, factor }
    }
    const d = this.downProgram
    gl.useProgram(d.program)
    gl.uniform1i(d.uniform('uFactor'), factor)
    gl.uniform2i(d.uniform('uSize'), p.nx, p.ny)
    bindTextures(gl, d, { uC: this.sets[0].c, uMask: this.mask })
    this.draw(this.down.fb, w, h)
    return this.downReader.request(this.down.fb, w, h, { w, h, factor, step: this.step })
  }

  /** Downsampled fields finished since the last call: (δρ, ux, uy, solid) per texel. */
  collectFields(): { w: number; h: number; factor: number; step: number; data: Float32Array }[] {
    return this.downReader.collect().map(({ tag, data }) => ({ ...tag, data }))
  }

  /** The whole state, synchronously (tests only: it stalls the GPU). */
  readState(): { drho: Float32Array; ux: Float32Array; uy: Float32Array; f: Float32Array[] } {
    const gl = this.gl
    const { nx, ny } = this.params
    const cur = this.sets[0]
    const read = (attachment: number) => {
      const out = new Float32Array(nx * ny * 4)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cur.fb)
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment)
      gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, out)
      return out
    }
    const a = read(0)
    const b = read(1)
    const c = read(2)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    const n = nx * ny
    const drho = new Float32Array(n)
    const ux = new Float32Array(n)
    const uy = new Float32Array(n)
    const f = Array.from({ length: 9 }, () => new Float32Array(n))
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        f[k][i] = a[4 * i + k]
        f[k + 4][i] = b[4 * i + k]
      }
      f[8][i] = c[4 * i]
      drho[i] = c[4 * i + 1]
      ux[i] = c[4 * i + 2]
      uy[i] = c[4 * i + 3]
    }
    return { drho, ux, uy, f }
  }

  /** Add the current state to the time averages. */
  accumulate(): void {
    const gl = this.gl
    const p = this.accumProgram
    gl.useProgram(p.program)
    bindTextures(gl, p, { uC: this.sets[0].c, uSum: this.sums[0].tex })
    this.draw(this.sums[1].fb, this.params.nx, this.params.ny)
    this.sums.reverse()
    this.meanSamples++
  }

  /** The time averages start again. */
  resetMean(): void {
    const gl = this.gl
    for (const s of this.sums) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb)
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.meanSamples = 0
  }

  /**
   * The sums of (δρ, ux, uy, samples) per cell, read back through a pixel-pack
   * buffer and a fence (no stall); null if the context is lost meanwhile.
   */
  async readMean(): Promise<Float32Array | null> {
    const gl = this.gl
    const { nx, ny } = this.params
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, nx * ny * 16, gl.STREAM_READ)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sums[0].fb)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, 0)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
    gl.flush()
    while (true) {
      await new Promise((r) => setTimeout(r, 8))
      if (gl.isContextLost()) return null
      const status = gl.clientWaitSync(fence, 0, 0)
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
    }
    const data = new Float32Array(nx * ny * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.deleteSync(fence)
    gl.deleteBuffer(buffer)
    return data
  }

  /** Back to a fluid at rest, step 0 (R: "Ricomincia"). */
  restart(): void {
    const gl = this.gl
    for (const set of this.sets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, set.fb)
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
      gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0])
      gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0])
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.reader.collect()
    this.downReader.collect()
    this.resetMean()
    this.step = 0
  }

  dispose(): void {
    const gl = this.gl
    this.reader.dispose()
    this.downReader.dispose()
    for (const s of this.sets) {
      gl.deleteFramebuffer(s.fb)
      gl.deleteTexture(s.a)
      gl.deleteTexture(s.b)
      gl.deleteTexture(s.c)
    }
    for (const l of this.levels) {
      gl.deleteFramebuffer(l.fb)
      gl.deleteTexture(l.s)
      gl.deleteTexture(l.t)
      gl.deleteTexture(l.u)
    }
    if (this.readout) {
      gl.deleteFramebuffer(this.readout.fb)
      gl.deleteTexture(this.readout.tex)
    }
    if (this.down) {
      gl.deleteFramebuffer(this.down.fb)
      gl.deleteTexture(this.down.tex)
    }
    if (this.cellsTexture) gl.deleteTexture(this.cellsTexture)
    for (const s of this.sums) {
      gl.deleteFramebuffer(s.fb)
      gl.deleteTexture(s.tex)
    }
    gl.deleteTexture(this.mask)
    gl.deleteTexture(this.spareMask)
    gl.deleteVertexArray(this.vao)
    for (const p of [this.stepProgram, this.remaskProgram, this.forcesProgram, this.reduceProgram, this.readoutProgram, this.downProgram, this.accumProgram])
      gl.deleteProgram(p.program)
  }
}
