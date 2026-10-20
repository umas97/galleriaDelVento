// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The tunnel (SPEC §12.1 #5), for a saved profile (/galleria/profilo/:id) or a
// 3D model (/galleria/modello/:id). For a model the body is its live section
// (SPEC §7.2): the «Modello 3D» panel scrolls the depth and turns the model
// while the flow goes on, with the mini-scene in a corner and «Salva sezione
// come profilo». The tunnel itself is TunnelCore.
//
// A model's section is cut at half the plan's cell (before the first plan, at
// 1/128 of the model's length, as on the section screen).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Matrix4 } from 'three'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { NameDialog, SaveError, useProfileSaver } from '../components/SaveProfile'
import { api } from '../lib/api'
import { metres, num } from '../lib/format'
import { useSettings } from '../lib/settings'
import type { AppSettings, CasePlan, ModelRecord, Profile2D, ProfileDraft, ReferenceKind, StudyTypePreset } from '../lib/types'
import type { Pt } from '../profile/geometry'
import { ChamberBox } from '../scene3d/ChamberBox'
import { CutPlane } from '../scene3d/CutPlane'
import { ModelScene } from '../scene3d/ModelScene'
import { RotateGizmo } from '../scene3d/RotateGizmo'
import { useModelGeometry } from '../scene3d/useModelGeometry'
import { attitudeMatrix, type Plane } from '../section/frame'
import { useLiveSection } from '../section/useLiveSection'
import { Panel } from '../tunnel/parts'
import { TunnelCore, type CaseState, type TunnelBody } from '../tunnel/TunnelCore'
import { rememberedCase } from '../tunnel/lastCase'
import { t } from '../i18n/it'

export function TunnelPage() {
  const { kind, id = '' } = useParams()
  return kind === 'modello' ? <ModelTunnel id={id} /> : <ProfileTunnel id={id} />
}

function Failure({ error, back }: { error: unknown; back: string }) {
  return (
    <div className="space-y-3 p-6">
      <Link to={back} className="text-sm text-accent hover:underline">
        ← {t('nav.library')}
      </Link>
      <ErrorNotice error={error} />
    </div>
  )
}

function baseCase(settings: AppSettings, over: Partial<CaseState>): CaseState {
  const remembered = rememberedCase(settings)
  return {
    fluid: remembered.fluid ?? settings.fluido_predefinito,
    temperature_c: remembered.temperature_c ?? settings.temperatura_predefinita_c,
    speed: remembered.speed ?? 15,
    angle_deg: 0,
    ground: 'none',
    inlet_profile: 'uniform',
    resolution: remembered.resolution ?? settings.risoluzione,
    reference_kind: 'chord',
    reference_mode: remembered.reference_mode ?? 'fixed',
    max_blockage: 0.05,
    re_sim_scale: 1,
    ...over,
  }
}

// --- a saved profile -----------------------------------------------------------------

function ProfileTunnel({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id) })
  const settings = useSettings()
  if (query.isError) return <Failure error={query.error} back="/" />
  if (!query.data || !settings.loaded) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  return <ProfileBench profile={query.data.profile} settings={settings.values} />
}

function ProfileBench({ profile, settings }: { profile: Profile2D; settings: AppSettings }) {
  const body = useMemo<TunnelBody>(() => {
    const draft: ProfileDraft = { name: profile.name, loops: profile.loops, source: profile.source, spline: null }
    return {
      name: profile.name,
      loops: profile.loops.map((l) => l.points),
      rule: 'orientation',
      draft,
      envelope: null,
      repaired: false,
      is3d: false,
      geometryKey: profile.id,
      freshChamber: true,
      depthKey: 0,
      sectionInfo: null,
      profileId: profile.id,
      model: profile.source.kind === 'section3d' ? { id: profile.source.model_id, name: profile.source.model_name } : null,
    }
  }, [profile])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  const initial = useMemo(() => baseCase(settings, {}), [])
  return <TunnelCore body={body} initial={initial} back={{ to: `/profili/${profile.id}`, label: t('tunnel.back.profile') }} />
}

// --- a 3D model --------------------------------------------------------------------------

function ModelTunnel({ id }: { id: string }) {
  const model = useQuery({ queryKey: ['model', id], queryFn: () => api.model(id) })
  const types = useQuery({ queryKey: ['study-types'], queryFn: api.studyTypes, staleTime: Infinity })
  const settings = useSettings()
  if (model.isError || types.isError) return <Failure error={model.error ?? types.error} back="/" />
  if (!model.data || !types.data || !settings.loaded) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const preset = types.data.find((p) => p.id === model.data.study_type) ?? types.data[0]
  return <ModelBench model={model.data} preset={preset} settings={settings.values} />
}

const SAVE_DETAIL = 8
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function ModelBench({ model, preset, settings }: { model: ModelRecord; preset: StudyTypePreset; settings: AppSettings }) {
  const navigate = useNavigate()
  const view = useModelGeometry(model)
  const [plane, setPlane] = useState<Plane>(preset.plane)
  const [fraction, setFraction] = useState(preset.depth_fraction)
  const [roll, setRoll] = useState(0)
  const [tilt, setTilt] = useState(0)
  const [released, setReleased] = useState({ roll: 0, tilt: 0, plane: preset.plane, fresh: false })
  const [plan, setPlan] = useState<CasePlan | null>(null)
  const [placement, setPlacement] = useState<{ position: Pt; angle: number } | null>(null)
  const onPlacement = useCallback((position: Pt, angle: number) => setPlacement({ position, angle }), [])
  const [depthKey, setDepthKey] = useState(0)
  const [mini, setMini] = useState(true)
  const [big, setBig] = useState(false)
  const [naming, setNaming] = useState(false)
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)
  const saver = useProfileSaver()
  const provisional = Math.max(model.dimensions_m[0], 1e-6) / 128
  const cell = plan?.dx ?? provisional
  const live = useLiveSection(model, { plane, fraction, roll, tilt, cell })
  const info = live.index?.info ?? null
  const result = live.cut?.result ?? null
  const depthTimer = useRef(0)

  // The depth settles 300 ms after the last change: the "sezione" reference re-measures.
  const moveDepth = useCallback((f: number) => {
    setFraction(clamp(f, 0, 1))
    window.clearTimeout(depthTimer.current)
    depthTimer.current = window.setTimeout(() => setDepthKey((k) => k + 1), 300)
  }, [])

  // PgUp/PgDn: depth ±1% (Shift ±0.1%), SPEC §12.2.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (lockedRef.current) return
      const step = event.shiftKey ? 0.001 : 0.01
      if (event.key === 'PageUp') moveDepth(fractionRef.current + step)
      else if (event.key === 'PageDown') moveDepth(fractionRef.current - step)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveDepth])
  const fractionRef = useRef(fraction)
  fractionRef.current = fraction

  // Benchmark of the depth scroll (SPEC §17: ?bench=depth): back and forth, every frame.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('bench') !== 'depth' || !plan) return
    let dir = 1
    let handle = 0
    const tick = () => {
      let next = fractionRef.current + dir * 0.002
      if (next > 0.95 || next < 0.05) {
        dir = -dir
        next = clamp(next, 0.05, 0.95)
      }
      setFraction(next)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [plan])

  const referenceKind: ReferenceKind = preset.reference_length === 'height' ? 'height' : preset.reference_length
  const initial = useMemo(
    () =>
      baseCase(settings, {
        speed: preset.speed_ms,
        ground: preset.ground,
        inlet_profile: preset.inlet_profile,
        reference_kind: referenceKind,
        max_blockage: preset.max_blockage,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per model
    [model.id],
  )

  const draft = useCallback(
    (name: string, loops: Pt[][], repaired: boolean): ProfileDraft => ({
      name,
      loops: loops.map((points) => ({ points })),
      spline: null,
      source: {
        kind: 'section3d',
        model_id: model.id,
        model_name: model.name,
        placement: model.placement,
        plane,
        depth_m: live.depth,
        depth_fraction: fraction,
        incidence_deg: 0,
        roll_deg: roll,
        tilt_deg: tilt,
        repaired,
      },
    }),
    [model, plane, live.depth, fraction, roll, tilt],
  )

  const planeName = t(plane === 'vertical' ? 'section.plane.name.vertical' : 'section.plane.name.horizontal')
  const defaultName = t('section.saveName', { model: model.name, plane: planeName, percent: num(fraction * 100, 1) })
  const envelope = info?.envelope ?? null
  const body = useMemo<TunnelBody>(
    () => ({
      name: model.name,
      loops: result ? result.loops : info ? [] : null,
      rule: 'nesting',
      draft: result ? draft(defaultName, result.loops, result.repaired) : null,
      envelope: envelope ? [envelope.minX, envelope.minY, envelope.maxX, envelope.maxY] : null,
      repaired: Boolean(result?.repaired),
      is3d: true,
      geometryKey: `${released.plane}:${released.roll}:${released.tilt}`,
      freshChamber: released.fresh,
      depthKey,
      sectionInfo: t('tunnel.snapshot.section', {
        plane: planeName,
        depth: metres(live.depth),
        percent: num(fraction * 100, 1),
        roll: num(roll, 1),
        tilt: num(tilt, 1),
      }),
      profileId: null,
      model: { id: model.id, name: model.name },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the envelope follows the index
    [result, info, released, depthKey, draft, defaultName],
  )

  const release = () => {
    live.release()
    setReleased((r) => ({ ...r, roll, tilt, fresh: false }))
  }

  /** The current cut, as a profile in the library; the same cut is saved once. */
  const savedCut = useRef<{ key: string; id: string; name: string } | null>(null)
  const cutKey = `${plane}:${fraction}:${roll}:${tilt}`
  const save = async (name: string) => {
    setNaming(false)
    const fine = await live.snapshot(cell / SAVE_DETAIL)
    if (!fine?.loops.length) return null
    const profile = await saver.save(draft(name, fine.loops, fine.repaired), { kind: 'create' }, fine.repaired ? fine.rawLoops ?? undefined : undefined)
    if (!profile) return null
    setSaved({ id: profile.id, name: profile.name })
    savedCut.current = { key: cutKey, id: profile.id, name: profile.name }
    return { id: profile.id, name: profile.name }
  }
  // «Salva studio» on a live section saves it first, named as SPEC §11.2 says.
  const saveSection = async () => (savedCut.current?.key === cutKey ? savedCut.current : save(defaultName))

  // A depth series point (SPEC §11.3): the section at `f`, cut like the live one.
  const latestCut = useRef({ live, plane, roll, tilt, cell, model })
  latestCut.current = { live, plane, roll, tilt, cell, model }
  const depthCut = useCallback(async (f: number) => {
    const { live: l, plane: p, roll: r, tilt: tl, cell: c, model: m } = latestCut.current
    const box = l.index?.info
    if (!box) return null
    setFraction(f)
    const depth = box.depthMin + f * (box.depthMax - box.depthMin)
    const cut = await l.cutAt(depth, c)
    if (!cut) return null
    const name = t('section.saveName', {
      model: m.name,
      plane: t(p === 'vertical' ? 'section.plane.name.vertical' : 'section.plane.name.horizontal'),
      percent: num(f * 100, 1),
    })
    const sectionDraft: ProfileDraft = {
      name,
      loops: cut.loops.map((points) => ({ points })),
      spline: null,
      source: {
        kind: 'section3d',
        model_id: m.id,
        model_name: m.name,
        placement: m.placement,
        plane: p,
        depth_m: depth,
        depth_fraction: f,
        incidence_deg: 0,
        roll_deg: r,
        tilt_deg: tl,
        repaired: cut.repaired,
      },
    }
    return { loops: cut.loops, draft: sectionDraft }
  }, [])

  // The mini-scene, model and plane, for the report (SPEC §11.6).
  const captureScene = useCallback(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="tunnel-scene"] canvas')
    if (!canvas) return null
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  }, [])
  const lockedRef = useRef(false)
  const onLocked = useCallback((on: boolean) => {
    lockedRef.current = on
  }, [])

  const modelMatrix = useMemo(() => {
    const [cx, cy, cz] = view.data ? view.data.header.bbox_min.map((v, i) => (v + view.data!.header.bbox_max[i]) / 2) : [0, 0, 0]
    const r = attitudeMatrix({ plane, roll, tilt })
    const rot = new Matrix4().set(...r[0], 0, ...r[1], 0, ...r[2], 0, 0, 0, 0, 1)
    return new Matrix4().makeTranslation(cx, cy, cz).multiply(rot).multiply(new Matrix4().makeTranslation(-cx, -cy, -cz))
  }, [plane, roll, tilt, view.data])

  const panel = (
    <Panel title={t('tunnel.model')} testId="model-panel">
      <div className="flex gap-1">
        {(['vertical', 'horizontal'] as Plane[]).map((p) => (
          <Button
            key={p}
            kind={plane === p ? 'primary' : 'secondary'}
            onClick={() => {
              setPlane(p)
              setReleased((r) => ({ ...r, plane: p, fresh: true }))
            }}
          >
            {t(p === 'vertical' ? 'section.plane.vertical' : 'section.plane.horizontal')}
          </Button>
        ))}
      </div>
      <label className="block space-y-0.5">
        <span className="flex justify-between text-xs text-ink-200">
          {t('section.depth')}
          <span data-testid="section-depth">
            {metres(live.depth)} · {num(fraction * 100, 1)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(fraction * 1000)}
          onChange={(e) => moveDepth(Number(e.target.value) / 1000)}
          onWheel={(e) => moveDepth(fraction + (e.shiftKey ? 0.001 : 0.01) * Math.sign(-e.deltaY || -e.deltaX))}
          className="w-full accent-accent"
          aria-label={t('section.depth')}
          data-testid="depth-slider"
        />
      </label>
      {(
        [
          ['section.roll', roll, setRoll],
          [plane === 'vertical' ? 'section.tilt.vertical' : 'section.tilt.horizontal', tilt, setTilt],
        ] as const
      ).map(([key, value, setter]) => (
        <label key={key} className="block space-y-0.5">
          <span className="flex justify-between text-xs text-ink-200">
            {t(key)}
            <span>{num(value, 1)}°</span>
          </span>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.5}
            value={value}
            onChange={(e) => {
              live.drag()
              setter(Number(e.target.value))
            }}
            onPointerUp={release}
            onKeyUp={release}
            className="w-full accent-accent"
            aria-label={t(key)}
          />
        </label>
      ))}
      {result && result.open.length ? <p className="text-xs text-danger">{t('section.open')}</p> : null}
      {result && result.droppedSmall ? <p className="text-xs text-ink-300">{t('section.dropped', { count: result.droppedSmall })}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button kind="primary" disabled={!result?.loops.length || saver.busy || live.index?.preview} onClick={() => setNaming(true)}>
          {t('tunnel.model.save')}
        </Button>
        <Button kind="ghost" onClick={() => setMini(!mini)}>
          {mini ? t('scene.miniHide') : t('scene.miniShow')}
        </Button>
        <Link to={`/galleria3d/${model.id}`} className="self-center text-sm text-accent hover:underline" title={t('setup.openTunnel3d.tip')}>
          {t('setup.openTunnel3d')}
        </Link>
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
      {live.loadError ? <ErrorNotice error={live.loadError} /> : null}
      {live.workerError ? <ErrorNotice error={new Error(live.workerError)} /> : null}
      {naming ? <NameDialog title={t('section.save')} initial={defaultName} onCancel={() => setNaming(false)} onConfirm={(n) => void save(n)} /> : null}
      {saver.element}
    </Panel>
  )

  // Outside the panel that a series locks: looking at the model changes nothing of the case.
  const sceneView =
    view.data && envelope ? (
      <ModelScene geometry={view.data.geometry} header={view.data.header} floorZ={model.placement.floor.enabled ? 0 : null} modelMatrix={modelMatrix} compact={!big} testId="tunnel-scene">
        <CutPlane plane={plane} depth={live.depth} envelope={envelope} loops={result?.loops ?? []} open={result?.open ?? []} />
        {plan && placement && info ? (
          <ChamberBox plan={plan} plane={plane} position={placement.position} angleDeg={placement.angle} depthMin={info.depthMin} depthMax={info.depthMax} />
        ) : null}
        <RotateGizmo
          plane={plane}
          roll={roll}
          tilt={tilt}
          centre={view.data.header.bbox_min.map((v, i) => (v + view.data!.header.bbox_max[i]) / 2) as [number, number, number]}
          size={0.6}
          onStart={() => !lockedRef.current && live.drag()}
          onChange={(r, tl) => {
            if (lockedRef.current) return
            setRoll(r)
            setTilt(tl)
          }}
          onEnd={() => !lockedRef.current && release()}
        />
      </ModelScene>
    ) : null
  const scene = mini && sceneView ? (
    big ? (
      createPortal(
        <div className="fixed right-4 bottom-4 z-800 flex h-[min(70vh,640px)] w-[min(60vw,900px)] flex-col overflow-hidden rounded-lg border border-ink-500 bg-ink-950 shadow-2xl" data-testid="tunnel-scene-big">
          <div className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-3 py-1.5 text-sm">
            <span className="font-semibold text-ink-50">{t('scene.big.title', { name: model.name })}</span>
            <button className="rounded px-2 py-0.5 text-ink-200 hover:bg-ink-700" onClick={() => setBig(false)} data-testid="scene-shrink">
              {t('scene.shrink')}
            </button>
          </div>
          <div className="min-h-0 flex-1">{sceneView}</div>
        </div>,
        document.body,
      )
    ) : (
      <div className="space-y-1">
        <div className="h-48 overflow-hidden rounded border border-ink-600 bg-ink-950">{sceneView}</div>
        <div className="flex items-center justify-between text-xs text-ink-300">
          <span>{t('scene.mini.tip')}</span>
          <button className="text-accent hover:underline" onClick={() => setBig(true)} data-testid="scene-enlarge">
            {t('scene.enlarge')}
          </button>
        </div>
      </div>
    )
  ) : null

  return (
    <TunnelCore
      body={body}
      scene={scene}
      initial={initial}
      back={{ to: `/modelli/${model.id}`, label: t('tunnel.back.model') }}
      modelPanel={panel}
      onPlan={setPlan}
      onPlacement={onPlacement}
      saveSection={saveSection}
      depthCut={depthCut}
      captureScene={captureScene}
      onLocked={onLocked}
    />
  )
}
