// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Thin WebGL2 helpers for the solver and its views: no library (SPEC §4). Float
// render targets (EXT_color_buffer_float) are mandatory; without them the
// tunnel says so and the rest of the program keeps working (SPEC §3).

export class GpuUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'GpuUnsupported'
  }
}

export function createContext(canvas: HTMLCanvasElement | OffscreenCanvas, preserve = false): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: preserve,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null
  if (!gl) throw new GpuUnsupported('webgl2')
  if (!gl.getExtension('EXT_color_buffer_float')) throw new GpuUnsupported('EXT_color_buffer_float')
  return gl
}

/** Whether this browser can run the tunnel at all (checked before opening it). */
export function gpuSupport(): { ok: boolean; renderer: string } {
  try {
    const canvas = document.createElement('canvas')
    const gl = createContext(canvas)
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { ok: true, renderer }
  } catch {
    return { ok: false, renderer: '' }
  }
}

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export type Program = {
  program: WebGLProgram
  uniform: (name: string) => WebGLUniformLocation | null
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    const numbered = source
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n')
    throw new Error(`shader non compilato: ${log}\n${numbered}`)
  }
  return shader
}

export function program(gl: WebGL2RenderingContext, fragment: string, vertex = FULLSCREEN_VS): Program {
  const p = gl.createProgram()!
  const vs = compile(gl, gl.VERTEX_SHADER, vertex)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`programma non collegato: ${gl.getProgramInfoLog(p)}`)
  const cache = new Map<string, WebGLUniformLocation | null>()
  return {
    program: p,
    uniform: (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(p, name))
      return cache.get(name)!
    },
  }
}

export type TextureFormat = 'rgba32f' | 'rg32f' | 'r32f' | 'r16f' | 'rgba16f' | 'r8' | 'rgba8'

const FORMATS: Record<TextureFormat, [number, number, number]> = {
  rgba32f: [WebGL2RenderingContext.RGBA32F, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.FLOAT],
  rg32f: [WebGL2RenderingContext.RG32F, WebGL2RenderingContext.RG, WebGL2RenderingContext.FLOAT],
  r32f: [WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED, WebGL2RenderingContext.FLOAT],
  r16f: [WebGL2RenderingContext.R16F, WebGL2RenderingContext.RED, WebGL2RenderingContext.HALF_FLOAT],
  rgba16f: [WebGL2RenderingContext.RGBA16F, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.HALF_FLOAT],
  r8: [WebGL2RenderingContext.R8, WebGL2RenderingContext.RED, WebGL2RenderingContext.UNSIGNED_BYTE],
  rgba8: [WebGL2RenderingContext.RGBA8, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE],
}

export function texture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: TextureFormat,
  data: ArrayBufferView | null = null,
  linear = false,
): WebGLTexture {
  const t = gl.createTexture()!
  const [internal, fmt, type] = FORMATS[format]
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, fmt, type, data)
  const filter = linear ? gl.LINEAR : gl.NEAREST
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

export function upload(
  gl: WebGL2RenderingContext,
  t: WebGLTexture,
  width: number,
  height: number,
  format: TextureFormat,
  data: ArrayBufferView,
): void {
  const [, fmt, type] = FORMATS[format]
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, fmt, type, data)
}

export function framebuffer(gl: WebGL2RenderingContext, targets: WebGLTexture[]): WebGLFramebuffer {
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  targets.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0))
  gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incompleto: 0x${status.toString(16)}`)
  return fb
}

/** Bind textures to units 0, 1, ... and their samplers by name. */
export function bindTextures(gl: WebGL2RenderingContext, p: Program, textures: Record<string, WebGLTexture>): void {
  Object.entries(textures).forEach(([name, t], unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.uniform1i(p.uniform(name), unit)
  })
}

/** GLSL text of a number, always with a decimal point. */
export function glslFloat(value: number): string {
  const text = String(value)
  return /[.e]/.test(text) ? text : `${text}.0`
}

/**
 * Reads a framebuffer region into memory without stalling the GPU: readPixels
 * into a pixel-pack buffer, a fence, and the data copied out on a later frame
 * once the fence has passed (SPEC §10.4). At most `count` reads in flight; a
 * request finding them all busy is dropped (the caller samples less often).
 *
 * Every read gets a buffer of its own, deleted once read: Chrome warns, once
 * per reuse, when a read-back buffer is written again (measured with both
 * clientWaitSync and getSyncParameter), and the reads are small or rare.
 */
export class AsyncReader<T> {
  private pending: { buffer: WebGLBuffer; fence: WebGLSync; tag: T; size: number }[] = []

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly count = 3,
  ) {}

  /** Start reading `width × height` RGBA floats from attachment 0 of `fb`. */
  request(fb: WebGLFramebuffer, width: number, height: number, tag: T, x = 0, y = 0): boolean {
    if (this.busy()) return false
    const gl = this.gl
    const size = width * height * 16
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(x, y, width, height, gl.RGBA, gl.FLOAT, 0)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
    this.pending.push({ buffer, fence, tag, size })
    return true
  }

  /** Every finished read since the last call, oldest first. */
  collect(): { tag: T; data: Float32Array }[] {
    const gl = this.gl
    const done: { tag: T; data: Float32Array }[] = []
    // Fences pass in order: stop at the first one still pending.
    while (this.pending.length) {
      const read = this.pending[0]
      const status = gl.clientWaitSync(read.fence, 0, 0)
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break
      this.pending.shift()
      const data = new Float32Array(read.size / 4)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      gl.deleteSync(read.fence)
      gl.deleteBuffer(read.buffer)
      done.push({ tag: read.tag, data })
    }
    return done
  }

  busy(): boolean {
    return this.pending.length >= this.count
  }

  dispose(): void {
    for (const read of this.pending) {
      this.gl.deleteSync(read.fence)
      this.gl.deleteBuffer(read.buffer)
    }
    this.pending = []
  }
}
