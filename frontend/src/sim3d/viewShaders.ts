// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's views in WGSL (SPEC §24.2 #3, §24.3 «Resa»): a small
// renderer of its own, no new dependency.
//
// - `fieldShader`: the populations → one rgba16float 3D texture per frame,
//   (ux, uy, uz, δρ) per cell, lattice units. Every view samples it with the
//   hardware's trilinear filter. A solid cell has no velocity; its δρ is the
//   mean of its fluid face neighbours, so that the pressure sampled at the
//   wall does not fall to zero halfway into the body.
// - `particleShader`, `smokeShader`: tracers and the smoke filaments (points
//   emitted by the rake's nozzles, one per frame, as streaklines), moved by
//   RK2 through that field.
// - `probeShader`: the field at a list of points, read back for the colour
//   ranges (as in 2D: 2nd–98th percentile).
// - The render pipelines: the model (shaded, or coloured by Cp sampled just
//   off its surface), the cut plane, the floor, the chamber's edges and the
//   rake, the particles and the filaments.
//
// Positions in the compute shaders are in cells (metres / Δx: cell i spans
// [i, i + 1), its centre at i + 0.5); a texture coordinate is that over the
// grid size. The render shaders work in chamber metres.

/** Bytes of the render uniforms (struct Frame). */
export const FRAME_BYTES = 400

/** Threads per workgroup of the view kernels. */
export const VIEW_WORKGROUP = 64

const FRAME = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>,
  model: mat4x4<f32>,
  normal: mat4x4<f32>,
  eye: vec4<f32>,
  // nx, ny, nz, dx
  grid: vec4<f32>,
  // u_lat, δρ∞, ½ ρ∞ u_lat², real speed per lattice speed
  flow: vec4<f32>,
  // axis (0 x, 1 y, 2 z), position (m), field (0 speed, 1 Cp), shown
  plane: vec4<f32>,
  // plane range, surface Cp range
  ranges: vec4<f32>,
  // width and height in pixels, floor shift (cells), surface Cp shown
  screen: vec4<f32>,
  bodyColor: vec4<f32>,
  // rgb, ground (0 none, 1 fixed, 2 moving)
  floorColor: vec4<f32>,
  lineColor: vec4<f32>,
  smokeColor: vec4<f32>,
  // points per nozzle, head, nozzles, width (px)
  smoke: vec4<f32>,
  // count, width (px), tail (steps), longest tail (px)
  particles: vec4<f32>,
  // the speed range of the tracers (m/s), 0, 0
  speedRange: vec4<f32>,
}
@group(0) @binding(0) var<uniform> F: Frame;
`

const SOLID = /* wgsl */ `
fn solidAt(c: vec3<f32>, n: vec3<f32>) -> bool {
  let i = vec3<u32>(clamp(floor(c), vec3<f32>(0.0), n - 1.0));
  let k = i.x + u32(n.x) * (i.y + u32(n.y) * i.z);
  return (mask[k >> 5u] & (1u << (k & 31u))) != 0u;
}
`

const COLOR = /* wgsl */ `
/** Colour map row 0 (sequential) or 1 (diverging) at t in [0, 1]. */
fn mapColor(t: f32, row: i32) -> vec3<f32> {
  let i = i32(clamp(t, 0.0, 1.0) * 255.0 + 0.5);
  return textureLoad(lut, vec2<i32>(i, row), 0).rgb;
}
fn unit(v: f32, lo: f32, hi: f32) -> f32 {
  return (v - lo) / max(hi - lo, 1e-12);
}
fn cpOf(drho: f32) -> f32 {
  return (drho - F.flow.y) / 3.0 / F.flow.z;
}
`

/** Populations → the field texture. */
export function fieldShader(q: number, c: readonly number[]): string {
  const sums = Array.from({ length: q }, (_, k) => {
    const v = (a: number) => c[3 * k + a]
    const terms = [`d += g;`]
    for (let a = 0; a < 3; a++) {
      const comp = ['x', 'y', 'z'][a]
      if (v(a) === 1) terms.push(`j.${comp} += g;`)
      if (v(a) === -1) terms.push(`j.${comp} -= g;`)
    }
    return `    { let g = src[${k}u * n + cell]; ${terms.join(' ')} }`
  }).join('\n')
  return /* wgsl */ `
struct Grid { nx: u32, ny: u32, nz: u32, n: u32 }
@group(0) @binding(0) var<uniform> G: Grid;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var field: texture_storage_3d<rgba16float, write>;

fn solid(c: u32) -> bool { return (mask[c >> 5u] & (1u << (c & 31u))) != 0u; }

fn density(cell: u32) -> f32 {
  let n = G.n;
  var d = 0.0;
  for (var k = 0u; k < ${q}u; k++) { d += src[k * n + cell]; }
  return d;
}

@compute @workgroup_size(${VIEW_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= G.nx) { return; }
  let n = G.n;
  let cell = gid.x + G.nx * (gid.y + G.ny * gid.z);
  if (!solid(cell)) {
    var d = 0.0;
    var j = vec3<f32>(0.0);
${sums}
    textureStore(field, gid, vec4<f32>(j / (1.0 + d), d));
    return;
  }
  // A solid cell: the mean density of its fluid face neighbours (0 deep inside).
  var sum = 0.0;
  var count = 0.0;
  let x = gid.x;
  let y = gid.y;
  let z = gid.z;
  let row = G.nx;
  let plane = G.nx * G.ny;
  if (x > 0u && !solid(cell - 1u)) { sum += density(cell - 1u); count += 1.0; }
  if (x + 1u < G.nx && !solid(cell + 1u)) { sum += density(cell + 1u); count += 1.0; }
  if (y > 0u && !solid(cell - row)) { sum += density(cell - row); count += 1.0; }
  if (y + 1u < G.ny && !solid(cell + row)) { sum += density(cell + row); count += 1.0; }
  if (z > 0u && !solid(cell - plane)) { sum += density(cell - plane); count += 1.0; }
  if (z + 1u < G.nz && !solid(cell + plane)) { sum += density(cell + plane); count += 1.0; }
  textureStore(field, gid, vec4<f32>(0.0, 0.0, 0.0, select(0.0, sum / count, count > 0.0)));
}
`
}

const ADVECT_COMMON = /* wgsl */ `
struct Advect {
  // nx, ny, nz, steps of this frame
  grid: vec4<f32>,
  // count, head slot, points per nozzle, seed
  info: vec4<u32>,
}
@group(0) @binding(0) var<uniform> A: Advect;
@group(0) @binding(1) var fieldTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> mask: array<u32>;

fn velocity(p: vec3<f32>) -> vec3<f32> {
  return textureSampleLevel(fieldTex, samp, p / A.grid.xyz, 0.0).xyz;
}
/** Midpoint (RK2) step over the frame's time steps. */
fn advance(p: vec3<f32>) -> vec3<f32> {
  let s = A.grid.w;
  let mid = p + 0.5 * s * velocity(p);
  return p + s * velocity(mid);
}
fn outside(p: vec3<f32>) -> bool {
  return any(p < vec3<f32>(0.0)) || any(p >= A.grid.xyz);
}
${SOLID}
`

const HASH = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand(a: u32, b: u32) -> f32 {
  return f32(pcg(a ^ pcg(b)) & 0xffffffu) / 16777216.0;
}
`

/** Lifetime of particle i, in frames of a moving flow (as in 2D: 120 to 360). */
const LIFE = /* wgsl */ `
fn life(i: u32) -> f32 { return 120.0 + 240.0 * rand(i, 977u); }
`

/** Tracers: age in w (frames; negative = waiting for a fluid cell to be born in). */
export function particleShader(): string {
  return /* wgsl */ `
${ADVECT_COMMON}
@group(0) @binding(4) var<storage, read_write> particles: array<vec4<f32>>;
${HASH}
${LIFE}
@compute @workgroup_size(${VIEW_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= A.info.x) { return; }
  var q = particles[i];
  var reborn = q.w < 0.0 || q.w > life(i);
  if (!reborn) {
    let p = advance(q.xyz);
    reborn = outside(p) || solidAt(p, A.grid.xyz);
    q = vec4<f32>(p, q.w + 1.0);
  }
  if (reborn) {
    let s = A.info.w;
    let p = vec3<f32>(rand(i, s), rand(i, s + 1u), rand(i, s + 2u)) * A.grid.xyz;
    q = vec4<f32>(p, select(0.0, -1.0, solidAt(p, A.grid.xyz)));
  }
  particles[i] = q;
}
`
}

/** Smoke: per nozzle a ring of points; the head slot gets a new point at the nozzle. */
export function smokeShader(): string {
  return /* wgsl */ `
${ADVECT_COMMON}
@group(0) @binding(4) var<storage, read_write> points: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> nozzles: array<vec4<f32>>;

@compute @workgroup_size(${VIEW_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= A.info.x) { return; }
  let per = A.info.z;
  let slot = i % per;
  if (slot == A.info.y) {
    points[i] = vec4<f32>(nozzles[i / per].xyz, 1.0);
    return;
  }
  var q = points[i];
  if (q.w < 0.0) { return; }
  var p = advance(q.xyz);
  if (solidAt(p, A.grid.xyz)) {
    // Against the body: slide along its faces, one axis at a time, as smoke
    // spreads over a wall instead of vanishing into it.
    let d = p - q.xyz;
    p = q.xyz;
    for (var a = 0u; a < 3u; a++) {
      var c = p;
      c[a] = c[a] + d[a];
      if (!solidAt(c, A.grid.xyz)) { p = c; }
    }
  }
  if (outside(p)) {
    points[i] = vec4<f32>(q.xyz, -1.0);
  } else {
    points[i] = vec4<f32>(p, 1.0);
  }
}
`
}

/** The field at points given as texture coordinates. */
export function probeShader(): string {
  return /* wgsl */ `
struct Probe { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> P: Probe;
@group(0) @binding(1) var fieldTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> at: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> out: array<vec4<f32>>;

@compute @workgroup_size(${VIEW_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.count) { return; }
  out[gid.x] = textureSampleLevel(fieldTex, samp, at[gid.x].xyz, 0.0);
}
`
}

// --- render ------------------------------------------------------------------------

const RENDER_BINDINGS = /* wgsl */ `
${FRAME}
@group(0) @binding(1) var fieldTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var lut: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> mask: array<u32>;
@group(0) @binding(5) var<storage, read> particles: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> smokePoints: array<vec4<f32>>;
${COLOR}
${SOLID}
fn sampleAt(world: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(fieldTex, samp, world / F.grid.w / F.grid.xyz, 0.0);
}
/** Headlight shading of a two-sided surface. */
fn shade(n: vec3<f32>, world: vec3<f32>) -> f32 {
  let v = normalize(F.eye.xyz - world);
  return abs(dot(normalize(n), v));
}
/** Clip position of a point that the quad of a line of width w (px) expands from. */
fn ribbon(a: vec4<f32>, b: vec4<f32>, corner: u32, width: f32) -> vec4<f32> {
  // corner 0..5: two triangles over (a, b) with offsets −1/+1 across the line.
  var ends = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  var sides = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let end = ends[corner];
  let p = select(a, b, end == 1u);
  let size = F.screen.xy;
  let sa = a.xy / a.w * size;
  let sb = b.xy / b.w * size;
  var d = sb - sa;
  if (dot(d, d) < 1e-6) { d = vec2<f32>(1.0, 0.0); }
  let across = normalize(vec2<f32>(-d.y, d.x));
  let offset = across * sides[corner] * width / size;
  return vec4<f32>(p.xy + offset * p.w, p.zw);
}
const HIDDEN = vec4<f32>(0.0, 0.0, 2.0, 1.0);
`

export function meshShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
struct MeshOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
}
@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>) -> MeshOut {
  var out: MeshOut;
  let w = F.model * vec4<f32>(p, 1.0);
  out.pos = F.viewProj * w;
  out.world = w.xyz;
  out.normal = (F.normal * vec4<f32>(n, 0.0)).xyz;
  return out;
}
@fragment
fn fs(in: MeshOut) -> @location(0) vec4<f32> {
  let light = shade(in.normal, in.world);
  if (F.screen.w > 0.5) {
    // Cp just off the surface, along the outward normal: the field's cells next to the wall.
    let n = normalize(in.normal);
    let s = sampleAt(in.world + n * 0.75 * F.grid.w);
    let c = mapColor(unit(cpOf(s.w), F.ranges.z, F.ranges.w), 1);
    return vec4<f32>(c * (0.55 + 0.45 * light), 1.0);
  }
  return vec4<f32>(F.bodyColor.rgb * (0.3 + 0.7 * light), 1.0);
}
`
}

export function planeShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
struct PlaneOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> PlaneOut {
  var cu = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
  var cv = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  let size = F.grid.xyz * F.grid.w;
  let u = cu[i];
  let v = cv[i];
  var w = vec3<f32>(0.0);
  let axis = u32(F.plane.x);
  if (axis == 0u) { w = vec3<f32>(F.plane.y, u * size.y, v * size.z); }
  else if (axis == 1u) { w = vec3<f32>(u * size.x, F.plane.y, v * size.z); }
  else { w = vec3<f32>(u * size.x, v * size.y, F.plane.y); }
  var out: PlaneOut;
  out.pos = F.viewProj * vec4<f32>(w, 1.0);
  out.world = w;
  return out;
}
@fragment
fn fs(in: PlaneOut) -> @location(0) vec4<f32> {
  let c = in.world / F.grid.w;
  if (solidAt(c, F.grid.xyz)) {
    // The body as the flow sees it: whole cells.
    return vec4<f32>(F.bodyColor.rgb * 0.55, 1.0);
  }
  let s = sampleAt(in.world);
  if (F.plane.z < 0.5) {
    let speed = length(s.xyz) * F.flow.w;
    return vec4<f32>(mapColor(unit(speed, F.ranges.x, F.ranges.y), 0), 1.0);
  }
  return vec4<f32>(mapColor(unit(cpOf(s.w), F.ranges.x, F.ranges.y), 1), 1.0);
}
`
}

export function floorShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
struct FloorOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) cell: vec2<f32>,
}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> FloorOut {
  var cu = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
  var cv = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  let size = F.grid.xyz * F.grid.w;
  let w = vec3<f32>(cu[i] * size.x, cv[i] * size.y, 0.0);
  var out: FloorOut;
  out.pos = F.viewProj * vec4<f32>(w, 1.0);
  out.cell = w.xy / F.grid.w;
  return out;
}
@fragment
fn fs(in: FloorOut) -> @location(0) vec4<f32> {
  // Lines every 8 cells; on the moving floor the cross lines travel with the belt.
  let along = fract((in.cell.x - F.screen.z) / 8.0);
  let across = fract(in.cell.y / 8.0);
  let w = fwidth(in.cell) / 8.0;
  let lx = 1.0 - smoothstep(0.0, 1.5 * w.x, min(along, 1.0 - along));
  var ly = 1.0 - smoothstep(0.0, 1.5 * w.y, min(across, 1.0 - across));
  if (F.floorColor.w > 1.5) { ly = 0.0; }
  let line = max(lx, ly);
  return vec4<f32>(mix(F.floorColor.rgb, F.lineColor.rgb, 0.5 * line), 1.0);
}
`
}

export function lineShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
struct LineOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}
@vertex
fn vs(@location(0) p: vec4<f32>) -> LineOut {
  var out: LineOut;
  out.pos = F.viewProj * vec4<f32>(p.xyz, 1.0);
  out.color = select(F.lineColor, F.smokeColor, p.w > 0.5);
  return out;
}
@fragment
fn fs(in: LineOut) -> @location(0) vec4<f32> {
  return in.color;
}
`
}

export function particleRenderShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
${HASH}
${LIFE}
struct DotOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}
@vertex
fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) i: u32) -> DotOut {
  var out: DotOut;
  let q = particles[i];
  if (q.w < 0.0) { out.pos = HIDDEN; return out; }
  let u = textureSampleLevel(fieldTex, samp, q.xyz / F.grid.xyz, 0.0).xyz;
  let head = F.viewProj * vec4<f32>(q.xyz * F.grid.w, 1.0);
  var tail = F.viewProj * vec4<f32>((q.xyz - u * F.particles.z) * F.grid.w, 1.0);
  if (head.w <= 0.0 || tail.w <= 0.0) { out.pos = HIDDEN; return out; }
  // Near the camera a tail would cover the view: at most F.particles.w pixels long.
  let pixels = distance(head.xy / head.w * F.screen.xy, tail.xy / tail.w * F.screen.xy) * 0.5;
  if (pixels > F.particles.w) { tail = mix(head, tail, F.particles.w / pixels); }
  out.pos = ribbon(tail, head, corner, F.particles.y);
  let speed = length(u) * F.flow.w;
  // Fade in and out over 15 frames of life.
  let fade = clamp(min(q.w, life(i) - q.w) / 15.0, 0.0, 1.0);
  out.color = vec4<f32>(mapColor(unit(speed, F.speedRange.x, F.speedRange.y), 0), 0.85 * fade);
  return out;
}
@fragment
fn fs(in: DotOut) -> @location(0) vec4<f32> {
  return in.color;
}
`
}

export function smokeRenderShader(): string {
  return /* wgsl */ `
${RENDER_BINDINGS}
struct SmokeOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) alpha: f32,
}
@vertex
fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) i: u32) -> SmokeOut {
  var out: SmokeOut;
  let per = u32(F.smoke.x);
  let head = u32(F.smoke.y);
  let slot = i % per;
  let base = i - slot;
  let older = base + (slot + per - 1u) % per;
  // The oldest point's predecessor is the newest: no segment between them.
  let age = (head + per - slot) % per;
  if (age == per - 1u) { out.pos = HIDDEN; return out; }
  let a = smokePoints[i];
  let b = smokePoints[older];
  let d = a.xyz - b.xyz;
  if (a.w < 0.0 || b.w < 0.0 || dot(d, d) > 36.0) { out.pos = HIDDEN; return out; }
  let ca = F.viewProj * vec4<f32>(a.xyz * F.grid.w, 1.0);
  let cb = F.viewProj * vec4<f32>(b.xyz * F.grid.w, 1.0);
  if (ca.w <= 0.0 || cb.w <= 0.0) { out.pos = HIDDEN; return out; }
  out.pos = ribbon(ca, cb, corner, F.smoke.w);
  out.alpha = F.smokeColor.a * (1.0 - f32(age) / f32(per));
  return out;
}
@fragment
fn fs(in: SmokeOut) -> @location(0) vec4<f32> {
  return vec4<f32>(F.smokeColor.rgb, in.alpha);
}
`
}
