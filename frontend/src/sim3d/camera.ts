// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's camera (SPEC §24.2 #4: free at any moment -- orbit, zoom,
// pan): an orbit about a target, z up as everywhere in the tunnel, and the
// matrices WGSL wants (column-major, depth from 0 to 1 as in WebGPU). Pure
// arithmetic, so that vitest can check it.

export type Vec3 = [number, number, number]
/** A 4×4 matrix, column-major. */
export type Mat4 = Float32Array

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  return out
}

/** Perspective projection with WebGPU's clip depth (0 at `near`, 1 at `far`). */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (near * far) / (near - far)
  return out
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** The view matrix of an eye looking at `target`. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target))
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  const out = new Float32Array(16)
  out.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
  return out
}

/** M · (p, 1), the clip coordinates of a point. */
export function transform(m: Mat4, p: Vec3): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]
  return out
}

export type CameraView = 'iso' | 'front' | 'side' | 'top'

/** Azimuth (from +x, anticlockwise seen from above) and elevation of the eye, radians. */
const VIEWS: Record<CameraView, [number, number]> = {
  iso: [(-130 * Math.PI) / 180, (25 * Math.PI) / 180],
  front: [Math.PI, 0.02], // from upstream, looking downstream
  side: [-Math.PI / 2, 0.02],
  top: [-Math.PI / 2, Math.PI / 2 - 0.02],
}

const ELEVATION_LIMIT = Math.PI / 2 - 0.01

export class OrbitCamera {
  target: Vec3 = [0, 0, 0]
  distance = 1
  azimuth = VIEWS.iso[0]
  elevation = VIEWS.iso[1]
  readonly fovY = (40 * Math.PI) / 180
  /** What `fit` framed last: double click and the view buttons go back to it. */
  private home: { target: Vec3; size: number } = { target: [0, 0, 0], size: 1 }

  eye(): Vec3 {
    const c = Math.cos(this.elevation)
    return [
      this.target[0] + this.distance * c * Math.cos(this.azimuth),
      this.target[1] + this.distance * c * Math.sin(this.azimuth),
      this.target[2] + this.distance * Math.sin(this.elevation),
    ]
  }

  view(): Mat4 {
    return lookAt(this.eye(), this.target, [0, 0, 1])
  }

  /** Projection × view; near and far follow the distance, so a close look keeps its depth precision. */
  viewProj(aspect: number): Mat4 {
    return multiply(perspective(this.fovY, aspect, this.distance / 200, this.distance * 50), this.view())
  }

  /** Turn about the target by a drag of (dx, dy) pixels. */
  orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.006
    this.elevation = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, this.elevation + dy * 0.006))
  }

  /** Move the target with the pointer: (dx, dy) pixels of a view `height` pixels tall. */
  pan(dx: number, dy: number, height: number): void {
    const perPixel = (2 * this.distance * Math.tan(this.fovY / 2)) / Math.max(1, height)
    const v = this.view()
    const right: Vec3 = [v[0], v[4], v[8]]
    const up: Vec3 = [v[1], v[5], v[9]]
    for (let a = 0; a < 3; a++) this.target[a] += (-dx * right[a] + dy * up[a]) * perPixel
  }

  /** Closer (factor < 1) or farther, within reason around the framed size. */
  zoom(factor: number): void {
    const size = this.home.size
    this.distance = Math.max(size * 0.05, Math.min(size * 40, this.distance * factor))
  }

  /** Frame a box of `size` (its largest extent) about `target` from one of the standard views. */
  fit(target: Vec3, size: number, view: CameraView = 'iso'): void {
    this.home = { target: [...target], size: Math.max(size, 1e-9) }
    this.look(view)
  }

  /** Back to the framed box, from a standard view. */
  look(view: CameraView): void {
    this.target = [...this.home.target]
    this.distance = (this.home.size * 0.62) / Math.tan(this.fovY / 2)
    ;[this.azimuth, this.elevation] = VIEWS[view]
  }
}
