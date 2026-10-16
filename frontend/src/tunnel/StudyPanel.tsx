// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// «Salva studio» and the series (SPEC §11.2, §11.3), in the tunnel's left
// column. Saving sends the current case as it stands -- converged or not, the
// status goes with the numbers. A live section not yet in the library is saved
// as a profile first (with the repair confirmation of §7.2), and the study
// points at it. A series locks the tunnel's controls while it runs, shows
// which point is running and the time left, and can be stopped keeping the
// points done; each point is saved as it finishes.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { api } from '../lib/api'
import { setSeriesBusy } from '../lib/busy'
import { num } from '../lib/format'
import type { ResultStatus, SeriesParameter, StudyMeta } from '../lib/types'
import type { TunnelEngine } from '../sim2d/engine'
import { t, type MessageKey } from '../i18n/it'
import { NumberField, Panel, Row, Select } from './parts'
import { SeriesRunner, evenValues, rangeValues, remainingSeconds, type SeriesProgress } from './series'
import { collectPoint, metaPart, packParts, type PointContext } from './study'

export type StudyHost = {
  engine: () => TunnelEngine | null
  /** The current case for saving, with the series value if any. */
  context: (value: number | null) => Promise<PointContext | null>
  apply: (parameter: SeriesParameter, value: number) => Promise<boolean>
  cap: () => number
  setLocked: (on: boolean) => void
  /** The study has been saved: results are no longer "unsaved". */
  markSaved: () => void
  /** A model's live section: saved as a library profile (null if cancelled). */
  saveSection?: () => Promise<{ id: string; name: string } | null>
}

export type StudySubject = {
  name: string
  profileId: string | null
  model: { id: string; name: string } | null
  is3d: boolean
}

type Defaults = { angle: number; speed: number }

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function valueText(parameter: SeriesParameter, value: number | null): string {
  if (value === null) return ''
  if (parameter === 'angle') return t('series.value.angle', { value: num(value, 2) })
  if (parameter === 'speed') return t('series.value.speed', { value: num(value, 2) })
  return t('series.value.depth', { value: num(value * 100, 1) })
}

export function StudyPanel({ subject, host, ready, defaults }: { subject: StudySubject; host: StudyHost; ready: boolean; defaults: Defaults }) {
  const queryClient = useQueryClient()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)

  const [parameter, setParameter] = useState<SeriesParameter>('angle')
  const [range, setRange] = useState<Record<SeriesParameter, [number, number, number]>>({
    angle: [-4, 16, 2],
    speed: [Math.max(0.1, Math.round(defaults.speed / 2)), Math.round(defaults.speed * 2), Math.max(0.1, Math.round(defaults.speed / 2))],
    depth: [5, 95, 11],
  })
  const [seriesName, setSeriesName] = useState('')
  const [progress, setProgress] = useState<SeriesProgress | null>(null)
  const [seriesStudy, setSeriesStudy] = useState<{ id: string; name: string } | null>(null)
  const runner = useRef<SeriesRunner | null>(null)
  const running = progress !== null && (progress.state === 'running' || progress.state === 'stopping')

  const [from, to, step] = range[parameter]
  const values =
    parameter === 'depth' ? evenValues(from / 100, to / 100, step) : rangeValues(from, to, step)

  useEffect(() => () => {
    runner.current?.stop()
    setSeriesBusy(null)
  }, [])

  const openSave = () => {
    setName(t('study.defaultName', { name: subject.name, angle: num(defaults.angle, 1), speed: num(defaults.speed, 2) }))
    setNotes('')
    setNaming(true)
  }

  /** The library profile the study points at: a live section is saved first. */
  const profileFor = async (): Promise<{ id: string | null; name: string } | null> => {
    if (!subject.is3d) return { id: subject.profileId, name: subject.name }
    const section = await host.saveSection?.()
    return section ?? null
  }

  const save = async () => {
    setNaming(false)
    setBusy(true)
    setError(null)
    try {
      const engine = host.engine()
      const profile = await profileFor()
      if (!engine || !profile) return
      const ctx = await host.context(null)
      if (!ctx) return
      const point = await collectPoint(engine, ctx)
      if (!point) return
      const meta: StudyMeta = {
        name: name.trim() || subject.name,
        notes,
        profile_id: profile.id,
        profile_name: profile.name,
        model_id: subject.model?.id ?? null,
        model_name: subject.model?.name ?? null,
        series: null,
      }
      const parts = [metaPart(meta), ...point.parts]
      if (point.thumbnail) parts.push({ name: 'miniatura', data: point.thumbnail })
      const study = await api.createStudy(packParts(parts))
      host.markSaved()
      setSaved({ id: study.id, name: study.name })
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const startSeries = async () => {
    if (!values.length) return
    setError(null)
    setSeriesStudy(null)
    try {
      const depth = parameter === 'depth'
      const profile = depth ? { id: null, name: subject.name } : await profileFor()
      if (!profile) return
      const meta: StudyMeta = {
        name: seriesName.trim() || t(`series.defaultName.${parameter}` as MessageKey, { name: subject.name }),
        notes: '',
        profile_id: profile.id,
        profile_name: profile.name,
        model_id: subject.model?.id ?? null,
        model_name: subject.model?.name ?? null,
        series: { parameter, values, state: 'running' },
      }
      const study = await api.createSeries(meta)
      setSeriesStudy({ id: study.id, name: study.name })
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
      const r = new SeriesRunner(
        {
          engine: host.engine,
          apply: host.apply,
          cap: host.cap,
          save: async (value, first, elapsed): Promise<ResultStatus> => {
            const engine = host.engine()
            const ctx = await host.context(value)
            if (!engine || !ctx) throw new Error(t('series.lost'))
            const point = await collectPoint(engine, { ...ctx, elapsedSeconds: elapsed })
            if (!point) throw new Error(t('series.lost'))
            const parts = [...point.parts]
            if (first && point.thumbnail) parts.push({ name: 'miniatura', data: point.thumbnail })
            await api.addStudyPoint(study.id, packParts(parts))
            void queryClient.invalidateQueries({ queryKey: ['studies'] })
            return point.status
          },
        },
        parameter,
        values,
        (p) => {
          setProgress(p)
          if (p.state === 'running' || p.state === 'stopping')
            setSeriesBusy(t('series.leave', { n: Math.min(p.index + 1, p.total), total: p.total }))
        },
      )
      runner.current = r
      host.setLocked(true)
      const end = await r.run()
      await api.finishSeries(study.id, end === 'done' ? 'done' : 'stopped').catch(() => undefined)
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
      if (end === 'error') setError(r.progress.error)
    } catch (err) {
      setError(err)
    } finally {
      runner.current = null
      setSeriesBusy(null)
      host.setLocked(false)
    }
  }

  const left = progress ? remainingSeconds(progress) : null

  return (
    <>
      <Panel title={t('study.title')} testId="study-panel">
        <Button kind="primary" disabled={!ready || busy || running} onClick={openSave}>
          {busy ? t('study.saving') : t('study.save')}
        </Button>
        {saved ? (
          <p className="text-xs text-ok" role="status" data-testid="study-saved">
            {t('study.saved', { name: saved.name })}{' '}
            <Link className="text-accent hover:underline" to={`/studi/${saved.id}`}>
              {t('study.open')}
            </Link>
          </p>
        ) : null}
      </Panel>

      <Panel title={t('series.title')} tip={t('series.tip')} testId="series-panel">
        <fieldset disabled={running} className="space-y-2">
          <Row label={t('series.parameter')}>
            <Select<SeriesParameter>
              value={parameter}
              label={t('series.parameter')}
              testId="series-parameter"
              options={(subject.is3d ? (['angle', 'speed', 'depth'] as const) : (['angle', 'speed'] as const)).map((p) => ({
                value: p,
                label: t(`series.parameter.${p}` as MessageKey),
              }))}
              onChange={setParameter}
            />
          </Row>
          {(['from', 'to', 'step'] as const).map((key, i) => (
            <Row key={key} label={t(`series.${parameter === 'depth' && key === 'step' ? 'count' : key}.${parameter}` as MessageKey)}>
              <NumberField
                value={range[parameter][i]}
                min={parameter === 'angle' ? (key === 'step' ? 0.1 : -90) : parameter === 'speed' ? 0.1 : key === 'step' ? 2 : 0}
                max={parameter === 'angle' ? (key === 'step' ? 90 : 90) : parameter === 'speed' ? 120 : key === 'step' ? 50 : 100}
                digits={parameter === 'depth' && key === 'step' ? 0 : 2}
                label={t(`series.${parameter === 'depth' && key === 'step' ? 'count' : key}.${parameter}` as MessageKey)}
                testId={`series-${key}`}
                onCommit={(v) =>
                  setRange((r) => {
                    const next = [...r[parameter]] as [number, number, number]
                    next[i] = v
                    return { ...r, [parameter]: next }
                  })
                }
              />
            </Row>
          ))}
          <input
            className="w-full rounded border border-ink-500 bg-ink-900 px-2 py-1 text-ink-50"
            placeholder={t(`series.defaultName.${parameter}` as MessageKey, { name: subject.name })}
            value={seriesName}
            aria-label={t('series.name')}
            onChange={(e) => setSeriesName(e.target.value)}
          />
        </fieldset>
        {parameter === 'depth' ? <p className="text-xs text-ink-300">{t('series.depth.note')}</p> : null}
        {running ? (
          <div className="space-y-1.5 rounded border border-ink-600 p-2 text-xs" data-testid="series-progress">
            <p className="text-ink-100">
              {t('series.point', { n: progress.index + 1, total: progress.total })} · {valueText(parameter, progress.value)}
            </p>
            <div className="h-1.5 rounded bg-ink-700">
              <div className="h-1.5 rounded bg-accent" style={{ width: `${Math.min(100, (100 * progress.step) / Math.max(1, progress.cap))}%` }} />
            </div>
            <p className="text-ink-300">{left === null ? t('series.eta.unknown') : t('series.eta', { time: clock(left) })}</p>
            <Button kind="danger" disabled={progress.state === 'stopping'} onClick={() => runner.current?.stop()}>
              {progress.state === 'stopping' ? t('series.stopping') : t('series.stop')}
            </Button>
          </div>
        ) : (
          <Button kind="primary" disabled={!ready || busy || !values.length} onClick={() => void startSeries()} testId="series-start">
            {t('series.start', { count: values.length })}
          </Button>
        )}
        {seriesStudy && progress && !running ? (
          <p className="text-xs text-ok" role="status" data-testid="series-saved">
            {t(progress.state === 'done' ? 'series.done' : 'series.stopped', { name: seriesStudy.name, count: progress.statuses.filter((s) => s !== 'skipped').length })}{' '}
            <Link className="text-accent hover:underline" to={`/studi/${seriesStudy.id}`}>
              {t('study.open')}
            </Link>
          </p>
        ) : null}
        {progress?.statuses.includes('skipped') && !running ? <p className="text-xs text-warn">{t('series.skipped')}</p> : null}
      </Panel>
      {error ? <ErrorNotice error={error} /> : null}

      {naming ? (
        <Dialog
          title={t('study.save')}
          onClose={() => setNaming(false)}
          actions={
            <>
              <Button onClick={() => setNaming(false)}>{t('common.cancel')}</Button>
              <Button kind="primary" onClick={() => void save()} disabled={!name.trim()}>
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <label className="block space-y-1">
            <span className="text-ink-200">{t('study.name')}</span>
            <input
              className="w-full rounded border border-ink-500 bg-ink-900 px-2 py-1 text-ink-50"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) void save()
              }}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-ink-200">{t('study.notes')}</span>
            <textarea
              className="h-24 w-full rounded border border-ink-500 bg-ink-900 px-2 py-1 text-ink-50"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {subject.is3d ? <p className="text-xs text-ink-300">{t('study.sectionSaved')}</p> : null}
        </Dialog>
      ) : null}
    </>
  )
}
