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
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Matrix4 } from 'three'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { NameDialog, SaveError, useProfileSaver } from '../components/SaveProfile'
import { api } from '../lib/api'
import { metres, num } from '../lib/format'
import type { CasePlan, ModelRecord, Profile2D, ProfileDraft, ReferenceKind, StudyTypePreset } from '../lib/types'
import type { Pt } from '../profile/geometry'
import { ChamberBox } from '../scene3d/ChamberBox'
import { CutPlane } from '../scene3d/CutPlane'
import { ModelScene } from '../scene3d/ModelScene'
import { RotateGizmo } from '../scene3d/RotateGizmo'
import { useModelGeometry } from '../scene3d/useModelGeometry'
import { attitudeMatrix, type Plane } from '../section/frame'
import { useLiveSection } from '../section/useLiveSection'
import { Panel } from '../tunnel/parts'
import { TunnelCore, rememberedCase, type CaseState, type TunnelBody } from '../tunnel/TunnelCore'
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

function baseCase(over: Partial<CaseState>): CaseState {
  const remembered = rememberedCase()
  return {
    fluid: remembered.fluid ?? 'aria',
    temperature_c: remembered.temperature_c ?? 20,
    speed: remembered.speed ?? 15,
    angle_deg: 0,
    ground: 'none',
    inlet_profile: 'uniform',
    resolution: remembered.resolution ?? 'normale',
    reference_kind: 'chord',
    reference_mode: 'fixed',
    max_blockage: 0.05,
    re_sim_scale: 1,
    ...over,
  }
}

// --- a saved profile -----------------------------------------------------------------

function ProfileTunnel({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id) })
  if (query.isError) return <Failure error={query.error} back="/" />
  if (!query.data) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  return <ProfileBench profile={query.data.profile} />
}

function ProfileBench({ profile }: { profile: Profile2D }) {
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
    }
  }, [profile])
  const initial = useMemo(() => baseCase({ speed: rememberedCase().speed ?? 15 }), [])
  return <TunnelCore body={body} initial={initial} back={{ to: `/profili/${profile.id}`, label: t('tunnel.back.profile') }} />
}

// --- a 3D model --------------------------------------------------------------------------

function ModelTunnel({ id }: { id: string }) {
  const model = useQuery({ queryKey: ['model', id], queryFn: () => api.model(id) })
  const types = useQuery({ queryKey: ['study-types'], queryFn: api.studyTypes, staleTime: Infinity })
  if (model.isError || types.isError) return <Failure error={model.error ?? types.error} back="/" />
  if (!model.data || !types.data) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const preset = types.data.find((p) => p.id === model.data.study_type) ?? types.data[0]
  return <ModelBench model={model.data} preset={preset} />
}

const SAVE_DETAIL = 8
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function ModelBench({ model, preset }: { model: ModelRecord; preset: StudyTypePreset }) {
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
      baseCase({
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the envelope follows the index
    [result, info, released, depthKey, draft, defaultName],
  )

  const release = () => {
    live.release()
    setReleased((r) => ({ ...r, roll, tilt, fresh: false }))
  }

  const save = async (name: string) => {
    setNaming(false)
    const fine = await live.snapshot(cell / SAVE_DETAIL)
    if (!fine?.loops.length) return
    const profile = await saver.save(draft(name, fine.loops, fine.repaired), { kind: 'create' }, fine.repaired ? fine.rawLoops ?? undefined : undefined)
    if (profile) setSaved({ id: profile.id, name: profile.name })
  }

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
      {mini && view.data && envelope ? (
        <div className="h-48 overflow-hidden rounded border border-ink-600 bg-ink-950">
          <ModelScene geometry={view.data.geometry} header={view.data.header} floorZ={model.placement.floor.enabled ? 0 : null} modelMatrix={modelMatrix} compact testId="tunnel-scene">
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
              onStart={live.drag}
              onChange={(r, tl) => {
                setRoll(r)
                setTilt(tl)
              }}
              onEnd={release}
            />
          </ModelScene>
        </div>
      ) : null}
      {naming ? <NameDialog title={t('section.save')} initial={defaultName} onCancel={() => setNaming(false)} onConfirm={(n) => void save(n)} /> : null}
      {saver.element}
    </Panel>
  )

  return (
    <TunnelCore
      body={body}
      initial={initial}
      back={{ to: `/modelli/${model.id}`, label: t('tunnel.back.model') }}
      modelPanel={panel}
      onPlan={setPlan}
      onPlacement={onPlacement}
    />
  )
}
