// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the flow looks like (SPEC §10.6), all on the GPU: a background field
// (speed, pressure coefficient or vorticity, through a colour-map texture),
// smoke from a rake of nozzles advected semi-Lagrangian, and tracer particles
// advected with RK2 leaving a fading trail. Streamlines and every line (the
// body outline, probes) are drawn by the page on a 2D canvas above.
//
// Coordinates: the view maps canvas pixels to cells with an origin and a
// scale (cells per pixel); cell (i, j) covers [i, i+1) × [j, j+1).
import { bindTextures, framebuffer, program, texture, upload, type Program } from './gl'
import { lut, type ColorMap } from './colormaps'
import type { Solver } from './solver'

export type FieldMode = 'speed' | 'pressure' | 'vorticity'

export type ViewOptions = {
  field: FieldMode
  smoke: boolean
  particles: boolean
  /** Colour-scale range, in the units of the field (lattice speed, Cp, lattice vorticity). */
  range: [number, number]
  /** Undisturbed density and lattice speed: the Cp normalisation. */
  rhoInf: number
  uLat: number
}

export type Transform = { originX: number; originY: number; cellsPerPixel: number }

const SAMPLE = `
vec4 cellAt(ivec2 q) { return texelFetch(uC, clamp(q, ivec2(0), uSize - 1), 0); }
bool solidAt(ivec2 q) { return texelFetch(uMask, clamp(q, ivec2(0), uSize - 1), 0).r > 0.0; }
// Bilinear between cell centres; solid cells count as fluid at rest.
vec4 bilinear(vec2 g) {
  vec2 h = g - 0.5;
  ivec2 i0 = ivec2(floor(h));
  vec2 w = h - floor(h);
  vec4 a = solidAt(i0) ? vec4(0.0) : cellAt(i0);
  vec4 b = solidAt(i0 + ivec2(1, 0)) ? vec4(0.0) : cellAt(i0 + ivec2(1, 0));
  vec4 c = solidAt(i0 + ivec2(0, 1)) ? vec4(0.0) : cellAt(i0 + ivec2(0, 1));
  vec4 d = solidAt(i0 + ivec2(1, 1)) ? vec4(0.0) : cellAt(i0 + ivec2(1, 1));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
`

const DISPLAY_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform sampler2D uLut;
uniform sampler2D uSmoke;
uniform sampler2D uTrail;
uniform ivec2 uSize;
uniform vec2 uOrigin;
uniform float uCellsPerPixel;
uniform int uField;        // 0 speed, 1 Cp, 2 vorticity
uniform vec2 uRange;
uniform float uRhoInf;
uniform float uULat;
uniform int uSmokeOn;
uniform int uParticlesOn;
uniform vec3 uBody;
uniform vec3 uOutside;
out vec4 oColor;
${SAMPLE}
void main() {
  vec2 g = (gl_FragCoord.xy - uOrigin) * uCellsPerPixel;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= float(uSize.x) || g.y >= float(uSize.y)) {
    oColor = vec4(uOutside, 1.0);
    return;
  }
  ivec2 p = ivec2(floor(g));
  if (solidAt(p)) {
    oColor = vec4(uBody, 1.0);
    return;
  }
  float value;
  if (uField == 0) {
    vec4 c = bilinear(g);
    value = length(c.zw);
  } else if (uField == 1) {
    vec4 c = bilinear(g);
    value = ((1.0 + c.y) - uRhoInf) / 3.0 / (0.5 * uRhoInf * uULat * uULat);
  } else {
    float dvdx = 0.5 * (cellAt(p + ivec2(1, 0)).w - cellAt(p - ivec2(1, 0)).w);
    float dudy = 0.5 * (cellAt(p + ivec2(0, 1)).z - cellAt(p - ivec2(0, 1)).z);
    value = dvdx - dudy;
  }
  float t = clamp((value - uRange.x) / max(uRange.y - uRange.x, 1e-12), 0.0, 1.0);
  vec3 color = texture(uLut, vec2(t * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
  vec2 uv = g / vec2(uSize);
  if (uSmokeOn == 1) {
    float s = clamp(texture(uSmoke, uv).r, 0.0, 1.0);
    color = mix(color, vec3(0.97), 0.9 * smoothstep(0.0, 0.6, s));
  }
  // Tracers show on a dimmed field: added on a bright colour they would vanish.
  if (uParticlesOn == 1) color = color * 0.4 + texture(uTrail, uv).rgb;
  oColor = vec4(min(color, vec3(1.0)), 1.0);
}
`

const SMOKE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform sampler2D uSmoke;
uniform ivec2 uSize;
uniform float uSteps;
uniform float uNozzleX;
uniform float uNozzleR;
uniform int uNozzles;
uniform float uNozzleY[32];
out vec4 oColor;
${SAMPLE}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solidAt(p)) { oColor = vec4(0.0); return; }
  vec2 g = vec2(p) + 0.5;
  vec2 u = cellAt(p).zw;
  // Back-trace in two halves (midpoint), then sample the old smoke there.
  vec2 mid = g - 0.5 * uSteps * u;
  vec2 back = g - uSteps * bilinear(mid).zw;
  float s = texture(uSmoke, back / vec2(uSize)).r * 0.9998;
  for (int k = 0; k < 32; k++) {
    if (k >= uNozzles) break;
    vec2 d = g - vec2(uNozzleX, uNozzleY[k]);
    s = max(s, exp(-dot(d, d) / (uNozzleR * uNozzleR)));
  }
  oColor = vec4(s, 0.0, 0.0, 1.0);
}
`

const PARTICLES_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform sampler2D uState;
uniform ivec2 uSize;
uniform float uSteps;
uniform float uSeed;
out vec4 oState;
${SAMPLE}
float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, id, 0);
  vec2 pos = s.xy;
  float age = s.z + 1.0;
  float life = s.w;
  bool dead = life <= 0.0 || age > life;
  if (!dead) {
    vec2 u1 = bilinear(pos).zw;
    vec2 u2 = bilinear(pos + 0.5 * uSteps * u1).zw;
    pos += uSteps * u2;
    dead = pos.x < 0.0 || pos.y < 0.0 || pos.x >= float(uSize.x) || pos.y >= float(uSize.y)
      || solidAt(ivec2(floor(pos)));
  }
  if (dead) {
    vec2 r = vec2(hash(vec2(id) + 0.17), hash(vec2(id.yx) + 3.1));
    pos = r * vec2(uSize);
    age = 0.0;
    life = 120.0 + 240.0 * hash(vec2(id) * 1.7 + 9.0);
  }
  oState = vec4(pos, age, life);
}
`

const POINTS_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uState;
uniform int uSide;
uniform ivec2 uSize;
out float vFade;
void main() {
  vec4 s = texelFetch(uState, ivec2(gl_VertexID % uSide, gl_VertexID / uSide), 0);
  vec2 clip = s.xy / vec2(uSize) * 2.0 - 1.0;
  vFade = s.w > 0.0 ? clamp(min(s.z, s.w - s.z) / 20.0, 0.0, 1.0) : 0.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

const POINTS_FS = `#version 300 es
precision highp float;
uniform float uIntensity;
in float vFade;
out vec4 oColor;
void main() { oColor = vec4(vec3(uIntensity) * vFade, 1.0); }
`

const FADE_FS = `#version 300 es
precision highp float;
out vec4 oColor;
void main() { oColor = vec4(0.0); }
`

/** Each frame the particle trail keeps this fraction of its brightness. */
const TRAIL_FADE = 0.88

/** Rake of smoke nozzles (SPEC §10.6): count and position in cells. */
export type Rake = { x: number; ys: number[]; radius: number }

export function defaultRake(nx: number, ny: number, count = 15): Rake {
  const ys = Array.from({ length: count }, (_, k) => ((k + 0.5) / count) * ny)
  return { x: Math.max(2, nx * 0.02), ys, radius: Math.max(1, ny / 150) }
}

export function hex3(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

export class FlowView {
  private readonly display: Program
  private readonly smokeProgram: Program
  private readonly particleProgram: Program
  private readonly pointsProgram: Program
  private readonly fadeProgram: Program
  private readonly vao: WebGLVertexArrayObject
  private lutTexture: WebGLTexture
  private smoke: { tex: WebGLTexture; fb: WebGLFramebuffer }[]
  private particles: { tex: WebGLTexture; fb: WebGLFramebuffer }[]
  private trail: { tex: WebGLTexture; fb: WebGLFramebuffer }
  private readonly side: number
  private seed = 0
  rake: Rake
  body = hex3('#c9ced8')
  outside = hex3('#111111')

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly nx: number,
    readonly ny: number,
    particleCount = 100_000,
  ) {
    this.display = program(gl, DISPLAY_FS)
    this.smokeProgram = program(gl, SMOKE_FS)
    this.particleProgram = program(gl, PARTICLES_FS)
    this.pointsProgram = program(gl, POINTS_FS, POINTS_VS)
    this.fadeProgram = program(gl, FADE_FS)
    this.vao = gl.createVertexArray()!
    this.lutTexture = texture(gl, 256, 1, 'rgba8', lut('viridis'), true)
    const smoke = () => {
      const tex = texture(gl, nx, ny, 'r16f', null, true)
      return { tex, fb: framebuffer(gl, [tex]) }
    }
    this.smoke = [smoke(), smoke()]
    this.side = Math.ceil(Math.sqrt(particleCount))
    const state = () => {
      const tex = texture(gl, this.side, this.side, 'rgba32f')
      return { tex, fb: framebuffer(gl, [tex]) }
    }
    this.particles = [state(), state()]
    const trail = texture(gl, nx, ny, 'rgba16f', null, true)
    this.trail = { tex: trail, fb: framebuffer(gl, [trail]) }
    this.rake = defaultRake(nx, ny)
  }

  setColorMap(map: ColorMap): void {
    upload(this.gl, this.lutTexture, 256, 1, 'rgba8', lut(map))
  }

  private draw(fb: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Move smoke and particles by the flow of the last `steps` steps. */
  advance(solver: Solver, steps: number, smokeOn: boolean, particlesOn: boolean): void {
    const gl = this.gl
    const size: [number, number] = [this.nx, this.ny]
    const state = solver.current
    if (smokeOn) {
      const p = this.smokeProgram
      gl.useProgram(p.program)
      gl.uniform2i(p.uniform('uSize'), ...size)
      gl.uniform1f(p.uniform('uSteps'), steps)
      gl.uniform1f(p.uniform('uNozzleX'), this.rake.x)
      gl.uniform1f(p.uniform('uNozzleR'), this.rake.radius)
      const ys = this.rake.ys.slice(0, 32)
      gl.uniform1i(p.uniform('uNozzles'), ys.length)
      const padded = new Float32Array(32)
      padded.set(ys)
      gl.uniform1fv(p.uniform('uNozzleY[0]'), padded)
      bindTextures(gl, p, { uC: state.c, uMask: solver.maskTexture, uSmoke: this.smoke[0].tex })
      this.draw(this.smoke[1].fb, this.nx, this.ny)
      this.smoke.reverse()
    }
    if (particlesOn) {
      const p = this.particleProgram
      gl.useProgram(p.program)
      gl.uniform2i(p.uniform('uSize'), ...size)
      gl.uniform1f(p.uniform('uSteps'), steps)
      gl.uniform1f(p.uniform('uSeed'), (this.seed = (this.seed + 0.6180339887) % 1000))
      bindTextures(gl, p, { uC: state.c, uMask: solver.maskTexture, uState: this.particles[0].tex })
      this.draw(this.particles[1].fb, this.side, this.side)
      this.particles.reverse()
      // The trail fades, then the particles are added on top.
      gl.enable(gl.BLEND)
      gl.blendColor(0, 0, 0, TRAIL_FADE)
      gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA)
      gl.useProgram(this.fadeProgram.program)
      this.draw(this.trail.fb, this.nx, this.ny)
      gl.blendFunc(gl.ONE, gl.ONE)
      const q = this.pointsProgram
      gl.useProgram(q.program)
      gl.uniform1i(q.uniform('uSide'), this.side)
      // A particle leaves about 1 / (1 - fade) lit cells behind it: the mean
      // brightness is particles per cell × intensity / (1 - fade), kept near 0.2
      // whatever the grid, and a single trail stays visible (at least 0.08).
      const perCell = (this.side * this.side) / (this.nx * this.ny)
      gl.uniform1f(q.uniform('uIntensity'), Math.max(0.08, Math.min(0.5, (0.2 * (1 - TRAIL_FADE)) / Math.max(perCell, 1e-6))))
      gl.uniform2i(q.uniform('uSize'), ...size)
      bindTextures(gl, q, { uState: this.particles[0].tex })
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail.fb)
      gl.viewport(0, 0, this.nx, this.ny)
      gl.bindVertexArray(this.vao)
      gl.drawArrays(gl.POINTS, 0, this.side * this.side)
      gl.disable(gl.BLEND)
    }
  }

  /** Clear smoke, particles and trail (a new flow). */
  clear(): void {
    const gl = this.gl
    for (const t of [...this.smoke, ...this.particles, this.trail]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb)
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Draw the view into `fb` (null = the canvas) of size w × h pixels. */
  render(solver: Solver, options: ViewOptions, transform: Transform, fb: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl
    const p = this.display
    gl.useProgram(p.program)
    gl.uniform2i(p.uniform('uSize'), this.nx, this.ny)
    gl.uniform2f(p.uniform('uOrigin'), transform.originX, transform.originY)
    gl.uniform1f(p.uniform('uCellsPerPixel'), transform.cellsPerPixel)
    gl.uniform1i(p.uniform('uField'), { speed: 0, pressure: 1, vorticity: 2 }[options.field])
    gl.uniform2f(p.uniform('uRange'), options.range[0], options.range[1])
    gl.uniform1f(p.uniform('uRhoInf'), options.rhoInf)
    gl.uniform1f(p.uniform('uULat'), options.uLat)
    gl.uniform1i(p.uniform('uSmokeOn'), options.smoke ? 1 : 0)
    gl.uniform1i(p.uniform('uParticlesOn'), options.particles ? 1 : 0)
    gl.uniform3f(p.uniform('uBody'), ...this.body)
    gl.uniform3f(p.uniform('uOutside'), ...this.outside)
    bindTextures(gl, p, {
      uC: solver.current.c,
      uMask: solver.maskTexture,
      uLut: this.lutTexture,
      uSmoke: this.smoke[0].tex,
      uTrail: this.trail.tex,
    })
    this.draw(fb, w, h)
  }

  dispose(): void {
    const gl = this.gl
    for (const t of [...this.smoke, ...this.particles, this.trail]) {
      gl.deleteFramebuffer(t.fb)
      gl.deleteTexture(t.tex)
    }
    gl.deleteTexture(this.lutTexture)
    gl.deleteVertexArray(this.vao)
    for (const p of [this.display, this.smokeProgram, this.particleProgram, this.pointsProgram, this.fadeProgram]) gl.deleteProgram(p.program)
  }
}
