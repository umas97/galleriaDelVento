// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The photo of a hand sketch → a profile, in four steps (SPEC §8, §12.1 #4):
// sheet and perspective, cleaning, outline, scale and orientation. The photo
// is drawn large on the left with what each step found laid over it; the
// settings are on the right, with «Indietro/Avanti» always in view. Every
// change asks the server for a new preview (one request in flight, the latest
// wins). `/schizzi/:id?profilo=<uuid>` reopens the wizard with the settings
// saved in that profile.
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { ProfileView } from '../components/ProfileView'
import { SaveError, useProfileSaver } from '../components/SaveProfile'
import { Tip } from '../components/Tip'
import { api } from '../lib/api'
import { metres, num } from '../lib/format'
import type { Profile2D, SketchInfo, SketchParams, SketchPreview, SketchStage } from '../lib/types'
import {
  IMAGE_CORNERS,
  fromFraction,
  regionAt,
  toFraction,
  toggleRegion,
  weldFor,
  windAngle,
  windVector,
  type Pt,
} from '../sketch/geometry'
import { Picture, pathOf, unit } from '../sketch/Picture'
import { useSketchPreview } from '../sketch/usePreview'
import { NumberField, Panel, Row } from '../tunnel/parts'
import { t, type MessageKey } from '../i18n/it'

const DEFAULTS: SketchParams = {
  corners: null,
  threshold: 0.12,
  closing: 0.01,
  smoothing: 0.0005,
  regions: [],
  close_open: false,
  wind_deg: 0,
  flip: false,
  scale_mode: 'length',
  length_m: null,
  points: null,
  distance_m: null,
}

type Step = 1 | 2 | 3 | 4
const STAGES: Record<Step, SketchStage> = { 1: 'sheet', 2: 'ink', 3: 'outline', 4: 'profile' }

/** The photo settings a saved profile carries, directly or as the origin of an edit. */
function photoParams(profile: Profile2D): SketchParams | null {
  const s = profile.source
  if (s.kind === 'photo') return s.params
  if (s.kind === 'editor' && s.origin?.kind === 'photo') return s.origin.params
  return null
}

export function SketchWizardPage() {
  const { id = '' } = useParams()
  const [search] = useSearchParams()
  const fromId = search.get('profilo')
  const info = useQuery({ queryKey: ['sketch', id], queryFn: () => api.sketch(id) })
  const from = useQuery({
    queryKey: ['profile', fromId],
    queryFn: () => api.profile(fromId!),
    enabled: Boolean(fromId),
  })
  const error = info.error ?? from.error
  if (error)
    return (
      <div className="space-y-3 p-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          ← {t('nav.library')}
        </Link>
        <ErrorNotice error={error} />
      </div>
    )
  if (!info.data || (fromId && !from.data)) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const original = from.data && !from.data.read_only ? from.data.profile : null
  return (
    <Wizard
      key={`${id}-${fromId ?? ''}`}
      info={info.data}
      initial={(from.data && photoParams(from.data.profile)) ?? DEFAULTS}
      original={original}
      restoredFrom={from.data?.profile.name ?? null}
    />
  )
}

function Wizard({
  info,
  initial,
  original,
  restoredFrom,
}: {
  info: SketchInfo
  initial: SketchParams
  original: Profile2D | null
  restoredFrom: string | null
}) {
  const navigate = useNavigate()
  const saver = useProfileSaver()
  const stem = info.file_name.replace(/\.[^.]+$/, '') || info.file_name
  const [step, setStep] = useState<Step>(1)
  const [params, setParams] = useState<SketchParams>(initial)
  const [name, setName] = useState(original?.name ?? stem)
  const [error, setError] = useState<unknown>(null)
  const { preview, error: previewError, busy } = useSketchPreview(info.id, params, STAGES[step], name.trim() || stem)
  const set = (change: Partial<SketchParams>) => setParams((p) => ({ ...p, ...change }))

  // The corners found by the server become the user's starting point.
  useEffect(() => {
    if (params.corners === null && preview?.params.corners) set({ corners: preview.params.corners })
  }, [preview, params.corners])

  // The straightened sheet follows the corners once they stop moving.
  const [sheetCorners, setSheetCorners] = useState(initial.corners)
  useEffect(() => {
    if (sheetCorners === null && params.corners) setSheetCorners(params.corners)
  }, [params.corners, sheetCorners])
  const sheetUrl = sheetCorners ? api.sketchSheetUrl(info.id, sheetCorners) : null

  const canNext =
    step < 4 &&
    (step !== 3 || Boolean(preview?.regions?.some((r) => r.selected) || preview?.joined))

  const save = async (target: 'create' | 'update') => {
    setError(null)
    try {
      const check = await api.sketchDraft(info.id, params, name.trim() || stem)
      const profile = await saver.save(
        check.draft,
        target === 'update' && original ? { kind: 'update', id: original.id } : { kind: 'create' },
      )
      if (profile) navigate(`/profili/${profile.id}`)
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <section className="relative min-w-0 flex-1 bg-ink-950 p-3" data-testid="sketch-stage">
        {step === 1 ? (
          <SheetStep id={info.id} params={params} preview={preview} onCorners={(corners) => set({ corners })} onRelease={() => setSheetCorners(params.corners)} />
        ) : null}
        {step === 2 ? <InkStep preview={preview} /> : null}
        {step === 3 ? <OutlineStep href={sheetUrl} preview={preview} onRegions={(regions) => set({ regions })} /> : null}
        {step === 4 ? <ScaleStep href={sheetUrl} params={params} preview={preview} set={set} /> : null}
        {busy ? (
          <span className="pointer-events-none absolute top-4 right-4 rounded bg-ink-850/90 px-2 py-0.5 text-xs text-ink-300" role="status">
            {t('sketch.working')}
          </span>
        ) : null}
      </section>

      <aside className="flex w-90 shrink-0 flex-col border-l border-ink-700 bg-ink-850 text-sm">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Link to={original ? `/profili/${original.id}` : '/'} className="text-sm text-accent hover:underline">
            {original ? t('sketch.backProfile') : t('sketch.back')}
          </Link>
          <h2 className="truncate text-lg font-semibold text-ink-50" title={info.file_name}>
            {t('sketch.title', { name: info.file_name })}
          </h2>
          {restoredFrom ? <p className="text-xs text-ink-300">{t('sketch.restored', { name: restoredFrom })}</p> : null}
          <ol className="flex gap-1" aria-label={t('sketch.steps')}>
            {([1, 2, 3, 4] as Step[]).map((n) => (
              <li key={n} className="flex-1">
                <button
                  className={`w-full rounded px-1 py-1 text-xs ${n === step ? 'bg-accent text-ink-950' : 'bg-ink-800 text-ink-300 hover:text-ink-100'} disabled:opacity-40`}
                  disabled={n > step + 1 || (n > step && !canNext)}
                  aria-current={n === step ? 'step' : undefined}
                  onClick={() => setStep(n)}
                >
                  {n} · {t(`sketch.step${n}` as MessageKey)}
                </button>
              </li>
            ))}
          </ol>
          <h3 className="font-semibold text-ink-50">{t('sketch.step', { n: step, title: t(`sketch.step${step}` as MessageKey) })}</h3>

          {step === 1 ? (
            <SheetPanel
              preview={preview}
              sheetUrl={sheetUrl}
              onCorners={(corners) => {
                set({ corners })
                setSheetCorners(corners)
              }}
            />
          ) : null}
          {step === 2 ? <InkPanel params={params} set={set} /> : null}
          {step === 3 ? <OutlinePanel params={params} preview={preview} set={set} /> : null}
          {step === 4 ? (
            <ScalePanel
              params={params}
              preview={preview}
              set={set}
              name={name}
              setName={setName}
              original={original}
              busy={saver.busy}
              onSave={(target) => void save(target)}
            />
          ) : null}
          {previewError ? <ErrorNotice error={previewError} /> : null}
          {error ? <ErrorNotice error={error} /> : null}
          <SaveError error={saver.error} />
          {preview ? <p className="text-xs text-ink-400">{t('sketch.time', { ms: num(preview.elapsed_ms, 0) })}</p> : null}
        </div>
        <div className="flex justify-between gap-2 border-t border-ink-700 p-3">
          <Button disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1) as Step)}>
            {t('sketch.prev')}
          </Button>
          <Button kind="primary" disabled={!canNext} onClick={() => setStep((s) => Math.min(4, s + 1) as Step)}>
            {t('sketch.next')}
          </Button>
        </div>
      </aside>
      {saver.element}
    </div>
  )
}

// --- step 1: sheet and perspective ---------------------------------------------------------

function SheetStep({
  id,
  params,
  preview,
  onCorners,
  onRelease,
}: {
  id: string
  params: SketchParams
  preview: SketchPreview | null
  onCorners: (corners: Pt[]) => void
  onRelease: () => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  if (!preview || !params.corners) return <p className="p-3 text-ink-300">{t('common.loading')}</p>
  const size = preview.photo_size
  const span: [number, number] = [size[0] - 1, size[1] - 1]
  const corners = params.corners.map((c) => fromFraction(c, span))
  const u = unit(size)
  return (
    <Picture
      href={api.sketchPhotoUrl(id)}
      size={size}
      testId="sketch-photo"
      onDown={(p) => {
        const near = corners.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1]))
        const k = near.indexOf(Math.min(...near))
        if (near[k] < 12 * u) setDragging(k)
      }}
      onMove={(p) => {
        if (dragging === null) return
        const next = params.corners!.map((c, i) => (i === dragging ? toFraction(p, span) : c))
        onCorners(next)
      }}
      onUp={() => {
        if (dragging !== null) onRelease()
        setDragging(null)
      }}
      cursor={dragging !== null ? 'grabbing' : undefined}
    >
      <path d={pathOf(corners)} fill="#7aa2f7" fillOpacity={0.12} stroke="#7aa2f7" strokeWidth={u * 0.8} />
      {corners.map(([x, y], i) => (
        <g key={i} data-testid={`corner-${i}`}>
          <circle cx={x} cy={y} r={7 * u} fill="#7aa2f7" fillOpacity={0.25} stroke="#e8ecf4" strokeWidth={u * 0.8} style={{ cursor: 'grab' }} />
          <circle cx={x} cy={y} r={u} fill="#e8ecf4" />
        </g>
      ))}
    </Picture>
  )
}

function SheetPanel({
  preview,
  sheetUrl,
  onCorners,
}: {
  preview: SketchPreview | null
  sheetUrl: string | null
  onCorners: (corners: Pt[] | null) => void
}) {
  const [detected, setDetected] = useState<Pt[] | null>(null)
  // Remember what the server found, to go back to it.
  useEffect(() => {
    if (!detected && preview?.sheet_found) setDetected(preview.params.corners)
  }, [preview, detected])
  if (!preview) return null
  const [w, h] = preview.sheet_size
  const ratio = Math.max(w, h) / Math.min(w, h)
  return (
    <>
      <p className={preview.sheet_found ? 'text-ink-200' : 'text-warn'} data-testid="sheet-status">
        {preview.sheet_found ? t('sketch.sheet.found') : t('sketch.sheet.notFound')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onCorners(detected ?? null)}>{t('sketch.sheet.detect')}</Button>
        <Button onClick={() => onCorners(IMAGE_CORNERS)}>{t('sketch.sheet.whole')}</Button>
      </div>
      <Panel title={t('sketch.sheet.preview')} tip={t('sketch.sheet.tip')}>
        {sheetUrl ? <img src={sheetUrl} alt="" className="w-full rounded bg-ink-900" data-testid="sheet-preview" /> : null}
        <p className="text-xs text-ink-300">
          {preview.standard_sheet
            ? t('sketch.sheet.ratioA', { w, h })
            : t('sketch.sheet.ratio', { ratio: num(ratio, 3), w, h })}
        </p>
      </Panel>
    </>
  )
}

// --- step 2: cleaning ----------------------------------------------------------------------

function InkStep({ preview }: { preview: SketchPreview | null }) {
  if (!preview?.ink) return <p className="p-3 text-ink-300">{t('common.loading')}</p>
  return <Picture href={preview.ink} size={preview.sheet_size} testId="sketch-ink" />
}

function Slider({
  label,
  tip,
  value,
  min,
  max,
  step,
  format,
  onChange,
  testId,
}: {
  label: string
  tip: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  testId?: string
}) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-ink-200">
        <Tip text={tip}>
          <span className="cursor-help">{label} ⓘ</span>
        </Tip>
        <span>{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
        aria-label={label}
        data-testid={testId}
      />
    </label>
  )
}

const percent = (digits: number) => (v: number) => `${num(v * 100, digits)}%`

function InkPanel({ params, set }: { params: SketchParams; set: (c: Partial<SketchParams>) => void }) {
  return (
    <>
      <Slider
        label={t('sketch.ink.threshold')}
        tip={t('sketch.ink.threshold.tip')}
        value={params.threshold}
        min={0.02}
        max={0.4}
        step={0.005}
        format={percent(1)}
        onChange={(threshold) => set({ threshold })}
        testId="threshold"
      />
      <Slider
        label={t('sketch.ink.closing')}
        tip={t('sketch.ink.closing.tip')}
        value={params.closing}
        min={0}
        max={0.08}
        step={0.001}
        format={percent(1)}
        onChange={(closing) => set({ closing })}
        testId="closing"
      />
      <p className="text-xs text-ink-300">{t('sketch.ink.legend')}</p>
    </>
  )
}

// --- step 3: outline ----------------------------------------------------------------------

function OutlineStep({
  href,
  preview,
  onRegions,
}: {
  href: string | null
  preview: SketchPreview | null
  onRegions: (seeds: Pt[]) => void
}) {
  if (!preview?.regions) return <p className="p-3 text-ink-300">{t('common.loading')}</p>
  const regions = preview.regions
  const u = unit(preview.sheet_size)
  const gap = preview.gap
  return (
    <Picture
      href={href}
      size={preview.sheet_size}
      dim={0.55}
      testId="sketch-outline"
      cursor={regions.length > 1 ? 'pointer' : undefined}
      onDown={(p) => {
        const index = regionAt(regions, p)
        if (index < 0) return
        const seeds = toggleRegion(regions, index)
        if (seeds) onRegions(seeds)
      }}
    >
      {regions.map((r, i) => (
        <path
          key={i}
          d={pathOf(r.outline)}
          fill={r.selected ? '#7aa2f7' : 'none'}
          fillOpacity={0.3}
          stroke={r.selected ? '#7aa2f7' : '#c99a4a'}
          strokeWidth={u * (r.selected ? 1 : 0.7)}
          strokeDasharray={r.selected ? undefined : `${4 * u} ${3 * u}`}
          data-testid={r.selected ? 'region-selected' : 'region'}
        />
      ))}
      {preview.joined ? (
        <path d={pathOf(preview.joined)} fill="#7aa2f7" fillOpacity={0.3} stroke="#7aa2f7" strokeWidth={u} />
      ) : null}
      {gap && !preview.joined ? (
        <g data-testid="gap">
          <line x1={gap.a[0]} y1={gap.a[1]} x2={gap.b[0]} y2={gap.b[1]} stroke="#e06c6c" strokeWidth={u} strokeDasharray={`${2 * u} ${2 * u}`} />
          {[gap.a, gap.b].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={6 * u} fill="none" stroke="#e06c6c" strokeWidth={1.5 * u} />
          ))}
        </g>
      ) : null}
    </Picture>
  )
}

function OutlinePanel({
  params,
  preview,
  set,
}: {
  params: SketchParams
  preview: SketchPreview | null
  set: (c: Partial<SketchParams>) => void
}) {
  const regions = preview?.regions ?? []
  const chosen = regions.filter((r) => r.selected).length
  return (
    <>
      {regions.length ? (
        <p className="text-ink-200" data-testid="regions-status">
          {t('sketch.outline.regions', { count: regions.length })}
          {regions.length > 1 ? ` · ${t('sketch.outline.chosen', { count: chosen })}` : ''}
        </p>
      ) : null}
      {preview?.gap && !preview.joined ? (
        <div className="space-y-2 rounded border border-danger/40 bg-danger/10 p-2" role="alert">
          <p className="text-ink-50">{t('sketch.outline.open', { gap: percent(1)(preview.gap.fraction) })}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => set({ closing: weldFor(preview.gap!) })}>{t('sketch.outline.weld')}</Button>
            <Tip text={t('sketch.outline.join.tip')}>
              <Button onClick={() => set({ close_open: true })}>{t('sketch.outline.join')}</Button>
            </Tip>
          </div>
        </div>
      ) : null}
      {preview?.joined ? <p className="text-ink-200">{t('sketch.outline.joined')}</p> : null}
      {preview?.regions && !regions.length && !preview.gap && !preview.joined ? (
        <p className="text-warn">{t('sketch.outline.none')}</p>
      ) : null}
      <Slider
        label={t('sketch.outline.smoothing')}
        tip={t('sketch.outline.smoothing.tip')}
        value={params.smoothing}
        min={0}
        max={0.005}
        step={0.0001}
        format={percent(2)}
        onChange={(smoothing) => set({ smoothing })}
        testId="smoothing"
      />
      {params.close_open ? (
        <Button kind="ghost" onClick={() => set({ close_open: false })}>
          {t('sketch.outline.unjoin')}
        </Button>
      ) : null}
    </>
  )
}

// --- step 4: scale and orientation ------------------------------------------------------

function ScaleStep({
  href,
  params,
  preview,
  set,
}: {
  href: string | null
  params: SketchParams
  preview: SketchPreview | null
  set: (c: Partial<SketchParams>) => void
}) {
  const [drag, setDrag] = useState<'wind' | number | null>(null)
  const outlines = useMemo(() => {
    if (!preview) return []
    if (preview.joined) return [preview.joined]
    return (preview.regions ?? []).filter((r) => r.selected).map((r) => r.outline)
  }, [preview])
  if (!preview?.regions) return <p className="p-3 text-ink-300">{t('common.loading')}</p>
  const size = preview.sheet_size
  const u = unit(size)
  const all = outlines.flat()
  const centre: Pt = all.length
    ? [
        (Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[0]))) / 2,
        (Math.min(...all.map((p) => p[1])) + Math.max(...all.map((p) => p[1]))) / 2,
      ]
    : [size[0] / 2, size[1] / 2]
  const length = 0.18 * Math.max(...size)
  const [dx, dy] = windVector(params.wind_deg)
  const tail: Pt = [centre[0] - (dx * length) / 2, centre[1] - (dy * length) / 2]
  const head: Pt = [centre[0] + (dx * length) / 2, centre[1] + (dy * length) / 2]
  const wing = 6 * u
  const points = params.scale_mode === 'points' ? (params.points ?? []).map((p) => fromFraction(p, size)) : []
  return (
    <Picture
      href={href}
      size={size}
      dim={0.55}
      testId="sketch-scale"
      onDown={(p) => {
        if (Math.hypot(p[0] - head[0], p[1] - head[1]) < 14 * u) {
          setDrag('wind')
          return
        }
        const near = points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 10 * u)
        if (near >= 0) {
          setDrag(near)
          return
        }
        if (params.scale_mode === 'points' && (params.points?.length ?? 0) < 2) {
          set({ points: [...(params.points ?? []), toFraction(p, size)] })
        }
      }}
      onMove={(p) => {
        if (drag === 'wind') set({ wind_deg: windAngle(centre, p) })
        else if (typeof drag === 'number' && params.points) {
          set({ points: params.points.map((q, i) => (i === drag ? toFraction(p, size) : q)) })
        }
      }}
      onUp={() => setDrag(null)}
    >
      {outlines.map((loop, i) => (
        <path key={i} d={pathOf(loop)} fill="#7aa2f7" fillOpacity={0.3} stroke="#7aa2f7" strokeWidth={u} />
      ))}
      <g data-testid="wind-arrow" stroke="#e8ecf4" strokeWidth={1.5 * u} fill="none">
        <line x1={tail[0]} y1={tail[1]} x2={head[0]} y2={head[1]} />
        <path
          d={pathOf(
            [
              [head[0] - dx * wing * 2 + dy * wing, head[1] - dy * wing * 2 - dx * wing],
              head,
              [head[0] - dx * wing * 2 - dy * wing, head[1] - dy * wing * 2 + dx * wing],
            ],
            false,
          )}
        />
        <circle cx={head[0]} cy={head[1]} r={10 * u} fill="#e8ecf4" fillOpacity={0.12} strokeWidth={0.6 * u} style={{ cursor: 'grab' }} />
      </g>
      {points.length === 2 ? (
        <line x1={points[0][0]} y1={points[0][1]} x2={points[1][0]} y2={points[1][1]} stroke="#c99a4a" strokeWidth={u} />
      ) : null}
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={5 * u} fill="#c99a4a" fillOpacity={0.4} stroke="#c99a4a" strokeWidth={u} data-testid={`scale-point-${i}`} />
      ))}
    </Picture>
  )
}

function ScalePanel({
  params,
  preview,
  set,
  name,
  setName,
  original,
  busy,
  onSave,
}: {
  params: SketchParams
  preview: SketchPreview | null
  set: (c: Partial<SketchParams>) => void
  name: string
  setName: (n: string) => void
  original: Profile2D | null
  busy: boolean
  onSave: (target: 'create' | 'update') => void
}) {
  const draft = preview?.draft ?? null
  const updatable = original?.source.kind === 'photo'
  return (
    <>
      <Row label={t('sketch.scale.wind')} tip={t('sketch.scale.wind.tip')}>
        <NumberField value={params.wind_deg} min={-180} max={180} digits={1} label={t('sketch.scale.wind')} onCommit={(wind_deg) => set({ wind_deg })} testId="wind" />
      </Row>
      <label className="flex items-center gap-2 text-ink-200">
        <input type="checkbox" checked={params.flip} onChange={(event) => set({ flip: event.target.checked })} />
        {t('sketch.scale.flip')}
      </label>
      <fieldset className="space-y-1.5">
        <legend className="text-xs text-ink-300">{t('sketch.scale.mode')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={params.scale_mode === 'length'} onChange={() => set({ scale_mode: 'length' })} />
          {t('sketch.scale.length')}
        </label>
        {params.scale_mode === 'length' ? (
          <div className="flex items-center gap-2 pl-6">
            <NumberField
              value={params.length_m ?? 0}
              min={0.001}
              max={1000}
              digits={4}
              label={t('sketch.scale.lengthLabel')}
              onCommit={(length_m) => set({ length_m })}
              testId="length"
            />
            <span>m</span>
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input type="radio" checked={params.scale_mode === 'points'} onChange={() => set({ scale_mode: 'points' })} />
          {t('sketch.scale.points')}
        </label>
        {params.scale_mode === 'points' ? (
          <div className="space-y-1.5 pl-6">
            <p className="text-xs text-ink-300">{t('sketch.scale.pick')}</p>
            <div className="flex items-center gap-2">
              <NumberField
                value={params.distance_m ?? 0}
                min={0.001}
                max={1000}
                digits={4}
                label={t('sketch.scale.distanceLabel')}
                onCommit={(distance_m) => set({ distance_m })}
                testId="distance"
              />
              <span>m</span>
            </div>
            {params.points?.length ? (
              <Button kind="ghost" onClick={() => set({ points: null })}>
                {t('sketch.scale.repick')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <label className="block space-y-1">
        <span className="text-xs text-ink-300">{t('name.label')}</span>
        <input
          className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {draft ? (
        <>
          <ProfileView className="h-44 rounded bg-ink-900" loops={draft.loops.map((l) => l.points)} testId="sketch-result" />
          <p className="text-ink-200" data-testid="sketch-size">
            {t('sketch.result', { w: metres(preview!.size_m![0]), h: metres(preview!.size_m![1]) })}
          </p>
        </>
      ) : (
        <p className="text-ink-300">{t('sketch.scale.missing')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button kind="primary" disabled={!draft || !name.trim() || busy} onClick={() => onSave('create')}>
          {t('sketch.create')}
        </Button>
        {updatable ? (
          <Button disabled={!draft || !name.trim() || busy} onClick={() => onSave('update')}>
            {t('sketch.update', { name: original!.name })}
          </Button>
        ) : null}
      </div>
    </>
  )
}
