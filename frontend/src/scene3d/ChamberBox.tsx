// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The test chamber in the 3D scene (SPEC §6.6): the plan's chamber is a
// rectangle in the cutting plane; seen from the model, which the incidence
// turns, it is that rectangle turned back about the pivot, stretched across the
// model's depth. Drawn as a light transparent box with its edges.
import { useEffect, useMemo } from 'react'
import { BoxGeometry, EdgesGeometry, Matrix4 } from 'three'
import type { CasePlan } from '../lib/types'
import { planeToTunnel, type Plane } from '../section/frame'

export function ChamberBox({
  plan,
  plane,
  position,
  angleDeg,
  depthMin,
  depthMax,
}: {
  plan: CasePlan
  plane: Plane
  position: [number, number]
  angleDeg: number
  depthMin: number
  depthMax: number
}) {
  const { box, edges, matrix } = useMemo(() => {
    const depth = Math.max(depthMax - depthMin, 1e-6)
    // Chamber centre in profile coordinates: q = position + R(-a)(p - pivot) inverted.
    const a = (angleDeg * Math.PI) / 180
    const qx = plan.width_m / 2 - position[0]
    const qy = plan.height_m / 2 - position[1]
    const cx = plan.pivot[0] + Math.cos(a) * qx - Math.sin(a) * qy
    const cy = plan.pivot[1] + Math.sin(a) * qx + Math.cos(a) * qy
    const centre = planeToTunnel(plane, cx, cy, (depthMin + depthMax) / 2)
    const geometry = plane === 'vertical' ? new BoxGeometry(plan.width_m, depth, plan.height_m) : new BoxGeometry(plan.width_m, plan.height_m, depth)
    // The incidence turns the chamber about the plane's normal (y for vertical, z for horizontal).
    const turn = plane === 'vertical' ? new Matrix4().makeRotationY(-a) : new Matrix4().makeRotationZ(a)
    const m = new Matrix4().makeTranslation(...centre).multiply(turn)
    return { box: geometry, edges: new EdgesGeometry(geometry), matrix: m }
  }, [plan, plane, position, angleDeg, depthMin, depthMax])
  useEffect(
    () => () => {
      box.dispose()
      edges.dispose()
    },
    [box, edges],
  )
  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh geometry={box} renderOrder={1}>
        <meshBasicMaterial color="#7aa2f7" transparent opacity={0.05} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#7aa2f7" transparent opacity={0.6} />
      </lineSegments>
    </group>
  )
}
