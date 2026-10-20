// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The solver's fragment shaders (SPEC §10). The lattice constants are pasted in
// from lattice.generated.ts, which comes from backend/gdv/lattice.py: one
// source for the numbers. The algorithm is the reference solver's
// (tests/reference/lbm2d.py) and must stay so -- test 25 compares the two.
//
// State: three RGBA32F textures per time level, ping-ponged:
//   A = (f0, f1, f2, f3)   B = (f4, f5, f6, f7)   C = (f8, δρ, ux, uy)
// populations as deviations from the rest weights, post-collision; C also
// carries the macroscopic values of the cell. The mask is R8: any value
// above zero is solid (a byte 1 reads as 1/255).
import { C, CS_SMAGORINSKY, M, MINV, MIRROR_Y, OPPOSITE, S_E, S_EPS, S_Q, W } from './lattice.generated'
import { glslFloat } from './gl'

const ints = (a: readonly number[]) => a.map((v) => String(Math.trunc(v))).join(', ')
const floats = (a: readonly number[]) => a.map(glslFloat).join(', ')

const LATTICE = `
const int CX[9] = int[9](${ints(C.filter((_, i) => i % 2 === 0))});
const int CY[9] = int[9](${ints(C.filter((_, i) => i % 2 === 1))});
const int OPP[9] = int[9](${ints(OPPOSITE)});
const int MIR[9] = int[9](${ints(MIRROR_Y)});
const float W[9] = float[9](${floats(W)});
const float M[81] = float[81](${floats(M)});
const float MINV[81] = float[81](${floats(MINV)});
const float S_E = ${glslFloat(S_E)};
const float S_EPS = ${glslFloat(S_EPS)};
const float S_Q = ${glslFloat(S_Q)};
const float CS_SMAGORINSKY = ${glslFloat(CS_SMAGORINSKY)};
`

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${LATTICE}
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform int uNx;
uniform int uNy;

bool solid(ivec2 p) { return texelFetch(uMask, p, 0).r > 0.0; }

float pop(ivec2 p, int k) {
  if (k < 4) return texelFetch(uA, p, 0)[k];
  if (k < 8) return texelFetch(uB, p, 0)[k - 4];
  return texelFetch(uC, p, 0).x;
}

float feq(int k, float drho, float ux, float uy) {
  float rho = 1.0 + drho;
  float cu = float(CX[k]) * ux + float(CY[k]) * uy;
  float uu = ux * ux + uy * uy;
  return W[k] * (drho + rho * (3.0 * cu + 4.5 * cu * cu - 1.5 * uu));
}
`

const OUTPUT3 = `
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;

void emit(float f[9], float drho, float ux, float uy) {
  oA = vec4(f[0], f[1], f[2], f[3]);
  oB = vec4(f[4], f[5], f[6], f[7]);
  oC = vec4(f[8], drho, ux, uy);
}
`

/** One fused stream (pull) + collide step with every boundary. */
export const STEP_FS = `${HEADER}${OUTPUT3}
uniform float uTau0;
uniform float uU;          // inlet speed now (ramped), lattice units
uniform int uGround;       // 0 none, 1 fixed, 2 moving
uniform int uBL;           // boundary-layer inlet
uniform float uRefCells;
uniform float uExp;
uniform int uSpongeStart;  // nx = no sponge
uniform float uSpongeFactor;
uniform float uDamping;
uniform float uCs;         // Smagorinsky constant, 0 = off

float inletU(int j) {
  float s = 1.0;
  if (uBL == 1) s = pow((float(j) + 0.5) / uRefCells, uExp);
  return uU * s;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float f[9];
  if (solid(p)) {
    for (int k = 0; k < 9; k++) f[k] = 0.0;
    emit(f, 0.0, 0.0, 0.0);
    return;
  }
  if (p.x == 0) {
    ivec2 q = ivec2(1, p.y);
    float drho = solid(q) ? 0.0 : texelFetch(uC, q, 0).y;
    float ux = inletU(p.y);
    for (int k = 0; k < 9; k++) f[k] = feq(k, drho, ux, 0.0);
    emit(f, drho, ux, 0.0);
    return;
  }
  vec4 a0 = texelFetch(uA, p, 0);
  vec4 b0 = texelFetch(uB, p, 0);
  vec4 c0 = texelFetch(uC, p, 0);
  float self[9] = float[9](a0.x, a0.y, a0.z, a0.w, b0.x, b0.y, b0.z, b0.w, c0.x);
  float g[9];
  for (int k = 0; k < 9; k++) {
    int sx = p.x - CX[k];
    int sy = p.y - CY[k];
    if (sx > uNx - 1) sx = uNx - 1;
    float v;
    if (sy < 0 || sy >= uNy) {
      if (sy < 0 && uGround != 0) {
        v = self[OPP[k]];
        if (uGround == 2) v += 6.0 * W[k] * float(CX[k]) * uU;
      } else if (solid(ivec2(sx, p.y))) {
        v = self[OPP[k]];
      } else {
        v = pop(ivec2(sx, p.y), MIR[k]);
      }
    } else if (solid(ivec2(sx, sy))) {
      v = self[OPP[k]];
    } else {
      v = pop(ivec2(sx, sy), k);
    }
    g[k] = v;
  }
  float m[9];
  for (int r = 0; r < 9; r++) {
    float acc = 0.0;
    for (int k = 0; k < 9; k++) acc += M[r * 9 + k] * g[k];
    m[r] = acc;
  }
  float drho = m[0];
  float jx = m[3];
  float jy = m[5];
  float rho = 1.0 + drho;
  float jj = (jx * jx + jy * jy) / rho;
  float eEq = -2.0 * drho + 3.0 * jj;
  float epsEq = drho - 3.0 * jj;
  float pxxEq = (jx * jx - jy * jy) / rho;
  float pxyEq = jx * jy / rho;
  float t0 = uTau0;
  float sponge = 0.0;
  if (p.x >= uSpongeStart) {
    sponge = float(p.x - uSpongeStart) / float(uNx - 1 - uSpongeStart);
    t0 = 0.5 + (uTau0 - 0.5) * (1.0 + (uSpongeFactor - 1.0) * sponge);
  }
  float tau = t0;
  if (uCs > 0.0) {
    float tr = (m[1] - eEq) / 3.0;
    float d = m[7] - pxxEq;
    float pxx = 0.5 * (tr + d);
    float pyy = 0.5 * (tr - d);
    float pxy = m[8] - pxyEq;
    float qq = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
    float smag = 18.0 * sqrt(2.0) * uCs * uCs;
    tau = 0.5 * (t0 + sqrt(t0 * t0 + smag * qq / rho));
  }
  float sNu = 1.0 / tau;
  float dm[9] = float[9](
    0.0,
    S_E * (m[1] - eEq),
    S_EPS * (m[2] - epsEq),
    0.0,
    S_Q * (m[4] + jx),
    0.0,
    S_Q * (m[6] + jy),
    sNu * (m[7] - pxxEq),
    sNu * (m[8] - pxyEq)
  );
  for (int k = 0; k < 9; k++) {
    float acc = 0.0;
    for (int r = 0; r < 9; r++) acc += MINV[k * 9 + r] * dm[r];
    f[k] = g[k] - acc;
  }
  float ux = jx / rho;
  float uy = jy / rho;
  if (sponge > 0.0 && uDamping > 0.0) {
    // Absorbing layer: part of the way to the undisturbed stream's equilibrium.
    float sig = uDamping * sponge;
    float ut = inletU(p.y);
    for (int k = 0; k < 9; k++) f[k] += sig * (feq(k, 0.0, ut, 0.0) - feq(k, drho, ux, uy));
    drho = drho - sig * drho;
    jx = jx + sig * (ut - jx);
    jy = jy - sig * jy;
    rho = 1.0 + drho;
    ux = jx / rho;
    uy = jy / rho;
  }
  emit(f, drho, ux, uy);
}
`

/**
 * A new body (SPEC §10.3): cells turned solid are zeroed; cells freed get the
 * equilibrium at the mean density and velocity of their neighbours that were
 * fluid; the rest is copied.
 */
export const REMASK_FS = `${HEADER}${OUTPUT3}
uniform sampler2D uNewMask;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float f[9];
  bool nowSolid = texelFetch(uNewMask, p, 0).r > 0.0;
  if (nowSolid) {
    for (int k = 0; k < 9; k++) f[k] = 0.0;
    emit(f, 0.0, 0.0, 0.0);
    return;
  }
  if (!solid(p)) {
    oA = texelFetch(uA, p, 0);
    oB = texelFetch(uB, p, 0);
    oC = texelFetch(uC, p, 0);
    return;
  }
  float n = 0.0;
  float sr = 0.0;
  float su = 0.0;
  float sv = 0.0;
  for (int k = 1; k < 9; k++) {
    ivec2 q = p + ivec2(CX[k], CY[k]);
    if (q.x < 0 || q.x >= uNx || q.y < 0 || q.y >= uNy || solid(q)) continue;
    vec4 c = texelFetch(uC, q, 0);
    n += 1.0;
    sr += c.y;
    su += c.z;
    sv += c.w;
  }
  float drho = 0.0;
  float ux = 0.0;
  float uy = 0.0;
  if (n > 0.0) {
    drho = sr / n;
    ux = su / n;
    uy = sv / n;
  }
  for (int k = 0; k < 9; k++) f[k] = feq(k, drho, ux, uy);
  emit(f, drho, ux, uy);
}
`

/**
 * Per-cell terms of the reduction (SPEC §10.4): momentum exchange on the body
 * links and its moment about uRef (cells), the density range of the fluid,
 * NaNs, and the density of column 1 (the undisturbed ρ∞).
 *   S = (Fx, Fy, Mz, NaN count)   T = (min ρ, max ρ, Σρ column 1, count column 1)
 *   U = (Σ 2 w_k c_k over the same links, and its moment, 0)
 * U is what a fluid at rest with unit density would push on the body: zero
 * for a body surrounded by fluid, not for one standing on the floor, whose
 * underside is not wetted. The forces relative to the undisturbed pressure
 * are S − ρ∞ U (SPEC §9.5).
 */
export const FORCES_FS = `${HEADER}
uniform vec2 uRef;
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oT;
layout(location = 2) out vec4 oU;

bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (solid(p)) {
    oS = vec4(0.0);
    oT = vec4(1e30, -1e30, 0.0, 0.0);
    oU = vec4(0.0);
    return;
  }
  vec4 c = texelFetch(uC, p, 0);
  float rho = 1.0 + c.y;
  float nan = (bad(rho) || bad(c.z) || bad(c.w)) ? 1.0 : 0.0;
  float r = nan > 0.0 ? 1.0 : rho;
  vec3 force = vec3(0.0);
  vec3 rest = vec3(0.0);
  for (int k = 1; k < 9; k++) {
    ivec2 q = p + ivec2(CX[k], CY[k]);
    if (q.x < 0 || q.x >= uNx || q.y < 0 || q.y >= uNy || !solid(q)) continue;
    vec2 ck = vec2(float(CX[k]), float(CY[k]));
    vec2 at = vec2(p) + 0.5 + 0.5 * ck - uRef;
    vec2 l = 2.0 * (W[k] + pop(p, k)) * ck;
    force += vec3(l, at.x * l.y - at.y * l.x);
    vec2 l0 = 2.0 * W[k] * ck;
    rest += vec3(l0, at.x * l0.y - at.y * l0.x);
  }
  if (nan > 0.0) force = vec3(0.0);
  oS = vec4(force, nan);
  oT = vec4(r, r, p.x == 1 ? r : 0.0, p.x == 1 ? 1.0 : 0.0);
  oU = vec4(rest, 0.0);
}
`

/** One level of the reduction pyramid: 4 × 4 blocks into one texel. */
export const REDUCE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uS;
uniform sampler2D uT;
uniform sampler2D uU;
uniform ivec2 uIn;
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oT;
layout(location = 2) out vec4 oU;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec4 s = vec4(0.0);
  vec4 t = vec4(1e30, -1e30, 0.0, 0.0);
  vec4 r = vec4(0.0);
  for (int dy = 0; dy < 4; dy++)
    for (int dx = 0; dx < 4; dx++) {
      ivec2 q = base + ivec2(dx, dy);
      if (q.x >= uIn.x || q.y >= uIn.y) continue;
      s += texelFetch(uS, q, 0);
      r += texelFetch(uU, q, 0);
      vec4 u = texelFetch(uT, q, 0);
      t = vec4(min(t.x, u.x), max(t.y, u.y), t.z + u.z, t.w + u.w);
    }
  oS = s;
  oT = t;
  oU = r;
}
`

/**
 * The row read back after a reduction: texels 0, 1 and 2 the reduced S, T and
 * U, then the macroscopic values (δρ, ux, uy, solid) at the cells listed in
 * uCells (probes, then the cells along the contour).
 */
export const READOUT_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uS;
uniform sampler2D uT;
uniform sampler2D uU;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform sampler2D uCells;
out vec4 oColor;

void main() {
  int x = int(gl_FragCoord.x);
  if (x == 0) { oColor = texelFetch(uS, ivec2(0), 0); return; }
  if (x == 1) { oColor = texelFetch(uT, ivec2(0), 0); return; }
  if (x == 2) { oColor = texelFetch(uU, ivec2(0), 0); return; }
  ivec2 cell = ivec2(texelFetch(uCells, ivec2(x - 3, 0), 0).xy);
  vec4 c = texelFetch(uC, cell, 0);
  oColor = vec4(c.y, c.z, c.w, texelFetch(uMask, cell, 0).r);
}
`

/** The macroscopic field downsampled by an integer factor (streamlines, colour scale). */
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform int uFactor;
uniform ivec2 uSize;
out vec4 oColor;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  vec4 sum = vec4(0.0);
  float n = 0.0;
  float solidCells = 0.0;
  for (int dy = 0; dy < 8; dy++) {
    if (dy >= uFactor) break;
    for (int dx = 0; dx < 8; dx++) {
      if (dx >= uFactor) break;
      ivec2 q = min(base + ivec2(dx, dy), uSize - 1);
      if (texelFetch(uMask, q, 0).r > 0.0) { solidCells += 1.0; continue; }
      sum += texelFetch(uC, q, 0);
      n += 1.0;
    }
  }
  vec4 mean = n > 0.0 ? sum / n : vec4(0.0);
  oColor = vec4(mean.y, mean.z, mean.w, solidCells > 0.5 * float(uFactor * uFactor) ? 1.0 : 0.0);
}
`

/**
 * Time averages (SPEC §11.1): adds the current (δρ, ux, uy) of every cell to a
 * running sum, with the number of samples in the fourth channel.
 */
export const ACCUM_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uC;
uniform sampler2D uSum;
out vec4 oColor;

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uC, q, 0);
  oColor = texelFetch(uSum, q, 0) + vec4(c.y, c.z, c.w, 1.0);
}
`
