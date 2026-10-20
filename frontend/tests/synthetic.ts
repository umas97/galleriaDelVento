// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Synthetic test geometry, generated in code (SPEC §18): no personal files.
// Meshes are indexed with shared vertices and outward faces, in metres.
import type { Pt } from '../src/profile/geometry'

export type Mesh = { positions: Float32Array; indices: Uint32Array }

/** Welds equal vertices (exact match on the rounded coordinates). */
class Builder {
  private positions: number[] = []
  private indices: number[] = []
  private seen = new Map<string, number>()

  vertex(x: number, y: number, z: number): number {
    const key = `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`
    const found = this.seen.get(key)
    if (found !== undefined) return found
    const id = this.positions.length / 3
    this.positions.push(x, y, z)
    this.seen.set(key, id)
    return id
  }

  triangle(a: number, b: number, c: number): void {
    if (a !== b && b !== c && c !== a) this.indices.push(a, b, c)
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c)
    this.triangle(a, c, d)
  }

  mesh(): Mesh {
    return { positions: new Float32Array(this.positions), indices: new Uint32Array(this.indices) }
  }
}

export function uvSphere(radius = 1, rings = 96, segments = 192): Mesh {
  const b = new Builder()
  const at = (i: number, j: number) => {
    const theta = (Math.PI * i) / rings
    const phi = (2 * Math.PI * (j % segments)) / segments
    return b.vertex(
      radius * Math.sin(theta) * Math.cos(phi),
      radius * Math.sin(theta) * Math.sin(phi),
      radius * Math.cos(theta),
    )
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) b.quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
  return b.mesh()
}

/** A torus about the z axis. */
export function torus(major = 2, minor = 0.5, nu = 128, nv = 64): Mesh {
  const b = new Builder()
  const at = (i: number, j: number) => {
    const u = (2 * Math.PI * (i % nu)) / nu
    const v = (2 * Math.PI * (j % nv)) / nv
    const r = major + minor * Math.cos(v)
    return b.vertex(r * Math.cos(u), r * Math.sin(u), minor * Math.sin(v))
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) b.quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
  return b.mesh()
}

/** NACA 4-digit, closed trailing edge, CCW from the trailing edge, last point not repeated. */
export function naca4(code = '0012', n = 100, chord = 1): Pt[] {
  const m = Number(code[0]) / 100
  const p = Number(code[1]) / 10
  const t = Number(code.slice(2)) / 100
  const upper: Pt[] = []
  const lower: Pt[] = []
  for (let k = 0; k <= n; k++) {
    const x = (1 - Math.cos((Math.PI * k) / n)) / 2
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    let yc = 0
    let dyc = 0
    if (m > 0) {
      yc = x < p ? (m / p ** 2) * (2 * p * x - x * x) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x)
      dyc = x < p ? ((2 * m) / p ** 2) * (p - x) : ((2 * m) / (1 - p) ** 2) * (p - x)
    }
    const th = Math.atan(dyc)
    upper.push([(x - yt * Math.sin(th)) * chord, (yc + yt * Math.cos(th)) * chord])
    lower.push([(x + yt * Math.sin(th)) * chord, (yc - yt * Math.cos(th)) * chord])
  }
  return [...upper.reverse(), ...lower.slice(1, -1)]
}

/**
 * A straight tapered wing along +y: NACA 0012 sections, chord `root` at y = 0
 * down to `tip` at y = span, leading edges on x = 0, end caps closed.
 */
export function taperedWing(span = 2, root = 1, tip = 0.4, stations = 12, n = 60): Mesh {
  const b = new Builder()
  const section = naca4('0012', n, 1)
  const m = section.length
  const ring = (s: number) => {
    const y = (span * s) / stations
    const c = root + ((tip - root) * s) / stations
    return section.map(([x, z]) => b.vertex(x * c, y, z * c))
  }
  const rings = Array.from({ length: stations + 1 }, (_, s) => ring(s))
  for (let s = 0; s < stations; s++)
    for (let k = 0; k < m; k++) b.quad(rings[s][k], rings[s][(k + 1) % m], rings[s + 1][(k + 1) % m], rings[s + 1][k])
  for (const [s, flip] of [
    [0, false],
    [stations, true],
  ] as const) {
    const c = root + ((tip - root) * s) / stations
    const centre = b.vertex(0.3 * c, (span * s) / stations, 0)
    for (let k = 0; k < m; k++) {
      const a = rings[s][k]
      const d = rings[s][(k + 1) % m]
      if (flip) b.triangle(centre, d, a)
      else b.triangle(centre, a, d)
    }
  }
  return b.mesh()
}

/**
 * A unit cube on a grid with lines at `cuts` (fractions of the side), with one
 * small top cell removed: from (0.5, 0.5) to (0.505, 0.505); `hole = false`
 * keeps it, for the closed cube on the same grid.
 */
export function cubeWithSmallHole(hole = true): Mesh {
  const g = [0, 0.25, 0.5, 0.505, 0.75, 1]
  const b = new Builder()
  const faces: [(u: number, v: number) => [number, number, number], boolean][] = [
    [(u, v) => [u, v, 0], true],
    [(u, v) => [u, v, 1], false],
    [(u, v) => [u, 0, v], false],
    [(u, v) => [u, 1, v], true],
    [(u, v) => [0, u, v], true],
    [(u, v) => [1, u, v], false],
  ]
  faces.forEach(([at, flip], face) => {
    for (let i = 0; i + 1 < g.length; i++)
      for (let j = 0; j + 1 < g.length; j++) {
        if (hole && face === 1 && g[i] === 0.5 && g[j] === 0.5) continue // the hole
        const v = [
          at(g[i], g[j]),
          at(g[i + 1], g[j]),
          at(g[i + 1], g[j + 1]),
          at(g[i], g[j + 1]),
        ].map(([x, y, z]) => b.vertex(x, y, z))
        if (flip) b.quad(v[0], v[3], v[2], v[1])
        else b.quad(v[0], v[1], v[2], v[3])
      }
  })
  return b.mesh()
}

export function bboxCentre(mesh: Mesh): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], mesh.positions[i])
    hi[i % 3] = Math.max(hi[i % 3], mesh.positions[i])
  }
  return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as [number, number, number]
}
