// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test 12: the profile editor's model (SPEC §7.5) -- symmetric mode, 100 steps
// of undo and redo, «Rendi modificabile» on a NACA 0012 -- plus the spline and
// the measurements shown beside the drawing.
import { describe, expect, it } from 'vitest'
import {
  History,
  circleLoop,
  deletePoint,
  docFromProfile,
  docToDraft,
  densifyLoop,
  insertPoint,
  insertPointAt,
  simplifyLoop,
  makeEditable,
  movePoint,
  outlines,
  rotateDoc,
  scaleDoc,
  setSymmetric,
  toggleCorner,
  type EditorDoc,
  type ShapeLoop,
} from '../src/editor/doc'
import { findCorners, fitSpline, hausdorff } from '../src/profile/fit'
import { signedArea, type Pt } from '../src/profile/geometry'
import { profileMetrics } from '../src/profile/metrics'
import { sampleShape, shapeSize } from '../src/profile/spline'
import { validateLoops } from '../src/profile/validate'
import { naca4 } from './synthetic'

const close = (a: Pt, b: Pt, eps = 1e-12) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps

function symmetricDoc(): EditorDoc {
  // A lens: trailing edge at x = 1, leading edge at x = 0, a few points on top and below.
  const points: Pt[] = [
    [1, 0.1],
    [0.7, 0.2],
    [0.3, 0.25],
    [0, 0.1],
    [0.3, -0.02],
    [0.7, 0.01],
  ]
  const loop: ShapeLoop = { kind: 'spline', points, corners: points.map((_, i) => i === 0), symmetricAxisY: null }
  return setSymmetric({ loops: [loop] }, 0, true)
}

function mirrored(loop: ShapeLoop): boolean {
  const n = loop.points.length
  const m = n / 2 + 1
  const axis = loop.symmetricAxisY!
  for (let k = 1; k < m - 1; k++) {
    const up = loop.points[k]
    const down = loop.points[n - k]
    if (!close([up[0], 2 * axis - up[1]], down)) return false
    if (loop.corners[k] !== loop.corners[n - k]) return false
  }
  return loop.points[0][1] === axis && loop.points[m - 1][1] === axis
}

describe('test 12: symmetric mode', () => {
  it('rebuilds the lower half from the upper one about the chord line', () => {
    const doc = symmetricDoc()
    const loop = doc.loops[0] as ShapeLoop
    expect(loop.symmetricAxisY).toBeCloseTo(0.1)
    expect(loop.points).toHaveLength(6) // TE, two on top, LE, two mirrored
    expect(loop.points[0]).toEqual([1, 0.1])
    expect(loop.points[3]).toEqual([0, 0.1])
    expect(mirrored(loop)).toBe(true)
    expect(signedArea(loop.points)).toBeGreaterThan(0)
  })

  it('moving a point on either half moves its mirror', () => {
    let doc = movePoint(symmetricDoc(), 0, 1, [0.6, 0.3])
    let loop = doc.loops[0] as ShapeLoop
    expect(close(loop.points[5], [0.6, -0.1])).toBe(true)
    doc = movePoint(doc, 0, 4, [0.35, -0.2]) // a lower point: its upper twin follows
    loop = doc.loops[0] as ShapeLoop
    expect(loop.points[2][0]).toBeCloseTo(0.35)
    expect(loop.points[2][1]).toBeCloseTo(0.4)
    expect(mirrored(loop)).toBe(true)
  })

  it('keeps the two edges on the chord line', () => {
    const loop = movePoint(symmetricDoc(), 0, 3, [-0.1, 0.5]).loops[0] as ShapeLoop
    expect(loop.points[3]).toEqual([-0.1, 0.1])
  })

  it('inserting or deleting on one half does the same on the other', () => {
    let doc = insertPoint(symmetricDoc(), 0, 4, [0.5, -0.06]) // lower segment 4 -> 5
    let loop = doc.loops[0] as ShapeLoop
    expect(loop.points).toHaveLength(8)
    expect(mirrored(loop)).toBe(true)
    expect(loop.points.some((p) => close(p, [0.5, 0.26]))).toBe(true)
    doc = insertPoint(doc, 0, 0, [0.9, 0.15]) // upper segment 0 -> 1
    loop = doc.loops[0] as ShapeLoop
    expect(loop.points).toHaveLength(10)
    expect(mirrored(loop)).toBe(true)
    doc = toggleCorner(doc, 0, 8)
    expect(mirrored(doc.loops[0] as ShapeLoop)).toBe(true)
    doc = deletePoint(doc, 0, 7)
    expect(doc.loops[0].points).toHaveLength(8)
    expect(mirrored(doc.loops[0] as ShapeLoop)).toBe(true)
    // The edges cannot be deleted while symmetric.
    expect(deletePoint(doc, 0, 0)).toBe(doc)
  })

  it('switching it off keeps the shape', () => {
    const doc = symmetricDoc()
    const off = setSymmetric(doc, 0, false)
    expect(off.loops[0].points).toEqual(doc.loops[0].points)
    expect((off.loops[0] as ShapeLoop).symmetricAxisY).toBeNull()
  })
})

describe('test 12: undo and redo', () => {
  it('goes back and forth 100 steps, symmetric edits included', () => {
    const start = symmetricDoc()
    const history = new History(start)
    const states = [start]
    for (let k = 0; k < 100; k++) {
      const doc = history.present
      const n = doc.loops[0].points.length
      const next =
        k % 3 === 0
          ? insertPoint(doc, 0, k % n, [0.5, 0.2 + k * 1e-3])
          : k % 3 === 1
            ? movePoint(doc, 0, 1 + (k % (n - 1)), [0.4 + k * 1e-3, 0.3])
            : scaleDoc(doc, 1.01)
      history.push(next)
      states.push(next)
    }
    for (let k = 100; k > 0; k--) {
      expect(history.canUndo).toBe(true)
      expect(history.undo()).toBe(states[k - 1])
    }
    expect(history.canUndo).toBe(false)
    for (let k = 1; k <= 100; k++) expect(history.redo()).toBe(states[k])
    expect(history.canRedo).toBe(false)
  })

  it('a new edit after undoing drops the redo branch', () => {
    const history = new History<EditorDoc>(symmetricDoc())
    history.push(scaleDoc(history.present, 2))
    history.undo()
    history.push(scaleDoc(history.present, 3))
    expect(history.canRedo).toBe(false)
  })
})

describe('test 12: «Rendi modificabile»', () => {
  it('fits a NACA 0012 with 24 points within 0.3% of the chord', () => {
    const chord = 1.2
    const outline = naca4('0012', 150, chord)
    const doc: EditorDoc = { loops: [{ kind: 'raw', points: outline }] }
    const { doc: edited, maxError } = makeEditable(doc, 0, 24)
    const loop = edited.loops[0] as ShapeLoop
    expect(loop.kind).toBe('spline')
    expect(loop.points).toHaveLength(24)
    expect(maxError).toBeLessThanOrEqual(0.003 * chord)
    // The reported error is the real one.
    expect(hausdorff(outline, outlines(edited)[0])).toBeLessThanOrEqual(0.003 * chord * 1.01)
    // The sharp trailing edge is a corner, the round leading edge is not.
    expect(loop.corners.filter(Boolean)).toHaveLength(1)
    const corner = loop.points[loop.corners.indexOf(true)]
    expect(corner[0]).toBeCloseTo(chord, 6)
  })

  it('keeps the corners of a rectangle', () => {
    const rect: Pt[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ]
    expect(findCorners(rect)).toEqual([0, 1, 2, 3])
    const fit = fitSpline(rect, 8)
    expect(fit.maxError).toBeLessThan(1e-6)
  })
})

describe('splines and measurements', () => {
  it('passes through its control points and samples within 0.02% of its size', () => {
    const loop = circleLoop(0, 0, 1, 8)
    const sampled = sampleShape(loop).points
    for (const p of loop.points) expect(sampled.some((q) => close(p, q, 1e-12))).toBe(true)
    const tolerance = 2e-4 * shapeSize(loop)
    // Every sampled chord stays within the tolerance of the curve: check its midpoints on a denser sampling.
    const dense = sampleShape(loop, tolerance / 50).points
    expect(hausdorff(sampled, dense)).toBeLessThanOrEqual(tolerance * 1.05)
    expect(validateLoops([sampled]).valid).toBe(true)
  })

  it('a polyline is straight between corners', () => {
    const square: ShapeLoop = {
      kind: 'polyline',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      corners: [false, false, false, false],
      symmetricAxisY: null,
    }
    expect(sampleShape(square).points).toEqual(square.points)
  })

  it('measures chord, thickness, area and perimeter', () => {
    const m = profileMetrics([naca4('0012', 200, 2)])
    expect(m.chord).toBeCloseTo(2, 6)
    expect(m.thickness / 2).toBeCloseTo(0.12, 3)
    expect(m.thicknessAt).toBeCloseTo(0.3, 1)
    expect(m.area).toBeCloseTo(0.0817 * 4, 3)
    const ring = profileMetrics([
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      [
        [1, 1],
        [1, 3],
        [3, 3],
        [3, 1],
      ],
    ])
    expect(ring.area).toBeCloseTo(12)
    expect(ring.perimeter).toBeCloseTo(24)
  })

  it('round-trips through a draft', () => {
    const doc = rotateDoc(symmetricDoc(), 0.1)
    const draft = docToDraft(doc, 'lente', { kind: 'editor', derived_from: null, origin: null })
    const back = docFromProfile(draft)
    expect(back.loops[0].points).toEqual(doc.loops[0].points)
    expect(draft.loops[0].points.length).toBeGreaterThan(doc.loops[0].points.length)
    const raw = docFromProfile({ loops: [{ points: naca4() }], spline: null })
    expect(raw.loops[0].kind).toBe('raw')
  })
})

describe('adding and removing points without changing tool', () => {
  const square = (): EditorDoc => ({
    loops: [{ kind: 'polyline', points: [[0, 0], [1, 0], [1, 1], [0, 1]], corners: [false, false, false, false], symmetricAxisY: null }],
  })

  it('a point pulled out of the curve is the one the drag then moves', () => {
    const { doc, k } = insertPointAt(square(), 0, 1, [1, 0.5])
    expect(k).toBe(2)
    const moved = movePoint(doc, 0, k, [1.3, 0.5])
    expect((moved.loops[0] as ShapeLoop).points[2]).toEqual([1.3, 0.5])
    expect((moved.loops[0] as ShapeLoop).points).toHaveLength(5)
  })

  it('in symmetric mode, on either half, the index returned is the point inserted', () => {
    const base = symmetricDoc()
    const loop = base.loops[0] as ShapeLoop
    const n = loop.points.length
    for (const after of [0, n - 2]) {
      const a = loop.points[after]
      const b = loop.points[(after + 1) % n]
      const at: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const { doc, k } = insertPointAt(base, 0, after, at)
      const placed = (doc.loops[0] as ShapeLoop).points[k]
      expect(close(placed, at, 1e-9), `after ${after}: ${placed} vs ${at}`).toBe(true)
    }
  })

  it('«Infittisci» doubles the points and keeps a polyline exactly', () => {
    const doc = densifyLoop(square(), 0)
    const loop = doc.loops[0] as ShapeLoop
    expect(loop.points).toHaveLength(8)
    expect(loop.points[1]).toEqual([0.5, 0])
    expect(Math.abs(signedArea(loop.points))).toBeCloseTo(1, 12)
  })

  it('«Infittisci» moves a spline by a hair', () => {
    const doc: EditorDoc = { loops: [circleLoop(0, 0, 1, 8)] }
    const before = sampleShape(doc.loops[0] as ShapeLoop).points
    const after = sampleShape(densifyLoop(doc, 0).loops[0] as ShapeLoop).points
    expect(hausdorff(before, after)).toBeLessThan(0.01)
  })

  it('«Semplifica» undoes «Infittisci» on a polyline, and keeps corners', () => {
    const dense = densifyLoop(square(), 0)
    const { doc, removed } = simplifyLoop(dense, 0, 1e-9)
    expect(removed).toBe(4)
    expect((doc.loops[0] as ShapeLoop).points).toHaveLength(4)
    const cornered = toggleCorner(dense, 0, 1)
    expect((simplifyLoop(cornered, 0, 1e-9).doc.loops[0] as ShapeLoop).points).toContainEqual([0.5, 0])
  })

  it('«Semplifica» stays within its tolerance on a spline', () => {
    const doc: EditorDoc = { loops: [circleLoop(0, 0, 1, 32)] }
    const tol = 0.01
    const { doc: simple, removed } = simplifyLoop(doc, 0, tol)
    expect(removed).toBeGreaterThan(0)
    const a = sampleShape(doc.loops[0] as ShapeLoop).points
    const b = sampleShape(simple.loops[0] as ShapeLoop).points
    expect(hausdorff(a, b)).toBeLessThan(2 * tol)
  })

  it('«Semplifica» in symmetric mode keeps the loop symmetric', () => {
    const dense = densifyLoop(symmetricDoc(), 0)
    const { doc } = simplifyLoop(dense, 0, 1e-3)
    const loop = doc.loops[0] as ShapeLoop
    const axis = loop.symmetricAxisY as number
    const m = loop.points.length / 2 + 1
    for (let i = 1; i < m - 1; i++) {
      const mirror = loop.points[2 * m - 2 - i]
      expect(mirror[0]).toBeCloseTo(loop.points[i][0], 12)
      expect(mirror[1]).toBeCloseTo(2 * axis - loop.points[i][1], 12)
    }
  })
})
