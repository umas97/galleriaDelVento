// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// From loose pieces to closed loops (SPEC §7.2 #3-5), the same algorithm as
// backend/gdv/geometry/polylines.py `chain`: every endpoint is matched to the
// nearest free endpoint within the tolerance, closest pairs first; that links
// the pieces into cycles (loops) and paths (left open). It runs twice on a cut:
// on the triangle segments with a tiny tolerance (their ends coincide), then on
// the open chains left by a mesh with gaps, with 1% of the section's size.
//
// Pieces and loops are flat arrays [x0, y0, x1, y1, ...]; loops do not repeat
// their first point at the end.

export type Flat = number[]

/** Endpoint pairs within `tol`, as indices into `xs`/`ys`, sorted by distance. */
function closePairs(xs: Float64Array, ys: Float64Array, tol: number): Int32Array {
  const n = xs.length
  const cells = new Map<number, number[]>()
  const inv = 1 / tol
  // Cell coordinates are offset so that the key stays a positive safe integer.
  const OFFSET = 2 ** 25
  const key = (cx: number, cy: number) => (cx + OFFSET) * 2 ** 26 + (cy + OFFSET)
  const found: number[] = []
  const dist: number[] = []
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] * inv)
    const cy = Math.floor(ys[i] * inv)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get(key(cx + dx, cy + dy))
        if (!list) continue
        for (const j of list) {
          const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j])
          if (d <= tol) {
            found.push(j, i)
            dist.push(d)
          }
        }
      }
    const k = key(cx, cy)
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const order = dist.map((_, i) => i).sort((a, b) => dist[a] - dist[b] || a - b)
  const out = new Int32Array(order.length * 2)
  order.forEach((p, k) => {
    out[2 * k] = found[2 * p]
    out[2 * k + 1] = found[2 * p + 1]
  })
  return out
}

export type Chained = { loops: Flat[]; open: Flat[] }

/** Join pieces end to end within `tol`. A piece whose own two ends meet is a loop. */
export function chainPieces(pieces: readonly Flat[], tol: number): Chained {
  const parts = pieces.filter((p) => p.length >= 4)
  const n = parts.length
  if (!n) return { loops: [], open: [] }
  // Endpoint 2k is the start of piece k, 2k+1 its end.
  const xs = new Float64Array(2 * n)
  const ys = new Float64Array(2 * n)
  parts.forEach((p, k) => {
    xs[2 * k] = p[0]
    ys[2 * k] = p[1]
    xs[2 * k + 1] = p[p.length - 2]
    ys[2 * k + 1] = p[p.length - 1]
  })
  const pairs = closePairs(xs, ys, tol)
  const mate = new Int32Array(2 * n).fill(-1)
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k]
    const b = pairs[k + 1]
    if (mate[a] < 0 && mate[b] < 0) {
      mate[a] = b
      mate[b] = a
    }
  }
  const seen = new Uint8Array(n)
  const walk = (start: number): { points: Flat; closed: boolean } => {
    const points: Flat = []
    let entry = start
    for (;;) {
      const k = entry >> 1
      seen[k] = 1
      const p = parts[k]
      const forward = (entry & 1) === 0
      const m = p.length / 2
      for (let i = points.length ? 1 : 0; i < m; i++) {
        const j = forward ? i : m - 1 - i
        points.push(p[2 * j], p[2 * j + 1])
      }
      const next = mate[entry ^ 1]
      if (next < 0) return { points, closed: false }
      if (next === start) return { points, closed: true }
      if (seen[next >> 1]) return { points, closed: false }
      entry = next
    }
  }
  const loops: Flat[] = []
  const open: Flat[] = []
  // Paths first, from their free ends; what is left over is made of cycles.
  for (let e = 0; e < 2 * n; e++) {
    if (mate[e] < 0 && !seen[e >> 1]) open.push(walk(e).points)
  }
  for (let k = 0; k < n; k++) {
    if (seen[k]) continue
    const { points, closed } = walk(2 * k)
    if (!closed) open.push(points)
    else if (points.length >= 8) loops.push(points.slice(0, -2)) // last repeats the first
  }
  return { loops, open }
}

/** Shoelace area of a flat loop (positive counter-clockwise). */
export function flatArea(p: Flat): number {
  let sum = 0
  const n = p.length
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n
    sum += p[i] * p[j + 1] - p[j] * p[i + 1]
  }
  return sum / 2
}

/** Douglas-Peucker on a closed flat loop, keeping points farther than `tol` from the chords. */
export function simplifyLoop(p: Flat, tol: number): Flat {
  const n = p.length / 2
  if (n <= 4 || tol <= 0) return p
  // Split at the point farthest from the first one: two open runs.
  let far = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const keep = new Uint8Array(n + 1) // index n stands for the first point again
  keep[0] = keep[far] = keep[n] = 1
  const at = (i: number) => (i === n ? 0 : i)
  const stack = [0, far, far, n]
  const tol2 = tol * tol
  while (stack.length) {
    const b = stack.pop()!
    const a = stack.pop()!
    if (b - a < 2) continue
    const ax = p[2 * at(a)]
    const ay = p[2 * at(a) + 1]
    const dx = p[2 * at(b)] - ax
    const dy = p[2 * at(b) + 1] - ay
    const len2 = dx * dx + dy * dy
    let worst = -1
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const px = p[2 * i] - ax
      const py = p[2 * i + 1] - ay
      const d2 = len2 > 0 ? (px * dy - py * dx) ** 2 / len2 : px * px + py * py
      if (d2 > worst) {
        worst = d2
        index = i
      }
    }
    if (worst > tol2) {
      keep[index] = 1
      stack.push(a, index, index, b)
    }
  }
  const out: Flat = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1])
  return out
}

/**
 * The fast path for a welded mesh: each segment end is identified by the mesh
 * edge it lies on (`keys`, two per segment), so the two triangles sharing an
 * edge meet exactly, with a sort instead of a spatial search. Ends whose edge
 * appears only once (a gap, or a mesh whose vertices are not shared) come back
 * as open pieces, for chainPieces to join by distance.
 */
export function chainByKeys(coords: Float64Array, keys: Float64Array): Chained {
  const n = keys.length / 2
  if (!n) return { loops: [], open: [] }
  const order = new Uint32Array(2 * n)
  for (let i = 0; i < 2 * n; i++) order[i] = i
  order.sort((a, b) => keys[a] - keys[b])
  const mate = new Int32Array(2 * n).fill(-1)
  for (let i = 0; i + 1 < 2 * n; i++) {
    const a = order[i]
    const b = order[i + 1]
    // Pairs of equal keys; a non-manifold edge (3+ ends) pairs them in sort order.
    if (keys[a] === keys[b] && mate[a] < 0 && (a >> 1) !== (b >> 1)) {
      mate[a] = b
      mate[b] = a
      i++
    }
  }
  const seen = new Uint8Array(n)
  const walk = (start: number): { points: Flat; closed: boolean } => {
    const points: Flat = []
    let entry = start
    for (;;) {
      const k = entry >> 1
      seen[k] = 1
      const fwd = (entry & 1) === 0
      if (!points.length) points.push(coords[4 * k + (fwd ? 0 : 2)], coords[4 * k + (fwd ? 1 : 3)])
      points.push(coords[4 * k + (fwd ? 2 : 0)], coords[4 * k + (fwd ? 3 : 1)])
      const next = mate[entry ^ 1]
      if (next < 0) return { points, closed: false }
      if (next === start) return { points, closed: true }
      if (seen[next >> 1]) return { points, closed: false }
      entry = next
    }
  }
  const loops: Flat[] = []
  const open: Flat[] = []
  for (let e = 0; e < 2 * n; e++) if (mate[e] < 0 && !seen[e >> 1]) open.push(walk(e).points)
  for (let k = 0; k < n; k++) {
    if (seen[k]) continue
    const { points, closed } = walk(2 * k)
    if (!closed) open.push(points)
    else if (points.length >= 8) loops.push(points.slice(0, -2))
  }
  return { loops, open }
}
