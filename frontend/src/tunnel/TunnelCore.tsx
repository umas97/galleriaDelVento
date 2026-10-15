// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The tunnel screen (SPEC §12.1 #5) around one body: a saved profile or the
// live section of a model (the wrappers in pages/Tunnel.tsx supply it). The
// canvas fills the middle; conditions and the view on the left, results on
// the right, the plan's numbers and the badges of SPEC §2.3 on top.
//
// Who decides what: the planner (backend) turns the conditions into a plan;
// the engine (sim2d/engine.ts) runs the plan on the GPU; this component only
// keeps the conditions, asks for plans when they change, and passes body,
// placement and view options down. A plan is asked for when a physical
// condition changes, when the geometry the chamber is sized on changes, and on
// release of the incidence -- then with the current chamber, which the
// planner keeps unless the body no longer fits (SPEC §9.2).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { Tip } from '../components/Tip'
import { api } from '../lib/api'
import { isTextField, metres, num } from '../lib/format'
import type { CasePlan, CaseSetup, Fluid, Ground, InletProfile, ProfileDraft, ReferenceKind, Resolution } from '../lib/types'
import type { Pt } from '../profile/geometry'
import { MAX_PROBES, TunnelEngine, type EngineSnapshot, type Probe, type ViewState } from '../sim2d/engine'
import { gpuSupport } from '../sim2d/gl'
import type { OuterRule } from '../sim2d/mask'
import { rakeSeeds } from '../sim2d/streamlines'
import { t, type MessageKey } from '../i18n/it'
import { ProbeChart } from '../charts/ProbeChart'
import { Results } from './Results'
import { Badge, Legend, NumberField, Panel, Row, Select, digitsFor } from './parts'

export type CaseState = {
  fluid: Fluid
  temperature_c: number
  speed: number
  angle_deg: number
  ground: Ground
  inlet_profile: InletProfile
  resolution: Resolution
  reference_kind: ReferenceKind
  reference_mode: 'fixed' | 'section'
  max_blockage: number
  re_sim_scale: number
}

export type TunnelBody = {
  name: string
  /** Loops in profile coordinates (null while the first cut is on its way). */
  loops: Pt[][] | null
  rule: OuterRule
  /** The profile as the case carries it. */
  draft: ProfileDraft | null
  /** For a model: the box over every depth, profile coordinates. */
  envelope: [number, number, number, number] | null
  repaired: boolean
  is3d: boolean
  /** Changes when what the chamber is sized on changes (plane, rotations released). */
  geometryKey: string
  /** True when that change needs a new chamber altogether (a new plane). */
  freshChamber: boolean
  /** Changes when a depth scroll has settled (the "sezione" reference re-measures). */
  depthKey: number
  /** For the snapshot caption. */
  sectionInfo: string | null
}

const STORE = 'tunnel-case'
const SPEED_UNIT = 'speed-unit'
const SPEED_LIMITS: [number, number] = [0.1, 120]

export function rememberedCase(): Partial<CaseState> {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? (JSON.parse(raw) as Partial<CaseState>) : {}
  } catch {
    return {}
  }
}

function remember(state: CaseState): void {
  try {
    const { fluid, temperature_c, speed, resolution } = state
    localStorage.setItem(STORE, JSON.stringify({ fluid, temperature_c, speed, resolution }))
  } catch {
    // nothing to remember it with
  }
}

function readUnit(): 'm/s' | 'km/h' {
  try {
    return localStorage.getItem(SPEED_UNIT) === 'm/s' ? 'm/s' : 'km/h'
  } catch {
    return 'km/h'
  }
}

const TEMPERATURES: Record<Fluid, [number, number]> = { aria: [-20, 50], acqua: [5, 40] }

/** Height of the body across the wind at an incidence (the live blockage). */
function frontalHeight(points: Pt[], pivot: Pt, angleDeg: number): number {
  const a = (-angleDeg * Math.PI) / 180
  const s = Math.sin(a)
  const c = Math.cos(a)
  let lo = Infinity
  let hi = -Infinity
  for (const [x, y] of points) {
    const v = s * (x - pivot[0]) + c * (y - pivot[1])
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  return Number.isFinite(hi) ? hi - lo : 0
}

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

type Tool = 'move' | 'probe' | 'rake'

export function TunnelCore({
  body,
  initial,
  back,
  modelPanel,
  onPlan,
  onPlacement,
}: {
  body: TunnelBody
  initial: CaseState
  back: { to: string; label: string }
  modelPanel?: ReactNode
  onPlan?: (plan: CasePlan) => void
  /** Where the body sits in the chamber and its incidence, whenever they change. */
  onPlacement?: (position: Pt, angleDeg: number) => void
}) {
  const support = useMemo(() => gpuSupport(), [])
  const [state, setState] = useState<CaseState>(initial)
  const [plan, setPlan] = useState<CasePlan | null>(null)
  const [planError, setPlanError] = useState<unknown>(null)
  const [planning, setPlanning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [snap, setSnap] = useState<EngineSnapshot | null>(null)
  const [unit, setUnit] = useState(readUnit)
  const [view, setView] = useState<ViewState>({
    field: 'speed',
    smoke: false,
    particles: false,
    streamlines: false,
    sequential: 'viridis',
    diverging: 'coolwarm',
    locked: null,
  })
  const [tool, setTool] = useState<Tool>('move')
  const [probes, setProbes] = useState<Probe[]>([])
  const [rake, setRake] = useState<[Pt, Pt] | null>(null)
  const [results, setResults] = useState(() => window.innerWidth >= 1440)
  const [lost, setLost] = useState(false)
  const [engineKey, setEngineKey] = useState(0)
  const [recording, setRecording] = useState<{ since: number } | null>(null)
  const [referenceValue, setReferenceValue] = useState<number | null>(null)
  const [bench, setBench] = useState<Record<string, number> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const engine = useRef<TunnelEngine | null>(null)
  const planRef = useRef<CasePlan | null>(null)
  const position = useRef<Pt | null>(null)
  const domain = useRef<{ width_m: number; height_m: number } | null>(null)
  const planSeq = useRef(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const latest = useRef({ state, body, referenceValue })
  latest.current = { state, body, referenceValue }
  const benchMode = new URLSearchParams(window.location.search).get('bench')

  // --- the engine -----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    if (!support.ok || !canvas || !overlay) return
    let e: TunnelEngine
    try {
      e = new TunnelEngine(canvas, overlay)
    } catch (error) {
      setPlanError(error)
      return
    }
    engine.current = e
    e.onUpdate = setSnap
    e.onUnstable = () => setSnap(e.snapshot())
    const onLost = (event: Event) => {
      event.preventDefault()
      setLost(true)
      void api.log('contesto WebGL perso', '', 'warning').catch(() => undefined)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    if (planRef.current) {
      e.setPlan(planRef.current)
      if (latest.current.body.loops) e.setBody({ loops: latest.current.body.loops, rule: latest.current.body.rule })
      e.setPlacement(position.current ?? planRef.current.position, latest.current.state.angle_deg)
    }
    if (!benchMode) e.play()
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      e.dispose()
      engine.current = null
    }
  }, [support.ok, engineKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- plans ------------------------------------------------------------------------
  const requestPlan = useCallback(async (keepChamber: boolean) => {
    const { state: s, body: b, referenceValue: refValue } = latest.current
    if (!b.draft && !b.envelope) return
    const seq = ++planSeq.current
    const draft: ProfileDraft = b.draft ?? {
      name: b.name,
      loops: [],
      spline: null,
      source: { kind: 'editor', derived_from: null, origin: null },
    }
    const setup: CaseSetup = {
      profile: draft,
      envelope: b.envelope,
      position: keepChamber ? position.current : null,
      fluid: s.fluid,
      temperature_c: s.temperature_c,
      speed: s.speed,
      angle_deg: s.angle_deg,
      ground: s.ground,
      inlet_profile: s.ground === 'none' ? 'uniform' : s.inlet_profile,
      domain: keepChamber ? domain.current : null,
      resolution: s.resolution,
      reference_length: {
        kind: s.reference_kind,
        value_m: b.is3d && s.reference_mode === 'fixed' ? refValue : null,
      },
      max_blockage: s.max_blockage,
      re_sim_scale: s.re_sim_scale,
    }
    setPlanning(true)
    try {
      const next = await api.plan(setup)
      if (seq !== planSeq.current) return
      setPlanError(null)
      const previous = planRef.current
      planRef.current = next
      domain.current = { width_m: next.width_m, height_m: next.height_m }
      if (!keepChamber || next.resized || !position.current) position.current = next.position
      if (next.resized && previous) setNotice(t('tunnel.resized'))
      if (b.is3d && s.reference_mode === 'fixed' && refValue === null) setReferenceValue(next.reference_length)
      setPlan(next)
      onPlan?.(next)
      onPlacement?.(position.current, latest.current.state.angle_deg)
      const e = engine.current
      if (e) {
        e.setPlan(next)
        e.setPlacement(position.current, latest.current.state.angle_deg)
      }
    } catch (error) {
      if (seq === planSeq.current) setPlanError(error)
    } finally {
      if (seq === planSeq.current) setPlanning(false)
    }
  }, [onPlan, onPlacement])

  // Physical conditions: same chamber, new grid or τ.
  const physicsKey = JSON.stringify([
    state.fluid,
    state.temperature_c,
    state.speed,
    state.ground,
    state.inlet_profile,
    state.resolution,
    state.reference_kind,
    state.reference_mode,
    state.max_blockage,
    state.re_sim_scale,
    referenceValue,
  ])
  const ready = Boolean(body.draft || body.envelope)
  useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => void requestPlan(planRef.current !== null), 150)
    return () => clearTimeout(id)
  }, [physicsKey, ready, requestPlan])
  // Geometry the chamber is sized on.
  useEffect(() => {
    if (!ready || !planRef.current) return
    void requestPlan(!body.freshChamber)
  }, [body.geometryKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // A "sezione" reference re-measures when a depth scroll settles.
  useEffect(() => {
    if (ready && planRef.current && body.is3d && state.reference_mode === 'section') void requestPlan(true)
  }, [body.depthKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => remember(state), [state])

  // --- body and placement ---------------------------------------------------------
  useEffect(() => {
    if (body.loops) engine.current?.setBody({ loops: body.loops, rule: body.rule })
  }, [body.loops, body.rule])

  const angleTimer = useRef(0)
  const setAngle = useCallback(
    (angle: number, settle = true) => {
      const a = Math.max(-90, Math.min(90, Math.round(angle * 10) / 10))
      setState((s) => ({ ...s, angle_deg: a }))
      latest.current.state = { ...latest.current.state, angle_deg: a }
      if (position.current) {
        engine.current?.setPlacement(position.current, a)
        onPlacement?.(position.current, a)
      }
      window.clearTimeout(angleTimer.current)
      if (settle) angleTimer.current = window.setTimeout(() => void requestPlan(true), 300)
    },
    [requestPlan, onPlacement],
  )

  useEffect(() => engine.current?.setOptions(view), [view])
  useEffect(() => engine.current?.setProbes(probes), [probes, plan])
  useEffect(() => engine.current?.setRake(rake ? rakeSeeds(rake[0], rake[1]) : null), [rake, plan])

  // --- canvas interaction -----------------------------------------------------------
  const drag = useRef<
    | { kind: 'body'; start: Pt; origin: Pt }
    | { kind: 'rotate'; startY: number; angle: number }
    | { kind: 'probe'; index: number }
    | { kind: 'rake'; start: Pt }
    | null
  >(null)

  const probeAt = (cell: Pt): number => {
    const e = engine.current
    if (!e) return -1
    const rect = overlayRef.current!.getBoundingClientRect()
    const cellsPerCss = (planRef.current ? planRef.current.nx : 1) / Math.max(1, rect.width)
    return probes.findIndex((p) => Math.hypot(p.x - cell[0], p.y - cell[1]) < 8 * Math.max(cellsPerCss, 0.5))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const e = engine.current
    const p = planRef.current
    if (!e || !p) return
    const cell = e.toCells(event.clientX, event.clientY)
    if (event.button === 2) return
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    if (tool === 'move') {
      if (event.shiftKey) drag.current = { kind: 'rotate', startY: event.clientY, angle: latest.current.state.angle_deg }
      else if (e.hitsBody(cell) && position.current) drag.current = { kind: 'body', start: cell, origin: position.current }
    } else if (tool === 'probe') {
      const hit = probeAt(cell)
      if (hit >= 0) drag.current = { kind: 'probe', index: hit }
      else if (probes.length < MAX_PROBES && !e.hitsBody(cell) && cell[0] >= 0 && cell[1] >= 0 && cell[0] < p.nx && cell[1] < p.ny) {
        setProbes((list) => [...list, { x: cell[0], y: cell[1] }])
        drag.current = { kind: 'probe', index: probes.length }
      }
    } else if (tool === 'rake') {
      drag.current = { kind: 'rake', start: cell }
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const e = engine.current
    const p = planRef.current
    const d = drag.current
    if (!e || !p || !d) return
    const cell = e.toCells(event.clientX, event.clientY)
    if (d.kind === 'body') {
      const next: Pt = [
        Math.min(p.width_m, Math.max(0, d.origin[0] + (cell[0] - d.start[0]) * p.dx)),
        Math.min(p.height_m, Math.max(0, d.origin[1] + (cell[1] - d.start[1]) * p.dx)),
      ]
      position.current = next
      e.setPlacement(next, latest.current.state.angle_deg)
    } else if (d.kind === 'rotate') {
      setAngle(d.angle + (d.startY - event.clientY) * 0.25, false)
    } else if (d.kind === 'probe') {
      const x = Math.min(p.nx - 0.5, Math.max(0, cell[0]))
      const y = Math.min(p.ny - 0.5, Math.max(0, cell[1]))
      setProbes((list) => list.map((q, i) => (i === d.index ? { x, y } : q)))
    } else if (d.kind === 'rake') {
      setRake([d.start, cell])
      setView((v) => ({ ...v, streamlines: true }))
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'rotate') void requestPlan(true)
    if (d?.kind === 'body' && position.current) onPlacement?.(position.current, latest.current.state.angle_deg)
  }

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const e = engine.current
    if (!e) return
    if (tool === 'probe') {
      const hit = probeAt(e.toCells(event.clientX, event.clientY))
      if (hit >= 0) setProbes((list) => list.filter((_, i) => i !== hit))
    } else if (tool === 'rake') setRake(null)
  }

  // --- snapshot and video (SPEC §10.7) ---------------------------------------------
  const caption = useCallback((): string[] => {
    const p = planRef.current
    const s = latest.current.state
    const snapNow = engine.current?.snapshot()
    if (!p) return []
    const lines = [
      t('tunnel.snapshot.title', { name: latest.current.body.name, date: new Date().toLocaleString('it-IT') }),
      t('tunnel.snapshot.conditions', {
        fluid: t(`tunnel.fluid.${s.fluid}` as MessageKey),
        temperature: num(s.temperature_c, 1),
        speed: `${num(s.speed, 2)} m/s`,
        angle: num(s.angle_deg, 1),
        reynolds: p.texts.reynolds,
        grid: p.texts.grid,
        step: snapNow?.step ?? 0,
      }),
    ]
    if (latest.current.body.sectionInfo) lines.push(latest.current.body.sectionInfo)
    if (snapNow?.stats.cd && !snapNow.unstable)
      lines.push(
        t('tunnel.snapshot.coefficients', {
          cd: num(snapNow.stats.cd.mean, 3),
          cl: num(snapNow.stats.cl!.mean, 3),
          cm: num(snapNow.stats.cm!.mean, 3),
          status: t(`tunnel.status.${snapNow.stats.status}` as MessageKey),
          length: metres(p.reference_length),
        }),
      )
    if (p.partial_similarity) lines.push(t('tunnel.badge.partial'))
    if (latest.current.body.is3d) lines.push(t('section.badge2d'))
    return lines
  }, [])

  const takeSnapshot = useCallback(async () => {
    const image = await engine.current?.renderLarge(2)
    if (!image) return
    const lines = caption()
    const pad = 16
    const lineHeight = 28
    const out = document.createElement('canvas')
    out.width = image.width
    out.height = image.height + pad * 2 + lineHeight * lines.length + 40
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(image, 0, 0)
    // Legend: the colour bar and its range in real units.
    const legend = document.querySelector<HTMLElement>('[data-testid="legend"]')
    ctx.fillStyle = '#d4d4d4'
    ctx.font = '22px sans-serif'
    let y = image.height + pad + 22
    if (legend) {
      ctx.fillText(legend.innerText.replace(/\n+/g, '   '), pad, y)
      y += lineHeight + 8
    }
    for (const line of lines) {
      ctx.fillText(line, pad, y)
      y += lineHeight
    }
    out.toBlob((blob) => blob && download(blob, `galleria-${stamp()}.png`), 'image/png')
  }, [caption])

  const stopRecording = useCallback(() => {
    recorder.current?.stop()
    recorder.current = null
    if (engine.current) engine.current.onFrame = null
    setRecording(null)
  }, [])

  const startRecording = useCallback(() => {
    const e = engine.current
    if (!e || recorder.current) return
    const type = 'video/webm;codecs=vp9'
    if (!('MediaRecorder' in window) || !MediaRecorder.isTypeSupported(type)) {
      setNotice(t('tunnel.record.unsupported'))
      return
    }
    const comp = document.createElement('canvas')
    const ctx = comp.getContext('2d')!
    const lines = caption()
    e.onFrame = () => {
      const w = e.canvas.width
      const h = e.canvas.height
      if (comp.width !== w || comp.height !== h + 60) {
        comp.width = w
        comp.height = h + 60
      }
      ctx.fillStyle = '#111111'
      ctx.fillRect(0, 0, comp.width, comp.height)
      ctx.drawImage(e.canvas, 0, 0)
      ctx.drawImage(e.overlay, 0, 0)
      ctx.fillStyle = '#d4d4d4'
      ctx.font = '16px sans-serif'
      lines.slice(1, 3).forEach((line, i) => ctx.fillText(line, 10, h + 22 + i * 20))
    }
    const stream = comp.captureStream(30)
    const chunks: Blob[] = []
    const r = new MediaRecorder(stream, { mimeType: type })
    r.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
    r.onstop = () => download(new Blob(chunks, { type: 'video/webm' }), `galleria-${stamp()}.webm`)
    r.start(1000)
    recorder.current = r
    setRecording({ since: performance.now() })
  }, [caption])

  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => {
      if (performance.now() - recording.since > 120_000) stopRecording()
    }, 500)
    return () => window.clearInterval(id)
  }, [recording, stopRecording])

  // --- keyboard (SPEC §12.2) ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTextField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      const e = engine.current
      const target = event.target as HTMLElement | null
      const onSlider = target?.getAttribute('type') === 'range'
      const step = event.shiftKey ? 5 : 0.5
      switch (event.key) {
        case ' ':
          if (e?.isRunning) e.pause()
          else e?.play()
          break
        case 'r':
        case 'R':
          e?.restart()
          break
        case '.':
          e?.stepOnce()
          break
        case '1':
          setView((v) => ({ ...v, field: 'speed' }))
          break
        case '2':
          setView((v) => ({ ...v, field: 'pressure' }))
          break
        case '3':
          setView((v) => ({ ...v, field: 'vorticity' }))
          break
        case '4':
          setView((v) => ({ ...v, smoke: !v.smoke, particles: v.smoke ? v.particles : false }))
          break
        case '5':
          setView((v) => ({ ...v, particles: !v.particles, smoke: v.particles ? v.smoke : false }))
          break
        case '6':
          setView((v) => ({ ...v, streamlines: !v.streamlines }))
          break
        case 'ArrowUp':
          if (onSlider) return
          setAngle(latest.current.state.angle_deg + step)
          break
        case 'ArrowDown':
          if (onSlider) return
          setAngle(latest.current.state.angle_deg - step)
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
  }, [setAngle, takeSnapshot, startRecording, stopRecording])

  // --- benchmark (SPEC §17: ?bench=1, ?bench=depth) -----------------------------------
  useEffect(() => {
    if (!benchMode || !plan || bench) return
    const e = engine.current
    if (!e) return
    e.play()
    const samples: { sps: number; fps: number; mask: number }[] = []
    const start = performance.now()
    const id = window.setInterval(() => {
      const s = e.snapshot()
      const elapsed = performance.now() - start
      if (elapsed > 3000) samples.push({ sps: s.stepsPerSecond, fps: s.fps, mask: s.maskMs })
      if (elapsed > 23_000) {
        window.clearInterval(id)
        const p5 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.05)]
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
        setBench({
          nx: plan.nx,
          ny: plan.ny,
          stepsMean: mean(samples.map((x) => x.sps)),
          stepsP5: p5(samples.map((x) => x.sps)),
          fpsMean: mean(samples.map((x) => x.fps)),
          fpsP5: p5(samples.map((x) => x.fps)),
          maskMaxMs: Math.max(...samples.map((x) => x.mask)),
          samples: samples.length,
        })
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [benchMode, plan, bench])

  // --- what is shown ---------------------------------------------------------------------
  const sizedOn: Pt[] = useMemo(() => {
    if (body.envelope) {
      const [x0, y0, x1, y1] = body.envelope
      return [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]
    }
    return body.loops?.flat() ?? []
  }, [body.envelope, body.loops])
  const blockage = plan ? frontalHeight(sizedOn, plan.pivot, state.angle_deg) / plan.height_m : 0
  const speedFactor = unit === 'km/h' ? 3.6 : 1
  const set = <K extends keyof CaseState>(key: K, value: CaseState[K]) => setState((s) => ({ ...s, [key]: value }))
  const field = view.field
  const legendRange: [number, number] =
    plan && snap
      ? field === 'speed'
        ? [(snap.range[0] * plan.speed) / plan.u_lat, (snap.range[1] * plan.speed) / plan.u_lat]
        : field === 'vorticity'
          ? [snap.range[0] / plan.dt, snap.range[1] / plan.dt]
          : snap.range
      : [0, 1]
  const legendTitle = t(field === 'speed' ? 'tunnel.legend.speed' : field === 'pressure' ? 'tunnel.legend.pressure' : 'tunnel.legend.vorticity')

  const badges = (
    <>
      {plan?.partial_similarity ? (
        <Badge tip={t('tunnel.badge.partial.tip')} tone="warn" testId="badge-partial">
          {t('tunnel.badge.partial')}
        </Badge>
      ) : null}
      {body.is3d ? (
        <Badge tip={t('section.badge2d.tip')} testId="badge-2d">
          {t('section.badge2d')}
        </Badge>
      ) : null}
      {body.repaired ? (
        <Badge tip={t('section.repaired.tip')} tone="warn" testId="badge-repaired">
          {t('section.repaired')}
        </Badge>
      ) : null}
    </>
  )

  if (!support.ok)
    return (
      <div className="space-y-3 p-6">
        <Link to={back.to} className="text-sm text-accent hover:underline">
          {back.label}
        </Link>
        <p className="max-w-xl text-ink-100" role="alert" data-testid="no-gpu">
          {t('tunnel.noGpu')}
        </p>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar: the plan's numbers and the badges (SPEC §2.3, §12.1). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-700 bg-ink-850 px-4 py-1.5 text-xs text-ink-200" data-testid="tunnel-top">
        <Link to={back.to} className="text-accent hover:underline">
          {back.label}
        </Link>
        <span className="font-semibold text-ink-50">{t('tunnel.title', { name: body.name })}</span>
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
            <Tip text={t('tunnel.top.blockage.tip')}>
              <span className={`cursor-help ${blockage > 0.1 ? 'text-warn' : ''}`} data-testid="top-blockage">
                {t('tunnel.top.blockage', { value: num(blockage * 100, 1) })}
              </span>
            </Tip>
            <Tip text={t('tunnel.top.grid.tip')}>
              <span className="cursor-help">{plan.texts.grid}</span>
            </Tip>
            <Tip text={t('tunnel.top.tau.tip')}>
              <span className="cursor-help">τ {num(plan.tau, 4)}</span>
            </Tip>
            <span data-testid="top-steps">{t('tunnel.top.steps', { value: num(snap?.stepsPerSecond ?? 0, 0) })}</span>
            <span data-testid="top-fps">{t('tunnel.top.fps', { value: snap?.fps ?? 0 })}</span>
          </>
        ) : (
          <span>{planning ? t('tunnel.planning') : t('tunnel.loading')}</span>
        )}
        <span className="flex flex-wrap gap-1.5">{badges}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-r border-ink-700 bg-ink-850 p-3 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Button kind="primary" onClick={() => (engine.current?.isRunning ? engine.current.pause() : engine.current?.play())} label={snap?.running ? t('tunnel.pause') : t('tunnel.play')}>
              {snap?.running ? '❚❚' : '▶'}
            </Button>
            <Button onClick={() => engine.current?.restart()} title={t('tunnel.restart')} label={t('tunnel.restart')}>
              ⟲
            </Button>
            <Button onClick={() => engine.current?.stepOnce()} title={t('tunnel.step')} label={t('tunnel.step')}>
              ⏭
            </Button>
            <Button onClick={() => void takeSnapshot()} title={t('tunnel.snapshot')} label={t('tunnel.snapshot')}>
              📷
            </Button>
            <Button kind={recording ? 'danger' : 'secondary'} onClick={() => (recording ? stopRecording() : startRecording())} title={t('tunnel.record')} label={t('tunnel.record')}>
              ●
            </Button>
          </div>

          <Panel title={t('tunnel.conditions')} tip={t('tunnel.replan.tip')}>
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
                  onClick={() => {
                    const next = unit === 'km/h' ? 'm/s' : 'km/h'
                    setUnit(next)
                    try {
                      localStorage.setItem(SPEED_UNIT, next)
                    } catch {
                      // nothing to remember it with
                    }
                  }}
                >
                  ⇄
                </button>
              </span>
            </Row>
            <Row label={t('tunnel.incidence')} tip={t('tunnel.incidence.tip')}>
              <NumberField value={state.angle_deg} min={-90} max={90} digits={1} label={t('tunnel.incidence')} testId="incidence" onCommit={(v) => setAngle(v)} />
            </Row>
            <input
              type="range"
              min={-90}
              max={90}
              step={0.5}
              value={state.angle_deg}
              className="w-full accent-accent"
              aria-label={t('tunnel.incidence')}
              onChange={(e) => setAngle(Number(e.target.value), false)}
              onPointerUp={() => void requestPlan(true)}
              onKeyUp={() => void requestPlan(true)}
            />
            <Row label={t('tunnel.ground')}>
              <Select<Ground>
                value={state.ground}
                label={t('tunnel.ground')}
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
                options={(['chord', 'length_x', 'frontal_height', 'frontal_width', 'height'] as ReferenceKind[]).map((k) => ({
                  value: k,
                  label: t(`studyType.reference.${k}` as MessageKey),
                }))}
                onChange={(k) => {
                  setReferenceValue(null)
                  set('reference_kind', k)
                }}
              />
            </Row>
            {body.is3d ? (
              <Row label={t('tunnel.reference.mode')} tip={t('tunnel.reference.mode.tip')}>
                <Select<'fixed' | 'section'>
                  value={state.reference_mode}
                  label={t('tunnel.reference.mode')}
                  options={[
                    { value: 'fixed', label: t('tunnel.reference.fixed') },
                    { value: 'section', label: t('tunnel.reference.section') },
                  ]}
                  onChange={(m) => {
                    setReferenceValue(null)
                    set('reference_mode', m)
                  }}
                />
              </Row>
            ) : null}
            {plan ? (
              <div className="space-y-1">
                <p className="flex items-center justify-between text-xs text-ink-300">
                  <Tip text={t('tunnel.chamber.tip')}>
                    <span className="cursor-help">
                      {t('tunnel.chamber')}: {t('tunnel.chamber.size', { w: metres(plan.width_m), h: metres(plan.height_m) })} ⓘ
                    </span>
                  </Tip>
                </p>
                <div className="flex gap-1">
                  {(
                    [
                      ['tunnel.chamber.smaller', 0.8],
                      ['tunnel.chamber.larger', 1.25],
                    ] as [MessageKey, number][]
                  ).map(([key, factor]) => (
                    <Button
                      key={key}
                      kind="ghost"
                      onClick={() => {
                        domain.current = { width_m: plan.width_m * factor, height_m: plan.height_m * factor }
                        position.current = [plan.position[0] * factor, plan.position[1] * factor]
                        void requestPlan(true)
                      }}
                    >
                      {t(key)}
                    </Button>
                  ))}
                  <Button kind="ghost" onClick={() => void requestPlan(false)}>
                    {t('tunnel.chamber.auto')}
                  </Button>
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel title={t('tunnel.view')}>
            <div className="grid grid-cols-1 gap-1">
              {(['speed', 'pressure', 'vorticity'] as const).map((f) => (
                <label key={f} className="flex items-center gap-2">
                  <input type="radio" name="field" checked={view.field === f} onChange={() => setView((v) => ({ ...v, field: f }))} />
                  {t(`tunnel.view.${f}` as MessageKey)}
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view.smoke} onChange={(e) => setView((v) => ({ ...v, smoke: e.target.checked, particles: e.target.checked ? false : v.particles }))} />
                {t('tunnel.view.smoke')}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view.particles} onChange={(e) => setView((v) => ({ ...v, particles: e.target.checked, smoke: e.target.checked ? false : v.smoke }))} />
                {t('tunnel.view.particles')}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view.streamlines} onChange={(e) => setView((v) => ({ ...v, streamlines: e.target.checked }))} />
                {t('tunnel.view.streamlines')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={view.locked !== null}
                  onChange={(e) => setView((v) => ({ ...v, locked: e.target.checked && snap ? snap.range : null }))}
                />
                {t('tunnel.view.lock')}
              </label>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {(['move', 'probe', 'rake'] as Tool[]).map((k) => (
                <Tip key={k} text={t(`tunnel.tool.${k}.tip` as MessageKey)}>
                  <Button kind={tool === k ? 'primary' : 'secondary'} onClick={() => setTool(k)}>
                    {t(`tunnel.tool.${k}` as MessageKey)}
                  </Button>
                </Tip>
              ))}
            </div>
          </Panel>

          {modelPanel}
        </aside>

        <section className="relative min-w-0 flex-1 bg-ink-900">
          <canvas key={`gl-${engineKey}`} ref={canvasRef} className="absolute inset-0 h-full w-full" data-testid="tunnel-canvas" />
          <canvas
            key={`ov-${engineKey}`}
            ref={overlayRef}
            className={`absolute inset-0 h-full w-full ${tool === 'move' ? 'cursor-grab' : 'cursor-crosshair'}`}
            data-testid="tunnel-overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={onContextMenu}
          />
          <div className="pointer-events-none absolute top-2 left-2 space-y-1 text-xs">
            {snap?.empty && plan ? <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-200">{t('tunnel.empty')}</p> : null}
            {snap?.ramping ? <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('tunnel.ramp')}</p> : null}
            {snap && !snap.ramping && snap.stats.status === 'transient' ? (
              <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('tunnel.transient')}</p>
            ) : null}
            {snap?.clipped ? <p className="rounded bg-ink-850/90 px-2 py-1 text-danger">{t('tunnel.clipped')}</p> : null}
            {plan?.mach_warning ? <p className="rounded bg-ink-850/90 px-2 py-1 text-warn">{t('tunnel.warn.mach')}</p> : null}
            {blockage > 0.1 ? (
              <p className="rounded bg-ink-850/90 px-2 py-1 text-warn" data-testid="warn-blockage">
                {t('tunnel.warn.blockage')}
              </p>
            ) : null}
            {notice ? (
              <p className="pointer-events-auto rounded bg-ink-850/90 px-2 py-1 text-ink-100" role="status">
                {notice}{' '}
                <button className="text-accent" onClick={() => setNotice(null)}>
                  ×
                </button>
              </p>
            ) : null}
          </div>
          <div className="absolute right-2 bottom-2">
            <Legend
              map={field === 'speed' ? view.sequential : view.diverging}
              range={legendRange}
              title={legendTitle}
              digits={digitsFor(legendRange)}
            />
          </div>
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
                  setEngineKey((k) => k + 1)
                }}
              >
                {t('tunnel.resume')}
              </Button>
            </div>
          ) : null}
          {planError ? <ErrorNotice error={planError} className="absolute bottom-4 left-4 max-w-md" /> : null}
          {bench ? (
            <pre className="absolute top-12 left-3 rounded bg-ink-950/90 p-2 text-xs" data-testid="bench-result">
              {JSON.stringify(bench)}
            </pre>
          ) : null}
          <button
            className="absolute top-2 right-2 rounded bg-ink-850/90 px-2 py-1 text-xs text-ink-200 hover:bg-ink-700"
            style={{ display: recording ? 'none' : undefined }}
            onClick={() => setResults(!results)}
          >
            {results ? t('tunnel.results.hide') : t('tunnel.results.show')}
          </button>
        </section>

        {results && plan && snap ? (
          <aside className="w-96 shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-850 p-3" data-testid="results-panel">
            <Results plan={plan} snapshot={snap} badges={badges} />
            <Panel title={t('tunnel.probes')}>
              {snap.probes.length ? (
                <ul className="space-y-1 text-xs" data-testid="probes">
                  {snap.probes.map((p, i) => (
                    <li key={i}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink-300">{t('tunnel.probe', { n: i + 1 })}</span>
                        <span className="font-mono">
                          {t('tunnel.probe.values', {
                            speed: `${num(p.speed * speedFactor, 2)} ${unit}`,
                            cp: num(p.cp, 2),
                          })}
                        </span>
                        <button className="text-danger" aria-label={t('tunnel.probe.delete')} onClick={() => setProbes((l) => l.filter((_, k) => k !== i))}>
                          ×
                        </button>
                      </div>
                      {p.history.length > 1 ? <ProbeChart history={p.history} dt={plan.dt} speedFactor={speedFactor} unit={unit} index={i} /> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-300">{t('tunnel.probes.empty')}</p>
              )}
            </Panel>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
