// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D solver's compute shaders (SPEC §24.3), in WGSL, written out from the
// lattice constants of lattice3d.generated.ts (which come from
// backend/gdv/lattice3d.py): one source for the numbers. The algorithm is the
// reference solver's (tests/reference/lbm3d.py) and must stay so -- test 39
// compares the two. The sums of the moments and of the relaxation run over the
// nonzero entries of M and M⁻¹ in the same order as there.
//
// State: two storage buffers of populations (deviations from the rest
// weights, post-collision), ping-ponged, laid out direction by direction:
// f[k * n + cell] with cell = x + nx * (y + ny * z). The body is a bit mask,
// 32 cells to a word.
import { C, M, MINV, MIRROR, OPPOSITE, Q, S_E, S_EPS, S_M, S_PI, S_Q, W } from './lattice3d.generated'
import { wgslFloat } from './gpu'

/** Threads per workgroup of every kernel. */
export const WORKGROUP = 128

const cx = (k: number) => C[3 * k]
const cy = (k: number) => C[3 * k + 1]
const cz = (k: number) => C[3 * k + 2]
const f = wgslFloat

/** The rows of M that relax (density and momentum are conserved). */
const RELAXED = Array.from({ length: Q }, (_, r) => r).filter((r) => ![0, 3, 5, 7].includes(r))

/** a·x + b·y + ... over the nonzero coefficients, in order; ±1 written as a sign. */
function sum(terms: [number, string][]): string {
  let out = ''
  for (const [v, name] of terms) {
    if (v === 0) continue
    const neg = v < 0
    const a = Math.abs(v)
    const term = a === 1 ? name : `${f(a)} * ${name}`
    out += out === '' ? (neg ? `-${term}` : term) : neg ? ` - ${term}` : ` + ${term}`
  }
  return out || '0.0'
}

/** The uniforms every kernel reads (one 256-byte slot per step for the step kernel). */
export const PARAMS = `
struct Params {
  nx: u32, ny: u32, nz: u32, n: u32,
  rowStride: u32, ground: u32, spongeStart: u32, count: u32,
  tau0: f32, u: f32, spongeFactor: f32, damping: f32,
  smag: f32, pad0: f32, pad1: f32, pad2: f32,
}
`

/** Byte size of Params, and the stride of its per-step slots. */
export const PARAMS_SIZE = 64
export const PARAMS_STRIDE = 256

const SOLID = `
fn solid(c: u32) -> bool { return (mask[c >> 5u] & (1u << (c & 31u))) != 0u; }
`

function feqLines(): string {
  // feq − w for every direction, as the reference's _feq_dev (same operations).
  const lines: string[] = []
  lines.push('fn feq(k: u32, drho: f32, ux: f32, uy: f32, uz: f32) -> f32 {')
  lines.push('  let rho = 1.0 + drho;')
  lines.push('  let c = CV[k];')
  lines.push('  let cu = c.x * ux + c.y * uy + c.z * uz;')
  lines.push('  let uu = ux * ux + uy * uy + uz * uz;')
  lines.push('  return WK[k] * (drho + rho * (3.0 * cu + 4.5 * cu * cu - 1.5 * uu));')
  lines.push('}')
  return lines.join('\n')
}

const TABLES = `
const CV = array<vec3<f32>, ${Q}>(${Array.from({ length: Q }, (_, k) => `vec3<f32>(${f(cx(k))}, ${f(cy(k))}, ${f(cz(k))})`).join(', ')});
const WK = array<f32, ${Q}>(${Array.from(W, (v) => f(v)).join(', ')});
`

/** The gather of direction k from the post-collision state, with every boundary. */
function gather(k: number): string {
  if (k === 0) return '  let g0 = src[cell];'
  const [ax, ay, az] = [cx(k), cy(k), cz(k)]
  const opp = `src[${OPPOSITE[k]}u * n + cell]`
  const L: string[] = [`  var g${k}: f32;`, '  {']
  L.push(`    var sx = x - (${ax});`)
  if (ax === -1) L.push('    if (sx > nx - 1) { sx = nx - 1; }')
  L.push(`    var sy = y - (${ay});`)
  L.push(`    var sz = z - (${az});`)
  let indent = '    '
  if (az === 1) {
    // The source is below: the floor, when there is one.
    const moving = ax !== 0 ? ` if (P.ground == 2u) { v += ${f(Math.fround(6 * W[k]) * ax)} * P.u; }` : ''
    L.push(`    if (sz < 0 && P.ground != 0u) { var v = ${opp};${moving} g${k} = v; } else {`)
    indent = '      '
  }
  const flips: string[] = []
  if (ay !== 0) flips.push(`${indent}if (sy < 0 || sy >= ny) { fl = fl | 1u; sy = y; }`)
  if (az !== 0) flips.push(`${indent}if (sz < 0 || sz >= nz) { fl = fl | 2u; sz = z; }`)
  if (flips.length) L.push(`${indent}var fl = 0u;`, ...flips)
  L.push(`${indent}let s = u32(sx + nx * (sy + ny * sz));`)
  L.push(`${indent}if (solid(s)) { g${k} = ${opp}; } else {`)
  if (flips.length) {
    const options = [1, 2, 3].filter((fl) => (fl & 1 ? ay !== 0 : true) && (fl & 2 ? az !== 0 : true))
    L.push(`${indent}  var kk = ${k}u;`)
    for (const fl of options) L.push(`${indent}  if (fl == ${fl}u) { kk = ${MIRROR[4 * k + fl]}u; }`)
    L.push(`${indent}  g${k} = src[kk * n + s];`)
  } else {
    L.push(`${indent}  g${k} = src[${k}u * n + s];`)
  }
  L.push(`${indent}}`)
  if (az === 1) L.push('    }')
  L.push('  }')
  return L.join('\n')
}

function moments(): string {
  const lines: string[] = []
  for (let r = 0; r < Q; r++) {
    const terms: [number, string][] = []
    for (let k = 0; k < Q; k++) terms.push([M[r * Q + k], `g${k}`])
    lines.push(`  let m${r} = ${sum(terms)};`)
  }
  return lines.join('\n')
}

function relax(): string {
  const lines: string[] = []
  for (let k = 0; k < Q; k++) {
    const terms: [number, string][] = RELAXED.map((r) => [MINV[k * Q + r], `d${r}`])
    lines.push(`  var o${k} = g${k} - (${sum(terms)});`)
  }
  return lines.join('\n')
}

/** One fused stream (pull) + collide step with every boundary. */
export function stepShader(): string {
  const all = (fn: (k: number) => string) => Array.from({ length: Q }, (_, k) => fn(k)).join('\n')
  return `${PARAMS}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read> inlet: array<f32>;
${TABLES}
${SOLID}
${feqLines()}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x + gid.y * P.rowStride;
  let n = P.n;
  if (cell >= n) { return; }
  let nx = i32(P.nx);
  let ny = i32(P.ny);
  let nz = i32(P.nz);
  let x = i32(cell % P.nx);
  let t = cell / P.nx;
  let y = i32(t % P.ny);
  let z = i32(t / P.ny);
  if (solid(cell)) {
${all((k) => `    dst[${k}u * n + cell] = 0.0;`)}
    return;
  }
  if (x == 0) {
    var drho = 0.0;
    if (!solid(cell + 1u)) {
${all((k) => `      drho += src[${k}u * n + cell + 1u];`)}
    }
    let ux = P.u * inlet[z];
    for (var k = 0u; k < ${Q}u; k++) { dst[k * n + cell] = feq(k, drho, ux, 0.0, 0.0); }
    return;
  }
  // --- stream (pull) with the boundaries ---
${all(gather)}
  // --- collide (MRT + Smagorinsky) ---
${moments()}
  let drho = m0;
  let jx = m3;
  let jy = m5;
  let jz = m7;
  let rho = 1.0 + drho;
  let jj = (jx * jx + jy * jy + jz * jz) / rho;
  let eEq = -11.0 * drho + 19.0 * jj;
  let epsEq = 3.0 * drho - 5.5 * jj;
  let xxEq = (2.0 * jx * jx - jy * jy - jz * jz) / rho;
  let wwEq = (jy * jy - jz * jz) / rho;
  let xyEq = jx * jy / rho;
  let yzEq = jy * jz / rho;
  let xzEq = jx * jz / rho;
  var t0 = P.tau0;
  var sponge = 0.0;
  if (u32(x) >= P.spongeStart) {
    sponge = f32(u32(x) - P.spongeStart) / f32(P.nx - 1u - P.spongeStart);
    t0 = 0.5 + (P.tau0 - 0.5) * (1.0 + (P.spongeFactor - 1.0) * sponge);
  }
  var tau = t0;
  if (P.smag > 0.0) {
    let tr = (m1 - eEq) / 19.0;
    let pxx = (m9 - xxEq + tr) * ${f(Math.fround(1 / 3))};
    let pww = m11 - wwEq;
    let pyy = 0.5 * (tr - pxx + pww);
    let pzz = 0.5 * (tr - pxx - pww);
    let pxy = m13 - xyEq;
    let pyz = m14 - yzEq;
    let pxz = m15 - xzEq;
    let qq = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pyz * pyz + pxz * pxz));
    tau = 0.5 * (t0 + sqrt(t0 * t0 + P.smag * qq / rho));
  }
  let sNu = 1.0 / tau;
  let d1 = ${f(S_E)} * (m1 - eEq);
  let d2 = ${f(S_EPS)} * (m2 - epsEq);
  let d4 = ${f(S_Q)} * (m4 + ${f(Math.fround(2 / 3))} * jx);
  let d6 = ${f(S_Q)} * (m6 + ${f(Math.fround(2 / 3))} * jy);
  let d8 = ${f(S_Q)} * (m8 + ${f(Math.fround(2 / 3))} * jz);
  let d9 = sNu * (m9 - xxEq);
  let d10 = ${f(S_PI)} * (m10 + 0.5 * xxEq);
  let d11 = sNu * (m11 - wwEq);
  let d12 = ${f(S_PI)} * (m12 + 0.5 * wwEq);
  let d13 = sNu * (m13 - xyEq);
  let d14 = sNu * (m14 - yzEq);
  let d15 = sNu * (m15 - xzEq);
  let d16 = ${f(S_M)} * m16;
  let d17 = ${f(S_M)} * m17;
  let d18 = ${f(S_M)} * m18;
${relax()}
  if (sponge > 0.0 && P.damping > 0.0) {
    // Absorbing layer: part of the way to the undisturbed stream's equilibrium.
    let sig = P.damping * sponge;
    let ut = P.u * inlet[z];
    let ux = jx / rho;
    let uy = jy / rho;
    let uz = jz / rho;
${all((k) => `    o${k} += sig * (feq(${k}u, 0.0, ut, 0.0, 0.0) - feq(${k}u, drho, ux, uy, uz));`)}
  }
${all((k) => `  dst[${k}u * n + cell] = o${k};`)}
}
`
}

/** Records of the reduction: three vec4 each (see measureShader). */
export const RECORD_BYTES = 48

const REDUCE_TREE = `
  wa[li] = a;
  wb[li] = b;
  wc[li] = c;
  workgroupBarrier();
  for (var s = ${WORKGROUP / 2}u; s > 0u; s = s >> 1u) {
    if (li < s) {
      wa[li] = wa[li] + wa[li + s];
      wc[li] = wc[li] + wc[li + s];
      let o = wb[li + s];
      let m = wb[li];
      wb[li] = vec4<f32>(min(m.x, o.x), max(m.y, o.y), m.z + o.z, m.w + o.w);
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let w = wid.x + wid.y * nwg.x;
    out[3u * w] = wa[0];
    out[3u * w + 1u] = wb[0];
    out[3u * w + 2u] = wc[0];
  }
`

const SHARED = `
var<workgroup> wa: array<vec4<f32>, ${WORKGROUP}>;
var<workgroup> wb: array<vec4<f32>, ${WORKGROUP}>;
var<workgroup> wc: array<vec4<f32>, ${WORKGROUP}>;
`

const REDUCE_ARGS = `@builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>`

/**
 * Per-cell terms of the measurement (SPEC §9.5, §24.3), reduced per workgroup:
 * momentum exchange on the body links, NaNs, the density range of the fluid
 * and the density of plane x = 1 (the undisturbed ρ∞).
 *   a = (Fx, Fy, Fz, NaN count)   b = (min ρ, max ρ, Σρ plane 1, cells plane 1)
 *   c = (Σ 2 w_k c_k over the same links, 0)
 * c is what a fluid at rest with unit density would push on the body: zero
 * for a body surrounded by fluid, not for one standing on the floor, whose
 * underside is not wetted. The force relative to the undisturbed pressure is
 * a − ρ∞ c (SPEC §9.5).
 */
export function measureShader(): string {
  const links: string[] = []
  for (let k = 1; k < Q; k++) {
    const conds: string[] = []
    const [ax, ay, az] = [cx(k), cy(k), cz(k)]
    if (ax === 1) conds.push('x + 1 < nx')
    if (ax === -1) conds.push('x > 0')
    if (ay === 1) conds.push('y + 1 < ny')
    if (ay === -1) conds.push('y > 0')
    if (az === 1) conds.push('z + 1 < nz')
    if (az === -1) conds.push('z > 0')
    const offset = `${ax} + nx * (${ay} + ny * (${az}))`
    links.push(
      `    if (${conds.join(' && ')}) { if (solid(u32(i32(cell) + ${offset}))) { force += 2.0 * (${f(W[k])} + g${k}) * CV[${k}]; rest += ${f(2 * W[k])} * CV[${k}]; } }`,
    )
  }
  return `${PARAMS}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(5) var<storage, read_write> out: array<vec4<f32>>;
${TABLES}
${SOLID}
${SHARED}
fn bad(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u; }

@compute @workgroup_size(${WORKGROUP})
fn main(${REDUCE_ARGS}) {
  let cell = gid.x + gid.y * P.rowStride;
  let n = P.n;
  var a = vec4<f32>(0.0);
  var b = vec4<f32>(1e30, -1e30, 0.0, 0.0);
  var c = vec4<f32>(0.0);
  if (cell < n && !solid(cell)) {
    let nx = i32(P.nx);
    let ny = i32(P.ny);
    let nz = i32(P.nz);
    let x = i32(cell % P.nx);
    let t = cell / P.nx;
    let y = i32(t % P.ny);
    let z = i32(t / P.ny);
${Array.from({ length: Q }, (_, k) => `    let g${k} = src[${k}u * n + cell];`).join('\n')}
    let rho = 1.0 + (${Array.from({ length: Q }, (_, k) => `g${k}`).join(' + ')});
    var force = vec3<f32>(0.0);
    var rest = vec3<f32>(0.0);
${links.join('\n')}
    c = vec4<f32>(rest, 0.0);
    if (bad(rho)) {
      a = vec4<f32>(0.0, 0.0, 0.0, 1.0);
      b = vec4<f32>(1.0, 1.0, 0.0, 0.0);
    } else {
      a = vec4<f32>(force, 0.0);
      let on = select(0.0, 1.0, x == 1);
      b = vec4<f32>(rho, rho, on * rho, on);
    }
  }
${REDUCE_TREE}
}
`
}

/** One level of the reduction: WORKGROUP records into one. */
export function reduceShader(): string {
  return `${PARAMS}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> out: array<vec4<f32>>;
${SHARED}
@compute @workgroup_size(${WORKGROUP})
fn main(${REDUCE_ARGS}) {
  let i = gid.x + gid.y * P.rowStride;
  var a = vec4<f32>(0.0);
  var b = vec4<f32>(1e30, -1e30, 0.0, 0.0);
  var c = vec4<f32>(0.0);
  if (i < P.count) {
    a = inp[3u * i];
    b = inp[3u * i + 1u];
    c = inp[3u * i + 2u];
  }
${REDUCE_TREE}
}
`
}
