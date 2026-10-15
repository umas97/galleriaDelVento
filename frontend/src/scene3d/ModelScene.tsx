// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D view of a model in the tunnel frame (SPEC §6.4, §6.6): x downstream,
// y lateral, z up, metres. Orbit navigation, quick views, a floor grid in
// metres and the wind arrow. Rendering is on demand: nothing redraws while
// nothing moves. No drei helper that loads remote assets is ever used (SPEC §2.2).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei'
import { ArrowHelper, Box3, BufferGeometry, Color, DoubleSide, Matrix4, Object3D, Vector3 } from 'three'
import { metres } from '../lib/format'
import type { MeshHeader } from '../lib/meshBinary'
import { t, type MessageKey } from '../i18n/it'

// z is up in the tunnel: every camera and control created after this agrees.
Object3D.DEFAULT_UP.set(0, 0, 1)

export type ViewName = 'iso' | 'front' | 'side' | 'top'

const VIEW_DIRECTIONS: Record<ViewName, [number, number, number]> = {
  iso: [-1, -1.2, 0.8],
  front: [-1, 0, 0.0001], // from upstream, looking downstream
  side: [0, -1, 0.0001],
  top: [0.0001, 0, 1],
}

const VIEW_LABELS: Record<ViewName, MessageKey> = {
  iso: 'scene.view.iso',
  front: 'scene.view.front',
  side: 'scene.view.side',
  top: 'scene.view.top',
}

function boxOf(header: MeshHeader): Box3 {
  return new Box3(new Vector3(...header.bbox_min), new Vector3(...header.bbox_max))
}

/** Grid spacing: a power of ten that gives a handful of cells across the model. */
export function gridCell(size: number): number {
  if (!(size > 0)) return 1
  return 10 ** Math.floor(Math.log10(size / 2))
}

function CameraRig({ box, view, nonce }: { box: Box3; view: ViewName; nonce: number }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update(): void } | null
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const centre = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3()).length() || 1
    const direction = new Vector3(...VIEW_DIRECTIONS[view]).normalize()
    camera.position.copy(centre).addScaledVector(direction, size * 1.6)
    camera.near = size / 1000
    camera.far = size * 200
    camera.up.set(0, 0, 1)
    camera.lookAt(centre)
    camera.updateProjectionMatrix()
    if (controls) {
      controls.target.copy(centre)
      controls.update()
    }
    invalidate()
  }, [box, view, nonce, camera, controls, invalidate])
  return null
}

function WindArrow({ box }: { box: Box3 }) {
  const arrow = useMemo(() => {
    const size = box.getSize(new Vector3())
    const length = Math.max(size.x, size.y, size.z) * 0.45 || 1
    const origin = new Vector3(box.min.x - length * 1.4, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
    return new ArrowHelper(new Vector3(1, 0, 0), origin, length, new Color('#7aa2f7'), length * 0.25, length * 0.12)
  }, [box])
  useEffect(() => () => arrow.dispose(), [arrow])
  return <primitive object={arrow} />
}

function Thumbnail({ ready, onCapture }: { ready: boolean; onCapture: (png: Blob) => void }) {
  const { gl, scene, camera } = useThree()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!ready || done) return
    const id = requestAnimationFrame(() => {
      gl.render(scene, camera)
      const source = gl.domElement
      const out = document.createElement('canvas')
      out.width = 320
      out.height = 200
      const ctx = out.getContext('2d')
      if (!ctx) return
      // Cover-crop the view to 16:10.
      const scale = Math.max(out.width / source.width, out.height / source.height)
      const w = source.width * scale
      const h = source.height * scale
      ctx.drawImage(source, (out.width - w) / 2, (out.height - h) / 2, w, h)
      out.toBlob((blob) => {
        if (blob) onCapture(blob)
      }, 'image/png')
      setDone(true)
    })
    return () => cancelAnimationFrame(id)
  }, [ready, done, gl, scene, camera, onCapture])
  return null
}

type Props = {
  geometry: BufferGeometry | undefined
  header: MeshHeader | undefined
  floorZ: number | null
  onThumbnail?: (png: Blob) => void
  /** Extra turn of the model in the tunnel frame (the section rotations). */
  modelMatrix?: Matrix4
  /** More objects in the scene, in the tunnel frame (the cutting plane, the trace). */
  children?: ReactNode
  /** Smaller labels and no grid caption: the mini-scene of the section screen. */
  compact?: boolean
  testId?: string
}

export function ModelScene({
  geometry,
  header,
  floorZ,
  onThumbnail,
  modelMatrix,
  children,
  compact = false,
  testId = 'model-scene',
}: Props) {
  const [view, setView] = useState<ViewName>('iso')
  const [nonce, setNonce] = useState(0)
  // Re-frame only when the model's extent really changes, not on every refetch.
  const boxKey = header ? [...header.bbox_min, ...header.bbox_max].map((v) => v.toPrecision(4)).join(',') : ''
  const stableBox = useMemo(
    () => (boxKey ? boxOf(header as MeshHeader) : new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the rounded extent
    [boxKey],
  )
  const size = stableBox.getSize(new Vector3())
  const cell = gridCell(Math.max(size.x, size.y, size.z))
  const groundZ = floorZ ?? stableBox.min.z

  return (
    <div className="relative h-full w-full">
      <Canvas
        frameloop="demand"
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ fov: 35, position: [-3, -3, 2] }}
        data-testid={testId}
      >
        <color attach="background" args={['#141414']} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[2, -3, 5]} intensity={1.6} />
        <directionalLight position={[-3, 2, 1]} intensity={0.5} />
        {geometry ? (
          <mesh geometry={geometry} matrixAutoUpdate={!modelMatrix} matrix={modelMatrix}>
            <meshStandardMaterial color="#c9ced8" roughness={0.55} metalness={0.05} side={DoubleSide} />
          </mesh>
        ) : null}
        <Grid
          position={[stableBox.getCenter(new Vector3()).x, stableBox.getCenter(new Vector3()).y, groundZ]}
          rotation={[Math.PI / 2, 0, 0]}
          cellSize={cell}
          sectionSize={cell * 10}
          cellColor="#3a3a3a"
          sectionColor="#5a5a5a"
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={Math.max(size.x, size.y, size.z) * 8 || 10}
          infiniteGrid
        />
        <WindArrow box={stableBox} />
        <CameraRig box={stableBox} view={view} nonce={nonce} />
        <OrbitControls makeDefault enableDamping={false} />
        <GizmoHelper alignment="bottom-left" margin={compact ? [46, 46] : [56, 56]}>
          <GizmoViewport axisColors={['#e06c6c', '#7fbf7f', '#7aa2f7']} labelColor="#111" />
        </GizmoHelper>
        {onThumbnail ? <Thumbnail ready={Boolean(geometry)} onCapture={onThumbnail} /> : null}
        {children}
      </Canvas>
      <div className={`absolute top-2 left-2 flex ${compact ? 'gap-0.5' : 'gap-1'}`}>
        {(Object.keys(VIEW_DIRECTIONS) as ViewName[]).map((name) => (
          <button
            key={name}
            className={`rounded ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'} ${view === name ? 'bg-accent text-ink-950' : 'bg-ink-850/90 text-ink-200 hover:bg-ink-700'}`}
            onClick={() => {
              setView(name)
              setNonce((n) => n + 1)
            }}
          >
            {t(VIEW_LABELS[name])}
          </button>
        ))}
      </div>
      {compact ? null : (
        <div className="pointer-events-none absolute right-2 bottom-2 rounded bg-ink-850/90 px-2 py-1 text-xs text-ink-300">
          {t('scene.wind')} · {t('scene.grid', { size: metres(cell) })}
        </div>
      )}
    </div>
  )
}
