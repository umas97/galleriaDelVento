// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The cutting plane and the trace of the section in the 3D scene (SPEC §7.2).
// The plane is fixed in the tunnel frame (it always contains the wind); the
// model turns under it, so the trace is drawn where the plane is.
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three'
import type { Box, Pt } from '../profile/geometry'
import { planeToTunnel, type Plane } from '../section/frame'

function segmentsGeometry(plane: Plane, depth: number, lines: readonly (readonly Pt[])[], closed: boolean): BufferGeometry {
  const values: number[] = []
  for (const line of lines) {
    const n = line.length
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = planeToTunnel(plane, line[i][0], line[i][1], depth)
      const b = planeToTunnel(plane, line[(i + 1) % n][0], line[(i + 1) % n][1], depth)
      values.push(...a, ...b)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(values), 3))
  return geometry
}

export function CutPlane({
  plane,
  depth,
  envelope,
  loops,
  open,
}: {
  plane: Plane
  depth: number
  envelope: Box
  loops: readonly (readonly Pt[])[]
  open: readonly (readonly Pt[])[]
}) {
  const quad = useMemo(() => {
    const pad = 0.15 * Math.max(envelope.maxX - envelope.minX, envelope.maxY - envelope.minY)
    const corners: Pt[] = [
      [envelope.minX - pad, envelope.minY - pad],
      [envelope.maxX + pad, envelope.minY - pad],
      [envelope.maxX + pad, envelope.maxY + pad],
      [envelope.minX - pad, envelope.maxY + pad],
    ]
    const v = corners.map(([x, y]) => planeToTunnel(plane, x, y, depth))
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]]), 3))
    return geometry
  }, [plane, depth, envelope])
  const trace = useMemo(() => segmentsGeometry(plane, depth, loops, true), [plane, depth, loops])
  const gaps = useMemo(() => segmentsGeometry(plane, depth, open, false), [plane, depth, open])
  useEffect(() => () => quad.dispose(), [quad])
  useEffect(() => () => trace.dispose(), [trace])
  useEffect(() => () => gaps.dispose(), [gaps])
  return (
    <>
      <mesh geometry={quad} renderOrder={2}>
        <meshBasicMaterial color="#7aa2f7" transparent opacity={0.16} side={DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={trace} renderOrder={3}>
        <lineBasicMaterial color="#f5c26b" depthTest={false} />
      </lineSegments>
      <lineSegments geometry={gaps} renderOrder={3}>
        <lineBasicMaterial color="#e06c6c" depthTest={false} />
      </lineSegments>
    </>
  )
}
