// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel (SPEC §24, /galleria3d/:id): a whole model in a coarse D3Q19
// tunnel on WebGPU, with smoke from a movable rake, particles, a cut plane
// coloured by speed or Cp, and Cp on the model's surface, seen from a free
// camera.
//
// Who decides what, as in 2D: the geometry thread turns the full mesh and
// voxelizes it; the 3D planner (backend) turns the conditions into a plan;
// the engine (sim3d/engine.ts) runs and draws it. Speed, fluid, floor,
// resolution and the rotations restart the flow from rest (SPEC §24.2 #4);
// the camera and the views never touch it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { Tip } from '../components/Tip'
import { GuideLink } from '../guide/Guide'
import { api, requestBuffer } from '../lib/api'
import { isTextField, metres, num } from '../lib/format'
import { parseMesh } from '../lib/meshBinary'
import { setUnsaved } from '../lib/busy'
import { useSetSetting, useSettings } from '../lib/settings'
import { token, useTheme } from '../lib/theme'
import type { AppSettings, CasePlan3D, CaseSetup3D, Fluid, Ground, InletProfile, ModelRecord, ReferenceKind, Resolution, StudyMeta, StudyTypePreset } from '../lib/types'
import { VIEW_THRESHOLD } from '../scene3d/useModelGeometry'
import type { CameraView } from '../sim3d/camera'
import { Engine3D, type Snapshot3D, type ViewOptions3D } from '../sim3d/engine'
import { WebGpuUnsupported } from '../sim3d/gpu'
import { hexColor, vertexNormals, type BodyMesh, type PlaneAxis, type Rake } from '../sim3d/scene'
import type { Box3, Vec3 } from '../sim3d/voxelize'
import { VoxelClient } from '../sim3d/voxelProtocol'
import type { WallLinks } from '../sim3d/voxelize'
import { cellText } from '../study/present'
import { rememberedCase } from '../tunnel/lastCase'
import { Results3D, type Save3D } from '../tunnel/Results3D'
import { metaPart, packParts } from '../tunnel/study'
import { collectPoint3d } from '../tunnel/study3d'
import { Badge, Legend, NumberField, Panel, Row, Select, digitsFor } from '../tunnel/parts'
import { t, type MessageKey } from '../i18n/it'

type Case3DState = {
  fluid: Fluid
  temperature_c: number
  speed: number
  ground: Ground
  inlet_profile: InletProfile
  resolution: Resolution
  reference_kind: ReferenceKind
  max_blockage: number
  re_sim_scale: number
}

type Prep = 'mesh' | 'plan' | 'voxels' | 'solver' | null

const SPEED_LIMITS: [number, number] = [0.1, 120]
const TEMPERATURES: Record<Fluid, [number, number]> = { aria: [-20, 50], acqua: [5, 40] }
/** SPEC §24.3: the chamber keeps the area blockage to 8%, 10% for vehicles. */
const blockageFor = (preset: StudyTypePreset) => (preset.id === 'veicolo' ? 0.1 : 0.08)

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}


export function Tunnel3DPage() {
  const { id = '' } = useParams()
  const model = useQuery({ queryKey: ['model', id], queryFn: () => api.model(id) })
  const types = useQuery({ queryKey: ['study-types'], queryFn: api.studyTypes, staleTime: Infinity })
  const settings = useSettings()
  if (model.isError || types.isError)
    return (
      <div className="space-y-3 p-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← {t('nav.library')}
        </Link>
        <ErrorNotice error={model.error ?? types.error} />
      </div>
    )
  if (!model.data || !types.data || !settings.loaded) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const preset = types.data.find((p) => p.id === model.data.study_type) ?? types.data[0]
  return <Bench3D key={model.data.id} model={model.data} preset={preset} settings={settings.values} />
}

/** The model's meshes: the view mesh for drawing, the full one in the geometry thread. */
type Geometry = { body: BodyMesh; pivot: Vec3; size: Vec3; voxels: VoxelClient }

function useGeometry(model: ModelRecord): { geometry: Geometry | null; error: unknown } {
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    const controller = new AbortController()
    const worker = new Worker(new URL('../sim3d/voxel.worker.ts', import.meta.url), { type: 'module' })
    const client = new VoxelClient(worker)
    const useView = model.repaired_report.triangles > VIEW_THRESHOLD
    ;(async () => {
      const full = await requestBuffer(api.meshUrl(model.id, false), controller.signal)
      const viewBuffer = useView ? await requestBuffer(api.meshUrl(model.id, true), controller.signal) : full.slice(0)
      const view = parseMesh(viewBuffer)
      const loaded = await client.load(full)
      if (controller.signal.aborted) return
      setGeometry({
        body: { positions: view.positions, indices: view.indices, normals: vertexNormals(view.positions, view.indices) },
        pivot: loaded.pivot,
        size: loaded.size,
        voxels: client,
      })
    })().catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e)
    })
    return () => {
      controller.abort()
      client.dispose()
    }
  }, [model.id, model.view, model.repaired_report.triangles])
  return { geometry, error }
}

function Bench3D({ model, preset, settings }: { model: ModelRecord; preset: StudyTypePreset; settings: AppSettings }) {
  const setSetting = useSetSetting()
  const unit = settings.unita_velocita
  const speedFactor = unit === 'km/h' ? 3.6 : 1
  const query = new URLSearchParams(window.location.search)
  const benchMode = query.get('bench')
  const benchResolution = query.get('risoluzione') as Resolution | null
  const [state, setState] = useState<Case3DState>(() => {
    const remembered = rememberedCase(settings)
    return {
      fluid: remembered.fluid ?? settings.fluido_predefinito,
      temperature_c: remembered.temperature_c ?? settings.temperatura_predefinita_c,
      speed: preset.speed_ms,
      ground: preset.ground,
      inlet_profile: preset.inlet_profile,
      resolution: (benchMode && benchResolution) || (remembered.resolution ?? settings.risoluzione),
      reference_kind: preset.reference_length === 'chord' ? 'length_x' : preset.reference_length,
      max_blockage: blockageFor(preset),
      re_sim_scale: 1,
    }
  })
  const [yaw, setYaw] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [released, setReleased] = useState({ yaw: 0, pitch: 0 })
  const [engine, setEngine] = useState<Engine3D | null>(null)
  const [support, setSupport] = useState<'pending' | 'ok' | 'none'>('pending')
  const [engineError, setEngineError] = useState<unknown>(null)
  const [engineKey, setEngineKey] = useState(0)
  const [lost, setLost] = useState(false)
  const [plan, setPlan] = useState<CasePlan3D | null>(null)
  const [bodyBox, setBodyBox] = useState<Box3 | null>(null)
  const [voxelInfo, setVoxelInfo] = useState<{ cells: number; area: number } | null>(null)
  const [prep, setPrep] = useState<Prep>('mesh')
  const [planError, setPlanError] = useState<unknown>(null)
  const [snap, setSnap] = useState<Snapshot3D | null>(null)
  const [recording, setRecording] = useState<{ since: number } | null>(null)
  const [bench, setBench] = useState<Record<string, number | string> | null>(null)
  const [view, setView] = useState<ViewOptions3D>({
    plane: { shown: true, axis: 1, position: 0, field: 'speed' },
    surfaceCp: Boolean(benchMode),
    voxels: false,
    smoke: Boolean(benchMode),
    particles: Boolean(benchMode),
    rake: null,
    sequential: settings.mappa_sequenziale,
    diverging: settings.mappa_divergente,
    locked: null,
  })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const userPaused = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const latest = useRef({ state, plan, view, yaw, pitch })
  latest.current = { state, plan, view, yaw, pitch }
  const { geometry, error: geometryError } = useGeometry(model)

  // --- the engine ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let made: Engine3D | null = null
    let cancelled = false
    Engine3D.create(canvas)
      .then((e) => {
        if (cancelled) {
          e.dispose()
          return
        }
        made = e
        e.onUpdate = setSnap
        e.onUnstable = () => setSnap(e.snapshot())
        e.onLost = (message) => {
          setLost(true)
          void api.log('dispositivo WebGPU perso', message, 'warning').catch(() => undefined)
        }
        setSupport('ok')
        setEngine(e)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof WebGpuUnsupported) setSupport('none')
        else setEngineError(error)
      })
    return () => {
      cancelled = true
      made?.dispose()
      setEngine(null)
    }
  }, [engineKey])

  const theme = useTheme()
  useEffect(() => {
    engine?.setColors({
      background: hexColor(token('ink-900')),
      body: hexColor(token('body')),
      floor: hexColor(token('ink-800')),
      line: hexColor(token('ink-400')),
      smoke: hexColor(token('ink-50'), 0.85),
    })
  }, [engine, theme])
  useEffect(() => {
    setView((v) => ({ ...v, sequential: settings.mappa_sequenziale, diverging: settings.mappa_divergente }))
  }, [settings.mappa_sequenziale, settings.mappa_divergente])
  useEffect(() => engine?.setOptions(view), [engine, view])
  const fixedSteps = settings.passi_per_frame === 'auto' ? null : settings.passi_per_frame
  useEffect(() => engine?.setStepsPerFrame(fixedSteps), [engine, fixedSteps])

  // The body drawn at the rotations being dragged; the flow waits for the release.
  useEffect(() => {
    if (engine && geometry) engine.setBody(geometry.body, yaw, pitch)
  }, [engine, geometry, yaw, pitch])

  // --- the case: body → plan → voxels → plan with the voxels' area → solver ------------
  const physicsKey = JSON.stringify(state)
  const voxelCache = useRef<{ key: string; voxels: Uint8Array; walls: WallLinks; frontalCells: number } | null>(null)
  const caseSeq = useRef(0)
  const framed = useRef(false)
  /** The setup of the plan running, and when it started (a study saves both). */
  const running = useRef<{ setup: CaseSetup3D; since: number } | null>(null)
  useEffect(() => {
    if (!engine || !geometry) return
    const seq = ++caseSeq.current
    const stale = () => seq !== caseSeq.current
    const s = latest.current.state
    const { yaw: y, pitch: p } = released
    ;(async () => {
      setPrep('plan')
      const body = await geometry.voxels.body(y, p)
      if (stale()) return
      const setup: CaseSetup3D = {
        model_id: model.id,
        name: model.name,
        pivot: geometry.pivot,
        model_size: geometry.size,
        body_box: body.box,
        frontal_area_m2: body.area,
        yaw_deg: y,
        pitch_deg: p,
        fluid: s.fluid,
        temperature_c: s.temperature_c,
        speed: s.speed,
        ground: s.ground,
        inlet_profile: s.ground === 'none' ? 'uniform' : s.inlet_profile,
        resolution: s.resolution,
        reference_length: { kind: s.reference_kind, value_m: null },
        reference_area_m2: null,
        max_blockage: s.max_blockage,
        re_sim_scale: s.re_sim_scale,
      }
      const first = await api.plan3d(setup)
      if (stale()) return
      const key = [y, p, first.nx, first.ny, first.nz, first.dx, ...first.offset].join(':')
      let cached = voxelCache.current
      if (cached?.key !== key) {
        setPrep('voxels')
        const g = { nx: first.nx, ny: first.ny, nz: first.nz, dx: first.dx, offset: first.offset }
        const made = await geometry.voxels.voxels(y, p, g, model.repaired_report.watertight)
        if (stale()) return
        cached = voxelCache.current = { key, voxels: made.voxels, walls: made.walls, frontalCells: made.frontalCells }
      }
      // The coefficients' area is the voxels' frontal area (SPEC §24.6): same grid, new numbers.
      const area = cached.frontalCells * first.dx * first.dx
      const second = area > 0 ? await api.plan3d({ ...setup, reference_area_m2: area }) : first
      if (stale()) return
      const same = second.nx === first.nx && second.ny === first.ny && second.nz === first.nz && second.dx === first.dx
      const chosen = same ? second : first
      setPrep('solver')
      await engine.setCase({ plan: chosen, voxels: cached.voxels, walls: cached.walls, voxelKey: key, pivot: geometry.pivot })
      if (stale()) return
      running.current = { setup: same ? { ...setup, reference_area_m2: area } : setup, since: performance.now() }
      let solid = 0
      for (const v of cached.voxels) solid += v
      setVoxelInfo({ cells: solid, area })
      setPlan(chosen)
      setPlanError(null)
      setPrep(null)
      const [ox, oy, oz] = chosen.offset
      const box: Box3 = [body.box[0] + ox, body.box[1] + oy, body.box[2] + oz, body.box[3] + ox, body.box[4] + oy, body.box[5] + oz]
      setBodyBox(box)
      if (!framed.current) {
        framed.current = true
        engine.frameBody(box)
      }
      if (!userPaused.current) engine.play()
    })().catch((error: unknown) => {
      if (stale()) return
      setPlanError(error)
      setPrep(null)
    })
  }, [engine, geometry, physicsKey, released, model.id, model.name, model.repaired_report.watertight])

  // Plane and rake follow the body: placed in front of / through it the first
  // time; after a new plan they move with it (a rotation shifts the body in a
  // new chamber) and stay inside the chamber.
  const placedAt = useRef<Vec3 | null>(null)
  useEffect(() => {
    if (!plan || !bodyBox) return
    const size = [plan.nx * plan.dx, plan.ny * plan.dx, plan.nz * plan.dx]
    const [x0, y0, z0, , y1, z1] = bodyBox
    const before = placedAt.current
    const d = before ? plan.offset.map((v, i) => v - before[i]) : [0, 0, 0]
    placedAt.current = plan.offset
    const inside = (v: number, a: number) => Math.min(size[a], Math.max(0, v))
    setView((v) => {
      const axis = v.plane.axis
      const plane = before ? { ...v.plane, position: inside(v.plane.position + d[axis], axis) } : { ...v.plane, position: (y0 + y1) / 2 }
      let rake: Rake = { orientation: 'horizontal', x: x0 / 2, across: (z0 + z1) / 2, centre: (y0 + y1) / 2, span: 1.2 * (y1 - y0), nozzles: 15 }
      if (before && v.rake) {
        const [across, along] = v.rake.orientation === 'horizontal' ? [2, 1] : [1, 2]
        rake = { ...v.rake, x: inside(v.rake.x + d[0], 0), across: inside(v.rake.across + d[across], across), centre: inside(v.rake.centre + d[along], along) }
      }
      return { ...v, plane, rake }
    })
  }, [plan, bodyBox])

  /** The plane's default place on an axis: through the body, or in its wake across the wind. */
  const planeDefault = useCallback(
    (axis: PlaneAxis): number => {
      if (!bodyBox) return 0
      const [x0, y0, z0, x1, y1, z1] = bodyBox
      if (axis === 0) return x1 + 0.5 * (x1 - x0)
      return axis === 1 ? (y0 + y1) / 2 : (z0 + z1) / 2
    },
    [bodyBox],
  )

  const resetRake = useCallback(
    (orientation: Rake['orientation']) => {
      if (!bodyBox) return
      const [x0, y0, z0, , y1, z1] = bodyBox
      setView((v) => ({
        ...v,
        rake: {
          orientation,
          x: x0 / 2,
          across: orientation === 'horizontal' ? (z0 + z1) / 2 : (y0 + y1) / 2,
          centre: orientation === 'horizontal' ? (y0 + y1) / 2 : (z0 + z1) / 2,
          span: 1.2 * (orientation === 'horizontal' ? y1 - y0 : z1 - z0),
          nozzles: v.rake?.nozzles ?? 15,
        },
      }))
    },
    [bodyBox],
  )

  // --- controls ---------------------------------------------------------------------
  const set = <K extends keyof Case3DState>(key: K, value: Case3DState[K]) => setState((s) => ({ ...s, [key]: value }))
  const play = useCallback(() => {
    userPaused.current = false
    engine?.play()
  }, [engine])
  const pause = useCallback(() => {
    userPaused.current = true
    engine?.pause()
  }, [engine])
  const releaseRotation = () => {
    setReleased((r) => (r.yaw === latest.current.yaw && r.pitch === latest.current.pitch ? r : { yaw: latest.current.yaw, pitch: latest.current.pitch }))
  }
  const dragRotation = (setter: (v: number) => void, v: number) => {
    engine?.pause()
    setter(v)
  }
  const setPlane = (change: Partial<ViewOptions3D['plane']>) => setView((v) => ({ ...v, plane: { ...v.plane, ...change } }))
  const setRake = (change: Partial<Rake>) => setView((v) => (v.rake ? { ...v, rake: { ...v.rake, ...change } } : v))
  const lookFrom = (which: CameraView) => engine?.camera.look(which)

  // --- camera on the canvas ---------------------------------------------------------
  const drag = useRef<{ x: number; y: number; pan: boolean } | null>(null)
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey }
    if (event.button === 1) event.preventDefault()
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || !engine) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (d.pan) engine.camera.pan(dx, dy, (event.target as HTMLElement).clientHeight)
    else engine.camera.orbit(dx, dy)
    drag.current = { ...d, x: event.clientX, y: event.clientY }
  }
  const onPointerUp = () => {
    drag.current = null
  }
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !engine) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const lines = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      engine.camera.zoom(Math.exp(lines * 0.0015))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [engine])

  // --- snapshot and video (SPEC §24.2 #7, as §10.7) -------------------------------------
  const caption = useCallback((): string[] => {
    const p = latest.current.plan
    const s = latest.current.state
    if (!p) return []
    const lines = [
      t('tunnel.snapshot.title', { name: model.name, date: new Date().toLocaleString('it-IT') }),
      t('tunnel3d.snapshot.conditions', {
        fluid: t(`tunnel.fluid.${s.fluid}` as MessageKey),
        temperature: num(s.temperature_c, 1),
        speed: `${num(s.speed, 2)} m/s`,
        yaw: num(p.yaw_deg, 1),
        pitch: num(p.pitch_deg, 1),
        reynolds: p.texts.reynolds,
        grid: p.texts.grid,
        step: engine?.step ?? 0,
      }),
      t(p.partial_similarity ? 'tunnel3d.snapshot.badges' : 'tunnel3d.snapshot.coarse', { cell: cellText(p.dx) }),
    ]
    return lines
  }, [engine, model.name])

  const takeSnapshot = useCallback(async () => {
    const image = await engine?.renderLarge(2)
    if (!image) return
    const lines = caption()
    const legends = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="legends3d"] [data-testid="legend"]')).map((l) => l.innerText.replace(/\n+/g, '   '))
    const pad = 16
    const lineHeight = 28
    const out = document.createElement('canvas')
    out.width = image.width
    out.height = image.height + pad * 2 + lineHeight * (lines.length + legends.length) + 16
    const ctx = out.getContext('2d')!
    ctx.fillStyle = token('ink-900')
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(image, 0, 0)
    ctx.fillStyle = token('ink-100')
    ctx.font = '22px sans-serif'
    let y = image.height + pad + 22
    for (const line of [...legends, ...lines]) {
      ctx.fillText(line, pad, y)
      y += lineHeight
    }
    out.toBlob((blob) => blob && download(blob, `galleria3d-${stamp()}.png`), 'image/png')
  }, [engine, caption])

  // --- «Salva studio» (SPEC §24.2 #7) ---------------------------------------------------
  const saver: Save3D = {
    defaultName: () => {
      const p = latest.current.plan
      return t('tunnel3d.save.defaultName', { name: model.name, speed: num(latest.current.state.speed, 2), yaw: num(p?.yaw_deg ?? 0, 1) })
    },
    save: async (name, notes) => {
      const p = latest.current.plan
      const r = running.current
      if (!engine || !p || !r || !bodyBox) return null
      const point = await collectPoint3d(engine, {
        setup: r.setup,
        plan: p,
        elapsedSeconds: (performance.now() - r.since) / 1000,
        lines: caption(),
        box: bodyBox,
        options: latest.current.view,
        sequential: latest.current.view.sequential,
        diverging: latest.current.view.diverging,
      })
      if (!point) return null
      const meta: StudyMeta = { name, notes, profile_id: null, profile_name: model.name, model_id: model.id, model_name: model.name, series: null }
      const parts = [metaPart(meta), ...point.parts]
      if (point.thumbnail) parts.push({ name: 'miniatura', data: point.thumbnail })
      const study = await api.createStudy(packParts(parts))
      const s = engine.snapshot()
      savedWindow.current = s.step - s.stats.averagedSteps
      setSavedTick((n) => n + 1)
      return { id: study.id, name: study.name }
    },
  }

  // Results not saved as a study: closing the window asks first (SPEC §13), as in 2D.
  const savedWindow = useRef<number | null>(null)
  const [savedTick, setSavedTick] = useState(0)
  const averagingFrom = snap ? snap.step - snap.stats.averagedSteps : null
  const hasNumbers = Boolean(snap?.stats.cd && !snap.unstable)
  useEffect(() => {
    setUnsaved(hasNumbers && averagingFrom !== savedWindow.current ? t('tunnel.unsavedLeave') : null)
  }, [hasNumbers, averagingFrom, savedTick])
  useEffect(() => () => setUnsaved(null), [])

  const stopRecording = useCallback(() => {
    recorder.current?.stop()
    recorder.current = null
    if (engine) engine.onFrame = null
    setRecording(null)
  }, [engine])

  const startRecording = useCallback(() => {
    if (!engine || recorder.current) return
    const type = 'video/webm;codecs=vp9'
    if (!('MediaRecorder' in window) || !MediaRecorder.isTypeSupported(type)) return
    const comp = document.createElement('canvas')
    const ctx = comp.getContext('2d')!
    const lines = caption()
    engine.onFrame = () => {
      const w = engine.canvas.width
      const h = engine.canvas.height
      if (comp.width !== w || comp.height !== h + 60) {
        comp.width = w
        comp.height = h + 60
      }
      ctx.fillStyle = token('ink-900')
      ctx.fillRect(0, 0, comp.width, comp.height)
      ctx.drawImage(engine.canvas, 0, 0)
      ctx.fillStyle = token('ink-100')
      ctx.font = '16px sans-serif'
      lines.slice(1, 3).forEach((line, i) => ctx.fillText(line, 10, h + 22 + i * 20))
    }
    const r = new MediaRecorder(comp.captureStream(30), { mimeType: type })
    const chunks: Blob[] = []
    r.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
    r.onstop = () => download(new Blob(chunks, { type: 'video/webm' }), `galleria3d-${stamp()}.webm`)
    r.start(1000)
    recorder.current = r
    setRecording({ since: performance.now() })
  }, [engine, caption])

  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => {
      if (performance.now() - recording.since > 120_000) stopRecording()
    }, 500)
    return () => window.clearInterval(id)
  }, [recording, stopRecording])
  useEffect(() => () => recorder.current?.stop(), [])

  // --- keyboard (SPEC §12.2, and the 3D tunnel's own keys) ------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTextField(event.target) || event.ctrlKey || event.metaKey || event.altKey || !engine) return
      const p = latest.current.plan
      switch (event.key) {
        case ' ':
          if (engine.isRunning) pause()
          else play()
          break
        case 'r':
        case 'R':
          engine.restart()
          break
        case '.':
          userPaused.current = true
          engine.stepOnce()
          break
        case '1':
          setPlane({ shown: true, field: 'speed' })
          break
        case '2':
          setPlane({ shown: true, field: 'cp' })
          break
        case '3':
          setView((v) => ({ ...v, surfaceCp: !v.surfaceCp }))
          break
        case '4':
          setView((v) => ({ ...v, smoke: !v.smoke }))
          break
        case '5':
          setView((v) => ({ ...v, particles: !v.particles }))
          break
        case '7':
          setView((v) => ({ ...v, voxels: !v.voxels }))
          break
        case '6':
          setView((v) => ({ ...v, plane: { ...v.plane, shown: !v.plane.shown } }))
          break
        case 'PageUp':
        case 'PageDown': {
          if (!p) return
          const a = latest.current.view.plane.axis
          const size = [p.nx, p.ny, p.nz][a] * p.dx
          const step = (event.shiftKey ? 10 : 1) * p.dx * (event.key === 'PageUp' ? 1 : -1)
          setPlane({ position: Math.min(size, Math.max(0, latest.current.view.plane.position + step)) })
          break
        }
        case '0':
          engine.camera.look('iso')
          break
        case '+':
        case '=':
          engine.camera.zoom(1 / 1.25)
          break
        case '-':
          engine.camera.zoom(1.25)
          break
        case 's':
        case 'S':
          void takeSnapshot()
          break
        case 'v':
        case 'V':
          if (recorder.current) stopRecording()
          else startRecording()
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, play, pause, takeSnapshot, startRecording, stopRecording])

  // --- benchmark (?bench=1[&risoluzione=…]: SPEC §24.4, ≥ 30 fps at Normale with smoke and
  // particles; here with the plane and Cp on the surface too) ---------------------------
  useEffect(() => {
    if (!benchMode || !plan || !engine || bench) return
    const samples: { sps: number; fps: number }[] = []
    const start = performance.now()
    const id = window.setInterval(() => {
      const s = engine.snapshot()
      const elapsed = performance.now() - start
      if (elapsed > 4000) samples.push({ sps: s.stepsPerSecond, fps: s.fps })
      if (elapsed > 24_000) {
        window.clearInterval(id)
        const p5 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.05)]
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
        setBench({
          nx: plan.nx,
          ny: plan.ny,
          nz: plan.nz,
          cells: plan.nx * plan.ny * plan.nz,
          stepsMean: mean(samples.map((x) => x.sps)),
          stepsP5: p5(samples.map((x) => x.sps)),
          fpsMean: mean(samples.map((x) => x.fps)),
          fpsP5: p5(samples.map((x) => x.fps)),
          stepsPerFrame: s.stepsPerFrame,
          samples: samples.length,
          adapter: engine.adapter,
        })
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [benchMode, plan, engine, bench])

  // --- what is shown ----------------------------------------------------------------------
  const size = plan ? [plan.nx * plan.dx, plan.ny * plan.dx, plan.nz * plan.dx] : [1, 1, 1]
  const rake = view.rake
  const rakeCross = rake ? (rake.orientation === 'horizontal' ? size[2] : size[1]) : 1
  const rakeAlong = rake ? (rake.orientation === 'horizontal' ? size[1] : size[2]) : 1
  const ranges = snap?.ranges
  const partialTip = plan
    ? t('tunnel3d.badge.partial.tip', { sim: num(plan.re_sim, 0), real: num(plan.re_real, 0) })
    : ''
  const badges = plan ? (
    <>
      {plan.partial_similarity ? (
        <Badge tip={partialTip} tone="warn" testId="badge-partial">
          {t('tunnel.badge.partial')}
        </Badge>
      ) : null}
      <Badge tip={t('tunnel3d.badge.coarse.tip', { cell: cellText(plan.dx) })} testId="badge-coarse">
        {t('tunnel3d.badge.coarse')}
      </Badge>
    </>
  ) : null

  if (support === 'none')
    return (
      <div className="space-y-3 p-6">
        <Link to={`/modelli/${model.id}`} className="text-sm text-accent hover:underline">
          {t('tunnel.back.model')}
        </Link>
        <p className="max-w-xl text-ink-100" role="alert" data-testid="no-webgpu">
          {t('tunnel3d.noWebGpu')}
        </p>
      </div>
    )

  const prepText: Record<Exclude<Prep, null>, MessageKey> = {
    mesh: 'tunnel3d.prep.mesh',
    plan: 'tunnel3d.prep.plan',
    voxels: 'tunnel3d.prep.voxels',
    solver: 'tunnel3d.prep.solver',
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-700 bg-ink-850 px-4 py-1.5 text-xs text-ink-200" data-testid="tunnel-top">
        <Link to={`/modelli/${model.id}`} className="text-accent hover:underline">
          {t('tunnel.back.model')}
        </Link>
        <span className="font-semibold text-ink-50">{t('tunnel3d.title', { name: model.name })}</span>
        {plan ? (
          <>
            <Tip text={t('tunnel.top.reynolds.tip')}>
              <span className="cursor-help" data-testid="top-reynolds">
                {plan.texts.reynolds}
              </span>
            </Tip>
            <Tip text={t('tunnel.top.mach.tip')}>
              <span className="cursor-help">{plan.texts.mach}</span>
            </Tip>
            <Tip text={t('tunnel3d.top.blockage.tip')}>
              <span className={`cursor-help ${plan.blockage > 0.1 ? 'text-warn' : ''}`} data-testid="top-blockage">
                {t('tunnel3d.top.blockage', { value: num(plan.blockage * 100, 1) })}
              </span>
            </Tip>
            <Tip text={t('tunnel.top.grid.tip')}>
              <span className="cursor-help">{plan.texts.grid}</span>
            </Tip>
            <Tip text={t('tunnel3d.top.cells.tip')}>
              <span className="cursor-help">{t('tunnel3d.top.cells', { value: num(plan.l_lat, 0) })}</span>
            </Tip>
            <Tip text={t('tunnel.top.tau.tip')}>
              <span className="cursor-help">τ {num(plan.tau, 4)}</span>
            </Tip>
            <GuideLink section="tunnel3d" />
            <span data-testid="top-steps">{t('tunnel.top.steps', { value: num(snap?.stepsPerSecond ?? 0, 0) })}</span>
            <span data-testid="top-fps">{t('tunnel.top.fps', { value: snap?.fps ?? 0 })}</span>
          </>
        ) : (
          <span>{t('tunnel3d.loading')}</span>
        )}
        <span className="flex flex-wrap gap-1.5">{badges}</span>
        <Link to={`/galleria/modello/${model.id}`} className="ml-auto text-accent hover:underline">
          {t('tunnel3d.open2d')}
        </Link>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-r border-ink-700 bg-ink-850 p-3 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Button kind="primary" onClick={() => (snap?.running ? pause() : play())} label={snap?.running ? t('tunnel.pause') : t('tunnel.play')}>
              {snap?.running ? '❚❚' : '▶'}
            </Button>
            <Button onClick={() => engine?.restart()} title={t('tunnel.restart')} label={t('tunnel.restart')}>
              ⟲
            </Button>
            <Button
              onClick={() => {
                userPaused.current = true
                engine?.stepOnce()
              }}
              title={t('tunnel.step')}
              label={t('tunnel.step')}
            >
              ⏭
            </Button>
            <Button onClick={() => void takeSnapshot()} title={t('tunnel.snapshot')} label={t('tunnel.snapshot')}>
              📷
            </Button>
            <Button kind={recording ? 'danger' : 'secondary'} onClick={() => (recording ? stopRecording() : startRecording())} title={t('tunnel.record')} label={t('tunnel.record')}>
              ●
            </Button>
          </div>

          <Panel title={t('tunnel.conditions')} tip={t('tunnel.replan.tip')} guide={{ section: 'tunnel3d', entry: 'restart' }}>
            <Row label={t('tunnel.fluid')}>
              <Select<Fluid>
                value={state.fluid}
                label={t('tunnel.fluid')}
                options={[
                  { value: 'aria', label: t('tunnel.fluid.aria') },
                  { value: 'acqua', label: t('tunnel.fluid.acqua') },
                ]}
                onChange={(fluid) =>
                  setState((s) => {
                    const [lo, hi] = TEMPERATURES[fluid]
                    return { ...s, fluid, temperature_c: Math.min(hi, Math.max(lo, s.temperature_c)) }
                  })
                }
              />
            </Row>
            <Row label={t('tunnel.temperature')}>
              <NumberField
                value={state.temperature_c}
                min={TEMPERATURES[state.fluid][0]}
                max={TEMPERATURES[state.fluid][1]}
                digits={1}
                label={t('tunnel.temperature')}
                onCommit={(v) => set('temperature_c', v)}
              />
            </Row>
            <Row label={`${t('tunnel.speed')} (${unit})`}>
              <span className="flex items-center gap-1">
                <NumberField
                  value={state.speed * speedFactor}
                  min={SPEED_LIMITS[0] * speedFactor}
                  max={SPEED_LIMITS[1] * speedFactor}
                  digits={2}
                  label={t('tunnel.speed')}
                  testId="speed"
                  onCommit={(v) => set('speed', v / speedFactor)}
                />
                <button
                  className="rounded px-1 text-xs text-accent hover:underline"
                  aria-label={t('tunnel.speed.unit')}
                  onClick={() => setSetting.mutate({ key: 'unita_velocita', value: unit === 'km/h' ? 'm/s' : 'km/h' })}
                >
                  ⇄
                </button>
              </span>
            </Row>
            <Row label={t('tunnel.ground')} tip={t('tunnel.ground.tip')}>
              <Select<Ground>
                value={state.ground}
                label={t('tunnel.ground')}
                testId="ground"
                options={(['none', 'fixed', 'moving'] as Ground[]).map((g) => ({ value: g, label: t(`studyType.ground.${g}` as MessageKey) }))}
                onChange={(g) => setState((s) => ({ ...s, ground: g, inlet_profile: g === 'none' ? 'uniform' : s.inlet_profile }))}
              />
            </Row>
            <Row label={t('tunnel.inlet')} tip={t('tunnel.inlet.bl.tip')}>
              <Select<InletProfile>
                value={state.ground === 'none' ? 'uniform' : state.inlet_profile}
                label={t('tunnel.inlet')}
                disabled={state.ground === 'none'}
                options={(['uniform', 'boundary_layer'] as InletProfile[]).map((v) => ({ value: v, label: t(`studyType.inlet.${v}` as MessageKey) }))}
                onChange={(v) => set('inlet_profile', v)}
              />
            </Row>
            <Row label={t('tunnel.resolution')}>
              <Select<Resolution>
                value={state.resolution}
                label={t('tunnel.resolution')}
                testId="resolution"
                options={(['bozza', 'normale', 'fine'] as Resolution[]).map((v) => ({ value: v, label: t(`tunnel.resolution.${v}` as MessageKey) }))}
                onChange={(v) => set('resolution', v)}
              />
            </Row>
            <Row label={t('tunnel.reference')}>
              <Select<ReferenceKind>
                value={state.reference_kind}
                label={t('tunnel.reference')}
                options={(['length_x', 'frontal_width', 'frontal_height'] as ReferenceKind[]).map((k) => ({
                  value: k,
                  label: t(`studyType.reference.${k}` as MessageKey),
                }))}
                onChange={(k) => set('reference_kind', k)}
              />
            </Row>
            {plan ? (
              <p className="text-xs text-ink-300" data-testid="chamber3d">
                <Tip text={t('tunnel3d.chamber.tip', { memory: num(plan.memory_mb, 0) })}>
                  <span className="cursor-help">
                    {t('tunnel3d.chamber', { l: metres(size[0]), w: metres(size[1]), h: metres(size[2]) })} ⓘ
                  </span>
                </Tip>
              </p>
            ) : null}
          </Panel>

          <Panel title={t('tunnel3d.model')} guide={{ section: 'tunnel3d', entry: 'rotations' }}>
            {(
              [
                ['tunnel3d.yaw', 'tunnel3d.yaw.tip', yaw, setYaw, 180, 'yaw'],
                ['tunnel3d.pitch', 'tunnel3d.pitch.tip', pitch, setPitch, 90, 'pitch'],
              ] as const
            ).map(([key, tip, value, setter, limit, testId]) => (
              <div key={key} className="space-y-0.5">
                <Row label={t(key)} tip={t(tip)}>
                  <NumberField
                    value={value}
                    min={-limit}
                    max={limit}
                    digits={1}
                    label={t(key)}
                    testId={testId}
                    onCommit={(v) => {
                      setter(v)
                      setReleased((r) => ({ ...r, [testId]: v }))
                    }}
                  />
                </Row>
                <input
                  type="range"
                  min={-limit}
                  max={limit}
                  step={0.5}
                  value={value}
                  className="w-full accent-accent"
                  aria-label={t(key)}
                  onChange={(e) => dragRotation(setter, Number(e.target.value))}
                  onPointerUp={releaseRotation}
                  onKeyUp={releaseRotation}
                />
              </div>
            ))}
            <p className="text-xs text-ink-300">{t('tunnel3d.rotate.note')}</p>
            {voxelInfo ? (
              <Tip text={t('tunnel3d.voxels.tip')}>
                <p className="cursor-help text-xs text-ink-300" data-testid="voxel-info">
                  {t('tunnel3d.voxels', { cells: num(voxelInfo.cells, 0), area: `${num(voxelInfo.area, 4)} m²` })}
                </p>
              </Tip>
            ) : null}
          </Panel>

          <Panel title={t('tunnel3d.view')} guide={{ section: 'tunnel3d' }}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={view.plane.shown} onChange={(e) => setPlane({ shown: e.target.checked })} data-testid="plane-shown" />
              {t('tunnel3d.plane.show')}
            </label>
            {view.plane.shown ? (
              <div className="space-y-1 pl-5">
                {(['speed', 'cp'] as const).map((f) => (
                  <label key={f} className="flex items-center gap-2">
                    <input type="radio" name="plane-field" checked={view.plane.field === f} onChange={() => setPlane({ field: f })} />
                    {t(f === 'speed' ? 'tunnel3d.plane.speed' : 'tunnel3d.plane.cp')}
                  </label>
                ))}
                <Row label={t('tunnel3d.plane.axis')}>
                  <Select<'0' | '1' | '2'>
                    value={String(view.plane.axis) as '0' | '1' | '2'}
                    label={t('tunnel3d.plane.axis')}
                    testId="plane-axis"
                    options={(['0', '1', '2'] as const).map((a) => ({ value: a, label: t(`tunnel3d.plane.axis.${a}` as MessageKey) }))}
                    onChange={(a) => {
                      const axis = Number(a) as PlaneAxis
                      setPlane({ axis, position: planeDefault(axis) })
                    }}
                  />
                </Row>
                <label className="block space-y-0.5">
                  <span className="flex justify-between text-xs text-ink-200">
                    <Tip text={t('tunnel3d.plane.tip')}>
                      <span className="cursor-help">{t('tunnel3d.plane.position')} ⓘ</span>
                    </Tip>
                    <span data-testid="plane-position">{metres(view.plane.position)}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    value={Math.round((view.plane.position / size[view.plane.axis]) * 1000)}
                    onChange={(e) => setPlane({ position: (Number(e.target.value) / 1000) * size[view.plane.axis] })}
                    className="w-full accent-accent"
                    aria-label={t('tunnel3d.plane.position')}
                    data-testid="plane-slider"
                  />
                </label>
              </div>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={view.surfaceCp} onChange={(e) => setView((v) => ({ ...v, surfaceCp: e.target.checked }))} data-testid="surface-cp" />
              {t('tunnel3d.surface')}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={view.smoke} onChange={(e) => setView((v) => ({ ...v, smoke: e.target.checked }))} data-testid="smoke" />
              {t('tunnel3d.smoke')}
            </label>
            {view.smoke && rake ? (
              <div className="space-y-1 pl-5" data-testid="rake-panel">
                <Row label={t('tunnel3d.rake.orientation')}>
                  <Select<Rake['orientation']>
                    value={rake.orientation}
                    label={t('tunnel3d.rake.orientation')}
                    options={[
                      { value: 'horizontal', label: t('tunnel3d.rake.horizontal') },
                      { value: 'vertical', label: t('tunnel3d.rake.vertical') },
                    ]}
                    onChange={resetRake}
                  />
                </Row>
                {(
                  [
                    ['tunnel3d.rake.x', rake.x, size[0], (v: number) => setRake({ x: v }), 'rake-x'],
                    [rake.orientation === 'horizontal' ? 'tunnel3d.rake.height' : 'tunnel3d.rake.lateral', rake.across, rakeCross, (v: number) => setRake({ across: v }), 'rake-across'],
                    ['tunnel3d.rake.span', rake.span, rakeAlong, (v: number) => setRake({ span: v }), 'rake-span'],
                  ] as const
                ).map(([key, value, max, change, testId]) => (
                  <label key={key} className="block space-y-0.5">
                    <span className="flex justify-between text-xs text-ink-200">
                      {t(key)}
                      <span>{metres(value)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      value={Math.round((value / max) * 1000)}
                      onChange={(e) => change((Number(e.target.value) / 1000) * max)}
                      className="w-full accent-accent"
                      aria-label={t(key)}
                      data-testid={testId}
                    />
                  </label>
                ))}
                <Row label={t('tunnel3d.rake.nozzles')}>
                  <NumberField value={rake.nozzles} min={2} max={48} digits={0} label={t('tunnel3d.rake.nozzles')} onCommit={(v) => setRake({ nozzles: Math.round(v) })} />
                </Row>
                <button className="text-xs text-accent hover:underline" onClick={() => resetRake(rake.orientation)}>
                  {t('tunnel3d.rake.reset')}
                </button>
              </div>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={view.particles} onChange={(e) => setView((v) => ({ ...v, particles: e.target.checked }))} data-testid="particles" />
              {t('tunnel3d.particles')}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={view.voxels} onChange={(e) => setView((v) => ({ ...v, voxels: e.target.checked }))} data-testid="show-voxels" />
              <Tip text={t('tunnel3d.showVoxels.tip')}>
                <span>{t('tunnel3d.showVoxels')}</span>
              </Tip>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={view.locked !== null}
                onChange={(e) => setView((v) => ({ ...v, locked: e.target.checked && snap ? snap.ranges : null }))}
              />
              {t('tunnel3d.lock')}
            </label>
          </Panel>

          <Panel title={t('tunnel3d.camera')} tip={t('tunnel3d.camera.tip')}>
            <div className="flex flex-wrap gap-1">
              {(['iso', 'front', 'side', 'top'] as CameraView[]).map((v) => (
                <Button key={v} kind="ghost" onClick={() => lookFrom(v)}>
                  {t(`scene.view.${v}` as MessageKey)}
                </Button>
              ))}
            </div>
          </Panel>
        </aside>

        <section className="relative min-w-0 flex-1 bg-ink-900">
          <canvas
            key={`gpu-${engineKey}`}
            ref={canvasRef}
            className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
            data-testid="tunnel3d-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => e.preventDefault()}
            onDoubleClick={() => lookFrom('iso')}
          />
          <div className="pointer-events-none absolute top-2 left-2 space-y-1 text-xs">
            {prep ? (
              <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-200" data-testid="prep">
                {t(prepText[prep])}
              </p>
            ) : null}
            {snap?.ramping && !prep ? <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('tunnel.ramp')}</p> : null}
            {plan?.mach_warning ? <p className="rounded bg-ink-850/90 px-2 py-1 text-warn">{t('tunnel.warn.mach')}</p> : null}
            {plan && plan.blockage > 0.1 ? (
              <p className="rounded bg-ink-850/90 px-2 py-1 text-warn" data-testid="warn-blockage">
                {t('tunnel.warn.blockage')}
              </p>
            ) : null}
          </div>
          {ranges ? (
            <div className="absolute right-2 bottom-2 space-y-1" data-testid="legends3d">
              {view.plane.shown ? (
                <Legend
                  map={view.plane.field === 'speed' ? view.sequential : view.diverging}
                  range={ranges.plane}
                  title={t(view.plane.field === 'speed' ? 'tunnel3d.legend.plane.speed' : 'tunnel3d.legend.plane.cp')}
                  digits={digitsFor(ranges.plane)}
                />
              ) : null}
              {view.particles && !(view.plane.shown && view.plane.field === 'speed') ? (
                <Legend map={view.sequential} range={ranges.speed} title={t('tunnel3d.legend.speed')} digits={digitsFor(ranges.speed)} />
              ) : null}
              {view.surfaceCp ? <Legend map={view.diverging} range={ranges.surface} title={t('tunnel3d.legend.surface')} digits={digitsFor(ranges.surface)} /> : null}
            </div>
          ) : null}
          {recording ? (
            <p className="absolute top-2 right-2 rounded bg-danger/80 px-2 py-1 text-xs text-ink-950">
              {t('tunnel.recording', { seconds: Math.round((performance.now() - recording.since) / 1000) })}
            </p>
          ) : null}
          {snap?.unstable ? (
            <div className="absolute inset-x-0 top-1/3 mx-auto max-w-md space-y-2 rounded-lg border border-danger/50 bg-ink-850/95 p-4" role="alert" data-testid="unstable">
              <p className="font-semibold text-ink-50">{t('tunnel.unstable')}</p>
              <p className="text-sm text-ink-300">{t('tunnel.unstable.body')}</p>
              <Button kind="primary" onClick={() => set('re_sim_scale', state.re_sim_scale / 2)}>
                {t('tunnel.unstable.retry')}
              </Button>
            </div>
          ) : null}
          {lost ? (
            <div className="absolute inset-x-0 top-1/3 mx-auto max-w-md space-y-2 rounded-lg border border-danger/50 bg-ink-850/95 p-4" role="alert">
              <p className="font-semibold text-ink-50">{t('tunnel.lost')}</p>
              <Button
                kind="primary"
                onClick={() => {
                  setLost(false)
                  framed.current = false
                  setEngineKey((k) => k + 1)
                }}
              >
                {t('tunnel.resume')}
              </Button>
            </div>
          ) : null}
          {planError || engineError || geometryError ? (
            <ErrorNotice error={planError ?? engineError ?? geometryError} className="absolute bottom-12 left-4 max-w-md" />
          ) : null}
          {bench ? (
            <pre className="absolute top-12 left-3 rounded bg-ink-950/90 p-2 text-xs" data-testid="bench-result">
              {JSON.stringify(bench)}
            </pre>
          ) : null}
          {support === 'pending' ? <p className="absolute inset-0 m-auto h-6 w-fit text-ink-300">{t('tunnel3d.loading')}</p> : null}
        </section>
        {plan && snap ? (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-850 p-3" data-testid="results-aside">
            <Results3D plan={plan} snapshot={snap} badges={null} saver={saver} />
          </aside>
        ) : null}
      </div>
    </div>
  )
}
