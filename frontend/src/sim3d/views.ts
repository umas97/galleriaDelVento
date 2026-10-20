// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's views on the GPU (SPEC §24.2 #3, §24.3): the pipelines of
// viewShaders.ts and what they work on -- the field texture, tracers, smoke
// filaments, the model's buffers, the colour maps -- and the passes of a
// frame: the field from the populations, the tracers moved, then the picture.
import { C, Q } from './lattice3d.generated'
import { shaderModule } from './gpu'
import type { Solver3D } from './solver'
import type { BodyMesh } from './scene'
import { lut, type DivergingMap, type SequentialMap } from '../sim2d/colormaps'
import {
  FRAME_BYTES,
  VIEW_WORKGROUP,
  fieldShader,
  floorShader,
  lineShader,
  meshShader,
  particleRenderShader,
  particleShader,
  planeShader,
  probeShader,
  smokeRenderShader,
  smokeShader,
} from './viewShaders'

export const SAMPLE_COUNT = 4
export const PARTICLES = 50_000
/** Points per smoke filament: one per frame of moving flow. */
export const SMOKE_POINTS = 384
export const MAX_NOZZLES = 48
const MAX_PROBES = 12_000

type Grid = { nx: number; ny: number; nz: number }

/** What a frame's picture is drawn with (the uniforms of viewShaders.ts). */
export type FrameUniforms = {
  viewProj: Float32Array
  model: Float32Array
  normal: Float32Array
  eye: [number, number, number]
  dx: number
  uLat: number
  rhoInf: number
  /** Real speed per lattice speed, V / u_lat. */
  speedScale: number
  plane: { axis: number; position: number; field: 'speed' | 'cp'; shown: boolean }
  planeRange: [number, number]
  surfaceRange: [number, number]
  speedRange: [number, number]
  surfaceCp: boolean
  floorShift: number
  ground: 'none' | 'fixed' | 'moving'
  colors: { body: number[]; floor: number[]; line: number[]; smoke: number[] }
  smokeHead: number
  nozzles: number
  smoke: boolean
  particles: boolean
  /** Particle tails, in time steps. */
  tail: number
  /** Lines and dots are this many pixels wide (2 on the screen; more on a large snapshot). */
  scale: number
}

export type Target = { color: GPUTextureView; resolve: GPUTextureView; depth: GPUTextureView; width: number; height: number }

/** Storage buffers the page writes (read when used: GPUBufferUsage exists only with WebGPU). */
const storage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST

export class Views3D {
  private readonly frame: GPUBuffer
  private readonly gridUniform: GPUBuffer
  private readonly particleUniform: GPUBuffer
  private readonly smokeUniform: GPUBuffer
  private readonly probeUniform: GPUBuffer
  private readonly sampler: GPUSampler
  private readonly lutTexture: GPUTexture
  private readonly particles: GPUBuffer
  private readonly smoke: GPUBuffer
  private readonly nozzles: GPUBuffer
  private readonly probeIn: GPUBuffer
  private readonly probeOut: GPUBuffer
  private readonly probeRead: GPUBuffer
  private probeBusy = false
  private lines: GPUBuffer | null = null
  private lineCount = 0
  private mesh: { position: GPUBuffer; normal: GPUBuffer; index: GPUBuffer; count: number } | null = null
  private grid: Grid | null = null
  private field: GPUTexture
  private mask: GPUBuffer
  private renderGroup!: GPUBindGroup
  private fieldGroup: GPUBindGroup | null = null
  private particleGroup!: GPUBindGroup
  private smokeGroup!: GPUBindGroup
  private probeGroup!: GPUBindGroup
  private fieldSource: GPUBuffer | null = null
  private seed = 1
  private readonly data = new ArrayBuffer(FRAME_BYTES)

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: Pipelines,
  ) {
    this.frame = device.createBuffer({ label: 'vista', size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const small = (label: string) => device.createBuffer({ label, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.gridUniform = small('griglia')
    this.particleUniform = small('particelle')
    this.smokeUniform = small('fumo')
    this.probeUniform = small('sonde')
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' })
    this.lutTexture = device.createTexture({ label: 'mappe', size: [256, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.particles = device.createBuffer({ label: 'particelle', size: 16 * PARTICLES, usage: storage() })
    this.smoke = device.createBuffer({ label: 'fumo', size: 16 * SMOKE_POINTS * MAX_NOZZLES, usage: storage() })
    this.nozzles = device.createBuffer({ label: 'ugelli', size: 16 * MAX_NOZZLES, usage: storage() })
    this.probeIn = device.createBuffer({ label: 'punti', size: 16 * MAX_PROBES, usage: storage() })
    this.probeOut = device.createBuffer({ label: 'campioni', size: 16 * MAX_PROBES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    this.probeRead = device.createBuffer({ label: 'lettura campioni', size: 16 * MAX_PROBES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    // Until the first case: a one-cell field and an empty mask keep every bind group valid.
    this.field = this.makeField({ nx: 1, ny: 1, nz: 1 })
    this.mask = device.createBuffer({ label: 'maschera vuota', size: 16, usage: storage() })
    this.resetTracers()
    this.bind()
  }

  static async create(device: GPUDevice, format: GPUTextureFormat): Promise<Views3D> {
    return new Views3D(device, await makePipelines(device, format))
  }

  private makeField(g: Grid): GPUTexture {
    return this.device.createTexture({
      label: 'campo',
      size: [g.nx, g.ny, g.nz],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    })
  }

  private bind(): void {
    const d = this.device
    const p = this.pipelines
    const fieldView = this.field.createView()
    this.renderGroup = d.createBindGroup({
      layout: p.renderLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frame } },
        { binding: 1, resource: fieldView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.lutTexture.createView() },
        { binding: 4, resource: { buffer: this.mask } },
        { binding: 5, resource: { buffer: this.particles } },
        { binding: 6, resource: { buffer: this.smoke } },
      ],
    })
    const advect = (uniform: GPUBuffer, store: GPUBuffer, layout: GPUBindGroupLayout, extra: GPUBindGroupEntry[] = []) =>
      d.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: fieldView },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: { buffer: this.mask } },
          { binding: 4, resource: { buffer: store } },
          ...extra,
        ],
      })
    this.particleGroup = advect(this.particleUniform, this.particles, p.particleLayout)
    this.smokeGroup = advect(this.smokeUniform, this.smoke, p.smokeLayout, [{ binding: 5, resource: { buffer: this.nozzles } }])
    this.probeGroup = d.createBindGroup({
      layout: p.probeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.probeUniform } },
        { binding: 1, resource: fieldView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.probeIn } },
        { binding: 4, resource: { buffer: this.probeOut } },
      ],
    })
    this.fieldGroup = null
  }

  /** A new grid (a new case): the field texture, the solver's mask, tracers from scratch. */
  setGrid(grid: Grid, solver: Solver3D): void {
    if (!this.grid || this.grid.nx !== grid.nx || this.grid.ny !== grid.ny || this.grid.nz !== grid.nz) {
      this.field.destroy()
      this.field = this.makeField(grid)
    }
    this.grid = { ...grid }
    this.mask = solver.maskBuffer
    this.fieldSource = null
    const u = new Uint32Array([grid.nx, grid.ny, grid.nz, grid.nx * grid.ny * grid.nz])
    this.device.queue.writeBuffer(this.gridUniform, 0, u)
    this.resetTracers()
    this.bind()
  }

  /** Tracers and filaments all waiting to be born. */
  resetTracers(): void {
    const dead = new Float32Array(4 * PARTICLES)
    for (let i = 3; i < dead.length; i += 4) dead[i] = -1
    this.device.queue.writeBuffer(this.particles, 0, dead)
    this.resetSmoke()
  }

  resetSmoke(): void {
    const dead = new Float32Array(4 * SMOKE_POINTS * MAX_NOZZLES)
    for (let i = 3; i < dead.length; i += 4) dead[i] = -1
    this.device.queue.writeBuffer(this.smoke, 0, dead)
  }

  setNozzles(cells: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.nozzles, 0, cells, 0, Math.min(cells.length, 4 * MAX_NOZZLES))
    this.resetSmoke()
  }

  setMaps(sequential: SequentialMap, diverging: DivergingMap): void {
    const data = new Uint8Array(256 * 4 * 2)
    data.set(lut(sequential), 0)
    data.set(lut(diverging), 256 * 4)
    this.device.queue.writeTexture({ texture: this.lutTexture }, data, { bytesPerRow: 256 * 4 }, [256, 2])
  }

  setBody(body: BodyMesh | null): void {
    if (this.mesh) for (const b of [this.mesh.position, this.mesh.normal, this.mesh.index]) b.destroy()
    this.mesh = null
    if (!body || !body.indices.length) return
    const d = this.device
    const upload = (label: string, data: Float32Array | Uint32Array, usage: number) => {
      const b = d.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength)
      return b
    }
    this.mesh = {
      position: upload('modello', body.positions, GPUBufferUsage.VERTEX),
      normal: upload('normali', body.normals, GPUBufferUsage.VERTEX),
      index: upload('triangoli', body.indices, GPUBufferUsage.INDEX),
      count: body.indices.length,
    }
  }

  /** Line segments (chamber edges, rake): (x, y, z, accent) per vertex, metres. */
  setLines(vertices: Float32Array<ArrayBuffer>): void {
    if (this.lines && this.lines.size < vertices.byteLength) {
      this.lines.destroy()
      this.lines = null
    }
    this.lines ??= this.device.createBuffer({ label: 'linee', size: Math.max(256, vertices.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(this.lines, 0, vertices)
    this.lineCount = vertices.length / 4
  }

  /** The field from the solver's current state. */
  updateField(encoder: GPUCommandEncoder, solver: Solver3D): void {
    const g = this.grid
    if (!g) return
    const source = solver.current
    if (!this.fieldGroup || this.fieldSource !== source) {
      this.fieldGroup = this.device.createBindGroup({
        layout: this.pipelines.fieldLayout,
        entries: [
          { binding: 0, resource: { buffer: this.gridUniform } },
          { binding: 1, resource: { buffer: source } },
          { binding: 2, resource: { buffer: this.mask } },
          { binding: 3, resource: this.field.createView() },
        ],
      })
      this.fieldSource = source
    }
    const pass = encoder.beginComputePass({ label: 'campo' })
    pass.setPipeline(this.pipelines.field)
    pass.setBindGroup(0, this.fieldGroup)
    pass.dispatchWorkgroups(Math.ceil(g.nx / VIEW_WORKGROUP), g.ny, g.nz)
    pass.end()
  }

  /** Tracers and filaments moved by `steps` time steps of the current field. */
  advect(encoder: GPUCommandEncoder, steps: number, what: { particles: boolean; smoke: boolean; smokeHead: number; nozzles: number }): void {
    const g = this.grid
    if (!g || steps <= 0) return
    const write = (buffer: GPUBuffer, count: number, head: number, per: number) => {
      const data = new ArrayBuffer(32)
      new Float32Array(data, 0, 4).set([g.nx, g.ny, g.nz, steps])
      new Uint32Array(data, 16, 4).set([count, head, per, (this.seed = (this.seed * 1664525 + 1013904223) >>> 0)])
      this.device.queue.writeBuffer(buffer, 0, data)
    }
    const pass = encoder.beginComputePass({ label: 'traccianti' })
    if (what.particles) {
      write(this.particleUniform, PARTICLES, 0, 1)
      pass.setPipeline(this.pipelines.particles)
      pass.setBindGroup(0, this.particleGroup)
      pass.dispatchWorkgroups(Math.ceil(PARTICLES / VIEW_WORKGROUP))
    }
    if (what.smoke && what.nozzles > 0) {
      const count = what.nozzles * SMOKE_POINTS
      write(this.smokeUniform, count, what.smokeHead, SMOKE_POINTS)
      pass.setPipeline(this.pipelines.smoke)
      pass.setBindGroup(0, this.smokeGroup)
      pass.dispatchWorkgroups(Math.ceil(count / VIEW_WORKGROUP))
    }
    pass.end()
  }

  private writeFrame(f: FrameUniforms, target: Target): void {
    const fl = new Float32Array(this.data)
    fl.set(f.viewProj, 0)
    fl.set(f.model, 16)
    fl.set(f.normal, 32)
    const g = this.grid ?? { nx: 1, ny: 1, nz: 1 }
    const q = 0.5 * f.rhoInf * f.uLat * f.uLat
    const rows: number[][] = [
      [...f.eye, 1],
      [g.nx, g.ny, g.nz, f.dx],
      [f.uLat, f.rhoInf - 1, q, f.speedScale],
      [f.plane.axis, f.plane.position, f.plane.field === 'cp' ? 1 : 0, f.plane.shown ? 1 : 0],
      [...f.planeRange, ...f.surfaceRange],
      [target.width, target.height, f.floorShift, f.surfaceCp ? 1 : 0],
      f.colors.body,
      [...f.colors.floor.slice(0, 3), f.ground === 'moving' ? 2 : f.ground === 'fixed' ? 1 : 0],
      f.colors.line,
      f.colors.smoke,
      [SMOKE_POINTS, f.smokeHead, f.nozzles, 2 * f.scale],
      [PARTICLES, 1.5 * f.scale, f.tail, 18 * f.scale],
      [...f.speedRange, 0, 0],
    ]
    rows.forEach((r, i) => fl.set(r, 48 + 4 * i))
    this.device.queue.writeBuffer(this.frame, 0, this.data)
  }

  /** The picture: opaque body, floor and plane first, then lines, filaments and tracers blended over. */
  render(encoder: GPUCommandEncoder, target: Target, f: FrameUniforms, background: [number, number, number]): void {
    this.writeFrame(f, target)
    const p = this.pipelines
    const pass = encoder.beginRenderPass({
      label: 'immagine',
      colorAttachments: [
        {
          view: target.color,
          resolveTarget: target.resolve,
          clearValue: { r: background[0], g: background[1], b: background[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: { view: target.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    })
    pass.setBindGroup(0, this.renderGroup)
    const hasGrid = this.grid !== null
    if (hasGrid && f.ground !== 'none') {
      pass.setPipeline(p.floor)
      pass.draw(6)
    }
    if (this.mesh) {
      pass.setPipeline(p.mesh)
      pass.setVertexBuffer(0, this.mesh.position)
      pass.setVertexBuffer(1, this.mesh.normal)
      pass.setIndexBuffer(this.mesh.index, 'uint32')
      pass.drawIndexed(this.mesh.count)
    }
    if (hasGrid && f.plane.shown) {
      pass.setPipeline(p.plane)
      pass.draw(6)
    }
    if (this.lines && this.lineCount) {
      pass.setPipeline(p.lines)
      pass.setVertexBuffer(0, this.lines)
      pass.draw(this.lineCount)
    }
    if (hasGrid && f.smoke && f.nozzles > 0) {
      pass.setPipeline(p.smokeRender)
      pass.draw(6, f.nozzles * SMOKE_POINTS)
    }
    if (hasGrid && f.particles) {
      pass.setPipeline(p.particleRender)
      pass.draw(6, PARTICLES)
    }
    pass.end()
  }

  /**
   * The field at `points` (texture coordinates, vec4), read back without
   * stalling; null while a previous read is in flight.
   */
  probe(points: Float32Array<ArrayBuffer>): Promise<Float32Array> | null {
    if (this.probeBusy || !this.grid) return null
    const count = Math.min(MAX_PROBES, points.length / 4)
    if (!count) return null
    const d = this.device
    d.queue.writeBuffer(this.probeIn, 0, points, 0, 4 * count)
    d.queue.writeBuffer(this.probeUniform, 0, new Uint32Array([count, 0, 0, 0]))
    const encoder = d.createCommandEncoder({ label: 'sonde' })
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.probe)
    pass.setBindGroup(0, this.probeGroup)
    pass.dispatchWorkgroups(Math.ceil(count / VIEW_WORKGROUP))
    pass.end()
    encoder.copyBufferToBuffer(this.probeOut, 0, this.probeRead, 0, 16 * count)
    d.queue.submit([encoder.finish()])
    this.probeBusy = true
    return this.probeRead
      .mapAsync(GPUMapMode.READ, 0, 16 * count)
      .then(() => {
        const out = new Float32Array(this.probeRead.getMappedRange(0, 16 * count).slice(0))
        this.probeRead.unmap()
        return out
      })
      .finally(() => {
        this.probeBusy = false
      })
  }

  dispose(): void {
    this.setBody(null)
    for (const b of [this.frame, this.gridUniform, this.particleUniform, this.smokeUniform, this.probeUniform, this.particles, this.smoke, this.nozzles, this.probeIn, this.probeOut, this.probeRead])
      b.destroy()
    this.lines?.destroy()
    this.field.destroy()
    this.lutTexture.destroy()
  }
}

type Pipelines = {
  renderLayout: GPUBindGroupLayout
  fieldLayout: GPUBindGroupLayout
  particleLayout: GPUBindGroupLayout
  smokeLayout: GPUBindGroupLayout
  probeLayout: GPUBindGroupLayout
  field: GPUComputePipeline
  particles: GPUComputePipeline
  smoke: GPUComputePipeline
  probe: GPUComputePipeline
  mesh: GPURenderPipeline
  plane: GPURenderPipeline
  floor: GPURenderPipeline
  lines: GPURenderPipeline
  particleRender: GPURenderPipeline
  smokeRender: GPURenderPipeline
}

async function makePipelines(device: GPUDevice, format: GPUTextureFormat): Promise<Pipelines> {
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
  const CS = GPUShaderStage.COMPUTE
  const buffer = (binding: number, visibility: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } })
  const texture3d = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    texture: { sampleType: 'float', viewDimension: '3d' },
  })
  const sampler = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({ binding, visibility, sampler: { type: 'filtering' } })
  const renderLayout = device.createBindGroupLayout({
    label: 'vista',
    entries: [
      buffer(0, VF, 'uniform'),
      texture3d(1, VF),
      sampler(2, VF),
      { binding: 3, visibility: VF, texture: { sampleType: 'float', viewDimension: '2d' } },
      buffer(4, VF, 'read-only-storage'),
      buffer(5, VF, 'read-only-storage'),
      buffer(6, VF, 'read-only-storage'),
    ],
  })
  const fieldLayout = device.createBindGroupLayout({
    label: 'campo',
    entries: [
      buffer(0, CS, 'uniform'),
      buffer(1, CS, 'read-only-storage'),
      buffer(2, CS, 'read-only-storage'),
      { binding: 3, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
    ],
  })
  const advectEntries = [buffer(0, CS, 'uniform'), texture3d(1, CS), sampler(2, CS), buffer(3, CS, 'read-only-storage'), buffer(4, CS, 'storage')]
  const particleLayout = device.createBindGroupLayout({ label: 'particelle', entries: advectEntries })
  const smokeLayout = device.createBindGroupLayout({ label: 'fumo', entries: [...advectEntries, buffer(5, CS, 'read-only-storage')] })
  const probeLayout = device.createBindGroupLayout({
    label: 'sonde',
    entries: [buffer(0, CS, 'uniform'), texture3d(1, CS), sampler(2, CS), buffer(3, CS, 'read-only-storage'), buffer(4, CS, 'storage')],
  })

  const compute = async (label: string, code: string, layout: GPUBindGroupLayout) =>
    device.createComputePipelineAsync({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: await shaderModule(device, label, code), entryPoint: 'main' },
    })
  const renderPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [renderLayout] })
  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  }
  const render = async (
    label: string,
    code: string,
    o: { buffers?: GPUVertexBufferLayout[]; topology?: GPUPrimitiveTopology; blended?: boolean } = {},
  ) => {
    const module = await shaderModule(device, label, code)
    return device.createRenderPipelineAsync({
      label,
      layout: renderPipelineLayout,
      vertex: { module, entryPoint: 'vs', buffers: o.buffers ?? [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: o.blended ? blend : undefined }] },
      primitive: { topology: o.topology ?? 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: !o.blended, depthCompare: 'less' },
      multisample: { count: SAMPLE_COUNT },
    })
  }
  const vec3 = (location: number): GPUVertexBufferLayout => ({ arrayStride: 12, attributes: [{ shaderLocation: location, offset: 0, format: 'float32x3' }] })
  const [field, particles, smoke, probe, mesh, plane, floor, lines, particleRender, smokeRender] = await Promise.all([
    compute('campo', fieldShader(Q, C), fieldLayout),
    compute('particelle', particleShader(), particleLayout),
    compute('fumo', smokeShader(), smokeLayout),
    compute('sonde', probeShader(), probeLayout),
    render('modello', meshShader(), { buffers: [vec3(0), vec3(1)] }),
    render('piano', planeShader()),
    render('pavimento', floorShader()),
    render('linee', lineShader(), {
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      topology: 'line-list',
      blended: true,
    }),
    render('particelle', particleRenderShader(), { blended: true }),
    render('fumo', smokeRenderShader(), { blended: true }),
  ])
  return {
    renderLayout,
    fieldLayout,
    particleLayout,
    smokeLayout,
    probeLayout,
    field,
    particles,
    smoke,
    probe,
    mesh,
    plane,
    floor,
    lines,
    particleRender,
    smokeRender,
  }
}
