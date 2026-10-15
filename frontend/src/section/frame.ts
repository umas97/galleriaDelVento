// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where the cutting plane sits (SPEC §6.4, §7.2). Tunnel frame: x downstream,
// y lateral (depth), z up. The plane always contains the wind direction:
//
//   vertical   (x-z), normal y: profile x = tunnel x, profile y = tunnel z;
//   horizontal (x-y), normal z: profile x = tunnel x, profile y = tunnel y.
//
// Other attitudes come from turning the *model*, never the plane: first `tilt`
// about the in-plane axis across the wind (z for vertical, y for horizontal),
// then `roll` about the wind axis x, both about the centre `c` of the model's
// bounding box:  q = Rx(roll) · Rc(tilt) · (p - c) + c.
// Incidence, the rotation about the plane normal, does not change the cut: it
// turns the profile already cut (`incidenceRotate`), positive nose up.
//
// Rather than turning a million vertices, the slicer projects them on the
// rows of R: (q - c)·e = (p - c)·(Rᵀe), and Rᵀe_j is the j-th row of R.

export type Plane = 'vertical' | 'horizontal'
export type Vec3 = [number, number, number]

export type SliceAttitude = {
  plane: Plane
  /** Degrees about the wind axis x. */
  roll: number
  /** Degrees about the in-plane axis across the wind (z for vertical, y for horizontal). */
  tilt: number
}

type Mat3 = [Vec3, Vec3, Vec3]

function rotX(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ]
}

function rotY(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ]
}

function rotZ(a: number): Mat3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ]
}

function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3
}

const DEG = Math.PI / 180

/** The model's rotation R for an attitude (row-major). */
export function attitudeMatrix({ plane, roll, tilt }: SliceAttitude): Mat3 {
  const across = plane === 'vertical' ? rotZ(tilt * DEG) : rotY(tilt * DEG)
  return mul(rotX(roll * DEG), across)
}

export type PlaneAxes = {
  /** Tunnel axis index of the plane normal (1 = y, 2 = z). */
  normalAxis: 1 | 2
  /** Tunnel axis index of the profile's y (2 = z, 1 = y). */
  upAxis: 1 | 2
}

export function planeAxes(plane: Plane): PlaneAxes {
  return plane === 'vertical' ? { normalAxis: 1, upAxis: 2 } : { normalAxis: 2, upAxis: 1 }
}

/** Directions in the *unrotated* model frame whose dot products give depth, profile x and y. */
export function projectionAxes(attitude: SliceAttitude): { normal: Vec3; x: Vec3; up: Vec3 } {
  const r = attitudeMatrix(attitude)
  const { normalAxis, upAxis } = planeAxes(attitude.plane)
  return { normal: r[normalAxis], x: r[0], up: r[upAxis] }
}

/** A point of the cut (profile x, y at `depth`) back in the tunnel frame, rotated model. */
export function planeToTunnel(plane: Plane, x: number, y: number, depth: number): Vec3 {
  return plane === 'vertical' ? [x, depth, y] : [x, y, depth]
}

/**
 * The cut profile turned by the incidence: positive is nose up, which for a
 * wind blowing towards +x is a clockwise turn in the profile plane.
 */
export function incidenceAngle(incidenceDeg: number): number {
  return -incidenceDeg * DEG
}
