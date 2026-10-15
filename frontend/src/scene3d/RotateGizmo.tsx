// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The rotation gizmo of the mini-scene (SPEC §7.2): two rings, roll about the
// wind axis x and the other rotation that changes the section (about z for a
// vertical plane, about y for a horizontal one). The model's rotation is
// R = Rx(roll) · R(tilt) (section/frame.ts): three.js Euler angles in the order
// XZY (vertical) or XYZ (horizontal) with the third angle at zero. After every
// change of the gizmo that third angle is dropped and the two are read back.
import { useEffect, useMemo } from 'react'
import { TransformControls } from '@react-three/drei'
import { Euler, Object3D } from 'three'
import type { Plane } from '../section/frame'

const DEG = Math.PI / 180

export function RotateGizmo({
  plane,
  roll,
  tilt,
  centre,
  size,
  onChange,
  onStart,
  onEnd,
}: {
  plane: Plane
  roll: number
  tilt: number
  centre: [number, number, number]
  size: number
  onChange: (roll: number, tilt: number) => void
  onStart: () => void
  onEnd: () => void
}) {
  const target = useMemo(() => new Object3D(), [])
  const order = plane === 'vertical' ? 'XZY' : 'XYZ'
  useEffect(() => {
    target.position.set(...centre)
    target.rotation.copy(
      plane === 'vertical' ? new Euler(roll * DEG, 0, tilt * DEG, order) : new Euler(roll * DEG, tilt * DEG, 0, order),
    )
  }, [target, centre, plane, roll, tilt, order])

  const read = () => {
    const e = new Euler().setFromQuaternion(target.quaternion, order)
    const r = Math.round((e.x / DEG) * 2) / 2
    const tl = Math.round(((plane === 'vertical' ? e.z : e.y) / DEG) * 2) / 2
    onChange(Math.max(-180, Math.min(180, r)), Math.max(-180, Math.min(180, tl)))
  }

  return (
    <>
      <primitive object={target} />
      <TransformControls
        object={target}
        mode="rotate"
        space="world"
        size={size}
        showX
        showY={plane === 'horizontal'}
        showZ={plane === 'vertical'}
        onMouseDown={onStart}
        onMouseUp={onEnd}
        onObjectChange={read}
      />
    </>
  )
}
