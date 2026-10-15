// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sections of a 3D model, live (SPEC §7.2), still without the flow: the cut in
// 2D at the centre, the model with the plane in a mini-scene, the depth and
// the rotations on the right. The full mesh lives in the slicer worker; this
// screen only sends depths and rotations and draws what comes back. In Phase 3
// the same controls become the tunnel's «Modello 3D» panel.
//
// `?bench=slicer` runs the benchmark of SPEC §17 in the worker (index + 200
// cuts on the full mesh) and prints the result on the page.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Matrix4 } from 'three'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { ProfileView } from '../components/ProfileView'
import { NameDialog, SaveError, useProfileSaver } from '../components/SaveProfile'
import { Tip } from '../components/Tip'
import { api, requestBuffer } from '../lib/api'
import { isTextField, metres, num } from '../lib/format'
import type { ModelRecord, ProfileDraft, StudyTypePreset } from '../lib/types'
import { rotatePoints, type Box, type Pt } from '../profile/geometry'
import { CutPlane } from '../scene3d/CutPlane'
import { ModelScene } from '../scene3d/ModelScene'
import { useModelGeometry } from '../scene3d/useModelGeometry'
import { createSlicer, type CutDelivery, type SlicerClient } from '../section/client'
import { attitudeMatrix, incidenceAngle, type Plane, type SliceAttitude } from '../section/frame'
import type { BenchStats } from '../section/protocol'
import type { IndexInfo } from '../section/slicer'
import { t } from '../i18n/it'

export function SectionPage() {
  const { id = '' } = useParams()
  const model = useQuery({ queryKey: ['model', id], queryFn: () => api.model(id) })
  const types = useQuery({ queryKey: ['study-types'], queryFn: api.studyTypes, staleTime: Infinity })
  if (model.isError || types.isError)
    return (
      <div className="space-y-3 p-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← {t('nav.library')}
        </Link>
        <ErrorNotice error={model.error ?? types.error} />
      </div>
    )
  if (!model.data || !types.data) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const preset = types.data.find((p) => p.id === model.data.study_type) ?? types.data[0]
  return <Workbench model={model.data} preset={preset} />
}

/**
 * A saved section is cut 8 times finer than the live one: it may later meet a
 * finer grid, the editor or a CAD program, none of which should get the
 * coarse outline the solver needs.
 */
const SAVE_DETAIL = 8

/** Provisional cell size until the planner exists (Phase 3): 1/128 of the model's length. */
function provisionalCell(info: IndexInfo | null, model: ModelRecord): number {
  const length = info ? info.envelope.maxX - info.envelope.minX : model.dimensions_m[0]
  return Math.max(length, 1e-6) / 128
}

function readMini(): boolean {
  try {
    return localStorage.getItem('section-mini') !== 'hidden'
  } catch {
    return true
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function Workbench({ model, preset }: { model: ModelRecord; preset: StudyTypePreset }) {
  const navigate = useNavigate()
  const view = useModelGeometry(model)
  const [plane, setPlane] = useState<Plane>(preset.plane)
  const [fraction, setFraction] = useState(preset.depth_fraction)
  const [roll, setRoll] = useState(0)
  const [tilt, setTilt] = useState(0)
  const [incidence, setIncidence] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [index, setIndex] = useState<{ info: IndexInfo; preview: boolean } | null>(null)
  const [cut, setCut] = useState<CutDelivery | null>(null)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [mini, setMini] = useState(readMini)
  const [naming, setNaming] = useState(false)
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)
  const [bench, setBench] = useState<BenchStats | null>(null)
  const client = useRef<SlicerClient | null>(null)
  const saver = useProfileSaver()
  const benchMode = new URLSearchParams(window.location.search).get('bench') === 'slicer'

  const attitude = useMemo<SliceAttitude>(() => ({ plane, roll, tilt }), [plane, roll, tilt])
  const meshKey = `${model.id}:${JSON.stringify(model.placement)}:${JSON.stringify(model.repairs)}`

  // The worker and the full mesh: once per model (and per placement or repair).
  useEffect(() => {
    const slicer = createSlicer()
    client.current = slicer
    let alive = true
    slicer.onIndex = (info, preview) => alive && setIndex({ info, preview })
    slicer.onCut = (delivery) => alive && setCut(delivery)
    slicer.onError = (message) => alive && setWorkerError(message)
    slicer.onBench = (stats) => alive && setBench(stats)
    setLoaded(false)
    setIndex(null)
    setCut(null)
    requestBuffer(api.meshUrl(model.id, false))
      .then((buffer) => slicer.load(buffer))
      .then(() => alive && setLoaded(true))
      .catch((error: unknown) => alive && setLoadError(error))
    return () => {
      alive = false
      slicer.dispose()
      client.current = null
    }
  }, [meshKey, model.id])

  // A new rotation or plane: a new index (on a sample while a slider is held).
  const dragging = useRef(false)
  useEffect(() => {
    if (loaded) client.current?.setAttitude(attitude, dragging.current)
  }, [loaded, attitude])

  const release = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    client.current?.setAttitude(attitude, false)
  }, [attitude])

  const info = index?.info ?? null
  const depth = info ? info.depthMin + fraction * (info.depthMax - info.depthMin) : 0
  const cell = provisionalCell(info, model)

  useEffect(() => {
    if (info) client.current?.cut(depth, cell)
  }, [info, depth, cell])

  useEffect(() => {
    if (benchMode && loaded && !bench) client.current?.bench(attitude, 200, cell)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the mesh is in
  }, [benchMode, loaded])

  // Keyboard: PgUp/PgDn depth ±1% (Shift ±0.1%), arrows incidence ±0.5° (Shift ±5°).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTextField(event.target)) return
      const target = event.target as HTMLElement | null
      const depthStep = event.shiftKey ? 0.001 : 0.01
      const angleStep = event.shiftKey ? 5 : 0.5
      if (event.key === 'PageUp') setFraction((f) => clamp(f + depthStep, 0, 1))
      else if (event.key === 'PageDown') setFraction((f) => clamp(f - depthStep, 0, 1))
      else if (event.key === 'ArrowUp' && target?.getAttribute('type') !== 'range')
        setIncidence((a) => clamp(a + angleStep, -90, 90))
      else if (event.key === 'ArrowDown' && target?.getAttribute('type') !== 'range')
        setIncidence((a) => clamp(a - angleStep, -90, 90))
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const result = cut?.result ?? null
  const envelope = info?.envelope ?? null
  const centre: Pt = envelope ? [(envelope.minX + envelope.maxX) / 2, (envelope.minY + envelope.maxY) / 2] : [0, 0]
  const angle = incidenceAngle(incidence)
  const turn = useCallback((loops: readonly Pt[][]) => loops.map((l) => rotatePoints(l, angle, centre[0], centre[1])), [angle, centre[0], centre[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  const viewBox = useMemo<Box | undefined>(() => {
    if (!envelope) return undefined
    const corners = rotatePoints(
      [
        [envelope.minX, envelope.minY],
        [envelope.maxX, envelope.minY],
        [envelope.maxX, envelope.maxY],
        [envelope.minX, envelope.maxY],
      ],
      angle,
      centre[0],
      centre[1],
    )
    return {
      minX: Math.min(...corners.map((p) => p[0])),
      maxX: Math.max(...corners.map((p) => p[0])),
      minY: Math.min(...corners.map((p) => p[1])),
      maxY: Math.max(...corners.map((p) => p[1])),
    }
  }, [envelope, angle, centre[0], centre[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  const modelMatrix = useMemo(() => {
    const [cx, cy, cz] = view.data
      ? view.data.header.bbox_min.map((v, i) => (v + view.data!.header.bbox_max[i]) / 2)
      : [0, 0, 0]
    const r = attitudeMatrix(attitude)
    const rot = new Matrix4().set(...r[0], 0, ...r[1], 0, ...r[2], 0, 0, 0, 0, 1)
    return new Matrix4().makeTranslation(cx, cy, cz).multiply(rot).multiply(new Matrix4().makeTranslation(-cx, -cy, -cz))
  }, [attitude, view.data])

  const draft = (name: string, loops: Pt[][], repaired: boolean): ProfileDraft => ({
    name,
    loops: loops.map((points) => ({ points })),
    spline: null,
    source: {
      kind: 'section3d',
      model_id: model.id,
      model_name: model.name,
      placement: model.placement,
      plane,
      depth_m: depth,
      depth_fraction: fraction,
      incidence_deg: incidence,
      roll_deg: roll,
      tilt_deg: tilt,
      repaired,
    },
  })

  /** The section at full detail, on the full mesh (not a sample), for saving or exporting. */
  const detailed = async (name: string) => {
    const fine = await client.current?.snapshot(depth, cell / SAVE_DETAIL)
    if (!fine?.loops.length) return null
    return { draft: draft(name, fine.loops, fine.repaired), raw: fine.repaired ? fine.rawLoops : null }
  }

  const defaultName = t('section.saveName', {
    model: model.name,
    plane: t(plane === 'vertical' ? 'section.plane.name.vertical' : 'section.plane.name.horizontal'),
    percent: num(fraction * 100, 1),
  })

  const save = async (name: string) => {
    setNaming(false)
    const section = await detailed(name)
    if (!section) return
    const profile = await saver.save(section.draft, { kind: 'create' }, section.raw ?? undefined)
    if (profile) setSaved({ id: profile.id, name: profile.name })
  }

  const exportAs = async (format: 'svg' | 'dxf') => {
    const section = await detailed(defaultName)
    if (section) await api.exportDraft(section.draft, format)
  }

  const points = result?.loops.reduce((s, l) => s + l.length, 0) ?? 0

  return (
    <div className="flex h-full min-h-0">
      <section className="relative min-w-0 flex-1 bg-ink-900">
        {result && result.loops.length + result.open.length > 0 ? (
          <ProfileView
            className="h-full w-full"
            loops={turn(result.loops)}
            open={turn(result.open)}
            box={viewBox}
            padding={0.12}
            testId="section-view"
          />
        ) : (
          <div className="grid h-full place-items-center text-ink-300" data-testid="section-view">
            {loadError ? null : !loaded ? t('section.loading') : !info ? t('section.indexing') : result ? t('section.empty') : null}
          </div>
        )}
        <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-1.5 text-xs">
          <Badge tip={t('section.badge2d.tip')}>{t('section.badge2d')}</Badge>
          {result?.repaired ? (
            <Badge tip={t('section.repaired.tip')} warn>
              {t('section.repaired')}
            </Badge>
          ) : null}
        </div>
        <div className="pointer-events-none absolute top-2 right-2 space-y-1 text-right text-xs">
          {result && result.open.length > 0 ? <p className="rounded bg-ink-850/90 px-2 py-1 text-danger">{t('section.open')}</p> : null}
          {result && result.droppedSmall > 0 ? (
            <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-300">{t('section.dropped', { count: result.droppedSmall })}</p>
          ) : null}
        </div>
        {loadError ? <ErrorNotice error={loadError} className="absolute bottom-4 left-4 max-w-md" /> : null}
        {workerError ? (
          <ErrorNotice error={new Error(workerError)} className="absolute bottom-4 left-4 max-w-md" />
        ) : null}
        {mini && view.data && envelope ? (
          <div className="absolute bottom-3 left-3 h-64 w-96 overflow-hidden rounded-lg border border-ink-600 bg-ink-950 shadow-xl">
            <ModelScene
              geometry={view.data.geometry}
              header={view.data.header}
              floorZ={model.placement.floor.enabled ? 0 : null}
              modelMatrix={modelMatrix}
              compact
              testId="section-scene"
            >
              <CutPlane plane={plane} depth={depth} envelope={envelope} loops={result?.loops ?? []} open={result?.open ?? []} />
            </ModelScene>
          </div>
        ) : null}
        <button
          className="absolute right-3 bottom-7 rounded bg-ink-850/90 px-2 py-1 text-xs text-ink-200 hover:bg-ink-700"
          onClick={() => {
            setMini(!mini)
            try {
              localStorage.setItem('section-mini', mini ? 'hidden' : 'shown')
            } catch {
              // nothing to remember it with
            }
          }}
        >
          {mini ? t('scene.miniHide') : t('scene.miniShow')}
        </button>
        {bench ? (
          <pre className="absolute top-12 left-3 rounded bg-ink-950/90 p-2 text-xs" data-testid="bench-result">
            {JSON.stringify(bench)}
          </pre>
        ) : null}
      </section>

      <aside className="w-90 shrink-0 space-y-4 overflow-y-auto border-l border-ink-700 bg-ink-850 p-4 text-sm">
        <Link to={`/modelli/${model.id}`} className="text-sm text-accent hover:underline">
          {t('section.back')}
        </Link>
        <h2 className="text-lg font-semibold text-ink-50">{t('section.title', { name: model.name })}</h2>

        <Panel title={t('section.plane')}>
          <div className="flex gap-1">
            {(['vertical', 'horizontal'] as Plane[]).map((p) => (
              <Button key={p} kind={plane === p ? 'primary' : 'secondary'} onClick={() => setPlane(p)}>
                {t(p === 'vertical' ? 'section.plane.vertical' : 'section.plane.horizontal')}
              </Button>
            ))}
          </div>
        </Panel>

        <Panel title={t('section.depth')} tip={t('section.depth.tip')}>
          <DepthSlider fraction={fraction} onChange={setFraction} />
          <p className="flex justify-between text-ink-200">
            <span data-testid="section-depth">{metres(depth)}</span>
            <span>{num(fraction * 100, 1)}%</span>
          </p>
        </Panel>

        <Panel title={t('section.rotations')} tip={t('section.rotations.tip')}>
          <AngleRow
            label={t('section.incidence')}
            tip={t('section.incidence.tip')}
            value={incidence}
            min={-90}
            max={90}
            onChange={setIncidence}
            onRelease={() => undefined}
          />
          <AngleRow
            label={t('section.roll')}
            value={roll}
            min={-180}
            max={180}
            onChange={(v) => {
              dragging.current = true
              setRoll(v)
            }}
            onRelease={release}
          />
          <AngleRow
            label={t(plane === 'vertical' ? 'section.tilt.vertical' : 'section.tilt.horizontal')}
            value={tilt}
            min={-180}
            max={180}
            onChange={(v) => {
              dragging.current = true
              setTilt(v)
            }}
            onRelease={release}
          />
          <Button
            kind="ghost"
            onClick={() => {
              setIncidence(0)
              setRoll(0)
              setTilt(0)
            }}
          >
            {t('section.reset')}
          </Button>
        </Panel>

        <Panel title="">
          <p className="text-xs text-ink-300" data-testid="section-stats">
            {result ? t('section.stats', { loops: t('section.loops', { count: result.loops.length }), points, ms: num(result.ms, 1) }) : '—'}
            {index?.preview ? ` · ${t('section.preview')}` : ''}
          </p>
          <p className="text-xs text-ink-300">
            <Tip text={t('section.cell.tip')}>
              <span className="cursor-help">{t('section.cell', { size: metres(cell / 2) })} ⓘ</span>
            </Tip>
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              kind="primary"
              disabled={!result?.loops.length || saver.busy || index?.preview}
              onClick={() => setNaming(true)}
            >
              {t('section.save')}
            </Button>
            <Button disabled={!result?.loops.length || index?.preview} onClick={() => void exportAs('svg')}>
              {t('section.export')} {t('section.export.svg')}
            </Button>
            <Button disabled={!result?.loops.length || index?.preview} onClick={() => void exportAs('dxf')}>
              {t('section.export.dxf')}
            </Button>
          </div>
          <SaveError error={saver.error} />
          {saved ? (
            <p className="text-ok" role="status">
              {t('section.saved', { name: saved.name })}{' '}
              <button className="text-accent hover:underline" onClick={() => navigate(`/profili/${saved.id}`)}>
                {t('section.openSaved')}
              </button>
            </p>
          ) : null}
        </Panel>
      </aside>
      {naming ? (
        <NameDialog title={t('section.save')} initial={defaultName} onCancel={() => setNaming(false)} onConfirm={(n) => void save(n)} />
      ) : null}
      {saver.element}
    </div>
  )
}

function Badge({ children, tip, warn }: { children: ReactNode; tip: string; warn?: boolean }) {
  return (
    <span className="pointer-events-auto">
      <Tip text={tip}>
        <span className={`cursor-help rounded px-2 py-0.5 ${warn ? 'bg-warn/20 text-warn' : 'bg-accent/15 text-accent'}`}>
          {children}
        </span>
      </Tip>
    </span>
  )
}

function Panel({ title, children, tip }: { title: string; children: ReactNode; tip?: string }) {
  return (
    <section className="space-y-2 border-t border-ink-700 pt-3">
      {title ? (
        <h3 className="flex items-center gap-1.5 font-semibold text-ink-50">
          {title}
          {tip ? (
            <Tip text={tip}>
              <span className="cursor-help text-xs text-ink-300">ⓘ</span>
            </Tip>
          ) : null}
        </h3>
      ) : null}
      {children}
    </section>
  )
}

/** The depth slider; the wheel over it moves 1% a notch (0.1% with Shift). */
function DepthSlider({ fraction, onChange }: { fraction: number; onChange: (f: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const latest = useRef(fraction)
  latest.current = fraction
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const step = (event.shiftKey ? 0.001 : 0.01) * Math.sign(-event.deltaY || -event.deltaX)
      onChange(clamp(latest.current + step, 0, 1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onChange])
  return (
    <input
      ref={ref}
      type="range"
      min={0}
      max={1000}
      step={1}
      value={Math.round(fraction * 1000)}
      onChange={(event) => onChange(Number(event.target.value) / 1000)}
      className="w-full accent-accent"
      aria-label={t('section.depth')}
      data-testid="depth-slider"
    />
  )
}

function AngleRow({
  label,
  tip,
  value,
  min,
  max,
  onChange,
  onRelease,
}: {
  label: string
  tip?: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  onRelease: () => void
}) {
  return (
    <label className="block space-y-0.5">
      <span className="flex justify-between text-xs text-ink-200">
        {tip ? (
          <Tip text={tip}>
            <span className="cursor-help">{label} ⓘ</span>
          </Tip>
        ) : (
          label
        )}
        <span>{num(value, 1)}°</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onRelease}
        onKeyUp={onRelease}
        onBlur={onRelease}
        className="w-full accent-accent"
        aria-label={label}
      />
    </label>
  )
}
