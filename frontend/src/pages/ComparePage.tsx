// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Up to four studies side by side (SPEC §11.4): their mean fields with one
// colour scale and the same frame in metres around each body; the table of
// coefficients with the difference from the first study and the conditions of
// each, a row flagged when its simulated Re or reference length differs (the
// server decides, studies/compare.py); Cp curves, polars and depth curves
// overlaid. Studies of the 3D tunnel compare Cd, Cl and Cs on their reference
// areas, and show their saved pictures side by side (SPEC §24.2 #7).
import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { PALETTE, XYChart, type XYCurve } from '../charts/XYChart'
import { ErrorNotice } from '../components/ErrorNotice'
import { FieldImage } from '../components/FieldImage'
import { api } from '../lib/api'
import { bodyBox, frameAround, frameWidthFor, parseFields, rangeOf, unionRange, valuesOf, type FieldShown, type MeanFields } from '../lib/fields'
import { metres, num } from '../lib/format'
import { useSettings } from '../lib/settings'
import { is3d, type CoefficientKey, type Study, type ViewName } from '../lib/types'
import { parameterLabel, seriesX } from '../study/present'
import { STATUS_TONE } from '../study/StudyParts'
import { Legend, digitsFor } from '../tunnel/parts'
import { t, type MessageKey } from '../i18n/it'
import { toStudies } from './StudyPage'
import { GuideLink } from '../guide/Guide'

const COEFFICIENTS: { key: CoefficientKey; label: string; of: '2d' | '3d' | 'both' }[] = [
  { key: 'cd', label: 'Cd', of: 'both' },
  { key: 'cl', label: 'Cl', of: 'both' },
  { key: 'cm', label: 'Cm', of: '2d' },
  { key: 'clcd', label: 'Cl/Cd', of: '2d' },
  { key: 'st', label: 'St', of: '2d' },
  { key: 'cs', label: 'Cs', of: '3d' },
]

/** The pictures of 3D studies shown side by side, in this order. */
const VIEWS_3D: ViewName[] = ['piano', 'superficie', 'vista']

export function ComparePage() {
  const [params] = useSearchParams()
  const { values: settings } = useSettings()
  const ids = (params.get('studi') ?? '').split(',').filter(Boolean).slice(0, 4)
  const studies = useQueries({ queries: ids.map((id) => ({ queryKey: ['study', id], queryFn: () => api.study(id) })) })
  const comparison = useQuery({ queryKey: ['compare', ids.join(',')], queryFn: () => api.compareStudies(ids), enabled: ids.length > 0 })
  const fields = useQueries({
    queries: studies.map((q) => ({
      queryKey: ['study-fields', q.data?.study.id, 0],
      queryFn: async () => parseFields(await api.studyFields(q.data!.study.id, 0)),
      enabled: Boolean(q.data?.study.points[0]?.result.fields.length) && !(q.data && is3d(q.data.study.points[0].result)),
      staleTime: Infinity,
    })),
  })
  const [shown, setShown] = useState<FieldShown>('speed')
  const loaded = studies.map((q) => q.data?.study).filter((s): s is Study => Boolean(s))
  const error = studies.find((q) => q.isError)?.error ?? comparison.error

  const drawn = useMemo(() => {
    const list = fields.map((q) => q.data).filter((f): f is MeanFields => Boolean(f))
    if (!list.length) return null
    const values = list.map((f) => valuesOf(f, shown))
    const range = unionRange(list.map((f, i) => rangeOf(f, values[i], shown !== 'speed')))
    // The same frame in metres for all: wide enough for the longest body.
    const longest = Math.max(...list.map((f) => {
      const b = bodyBox(f)
      return b ? b.x1 - b.x0 : 0
    }))
    const width = longest > 0 ? frameWidthFor(longest) : null
    return { byId: new Map(fields.map((q, i) => [ids[i], q.data ?? null])), values: new Map(list.map((f, i) => [f, values[i]])), range, width }
  }, [fields, shown, ids])

  if (!ids.length) return <p className="p-6 text-ink-300">{t('compare.none')}</p>
  const map = shown === 'speed' ? settings.mappa_sequenziale : settings.mappa_divergente

  // Cp of the single studies, x/c when every one has a chord reference.
  const flat = loaded.filter((s) => s.points.length && !is3d(s.points[0].result))
  const solid = loaded.filter((s) => s.points.length && is3d(s.points[0].result))
  const singles = flat.filter((s) => s.kind === 'single')
  const rows = comparison.data?.rows ?? []
  const columns = COEFFICIENTS.filter((c) => c.of === 'both' || rows.some((r) => r.dimension === c.of))
  const series = loaded.filter((s) => s.kind === 'series' && s.points.length)
  const parameters = Array.from(new Set(series.map((s) => s.series!.parameter)))

  return (
    <div className="mx-auto h-full max-w-6xl space-y-5 overflow-y-auto p-6" data-testid="compare-page">
      <div className="flex items-center gap-3">
        <Link to="/" onClick={toStudies} className="text-sm text-accent hover:underline">
          {t('study.back')}
        </Link>
        <h2 className="text-lg font-semibold text-ink-50">{t('compare.title', { count: ids.length })}</h2>
      </div>
      {error ? <ErrorNotice error={error} /> : null}

      {comparison.data ? (
        <section className="space-y-2">
          {comparison.data.warning ? (
            <p className="text-warn" role="alert" data-testid="compare-warning">
              {t('compare.warning', { reason: comparison.data.warning })}
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="compare-table">
              <thead className="text-left text-ink-300">
                <tr>
                  <th className="py-1 pr-2">{t('compare.study')}</th>
                  {columns.map((c) => (
                    <th key={c.key} className="pr-2">
                      {c.label}
                    </th>
                  ))}
                  <th className="pr-2">{t('compare.reynolds')}</th>
                  <th className="pr-2">{t('compare.reference')}</th>
                  <th>{t('compare.grid')}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.data.rows.map((row, i) => (
                  <tr key={row.study_id} className="border-t border-ink-700 align-top">
                    <td className="py-1 pr-2">
                      <span className="mr-1 inline-block h-2 w-3 rounded-sm" style={{ background: PALETTE[i] }} />
                      <Link className="text-accent hover:underline" to={`/studi/${row.study_id}`}>
                        {row.name}
                      </Link>
                      {row.status ? <span className={`ml-1 text-xs ${STATUS_TONE[row.status]}`}>{t(`tunnel.status.${row.status}` as MessageKey)}</span> : null}
                      {row.kind === 'series' ? <span className="ml-1 text-xs text-ink-300">{t('compare.firstPoint')}</span> : null}
                      {row.reasons.map((r) => (
                        <p key={r} className="text-xs text-warn">
                          {r}
                        </p>
                      ))}
                    </td>
                    {columns.map((c) => {
                      const v = row.values[c.key]
                      const d = row.diff[c.key]
                      return (
                        <td key={c.key} className="pr-2 font-mono">
                          {v !== null ? num(v, 4) : '—'}
                          {i > 0 && d !== null ? <span className="block text-xs text-ink-300">{`${d > 0 ? '+' : ''}${num(d, 1)}%`}</span> : null}
                        </td>
                      )
                    })}
                    <td className="pr-2 text-xs">{row.reynolds}</td>
                    <td className="pr-2 text-xs">
                      {row.reference_length !== null ? metres(row.reference_length) : '—'}
                      {row.reference_area !== null ? <span className="block">{`${num(row.reference_area, 4)} m²`}</span> : null}
                    </td>
                    <td className="text-xs">{row.grid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {solid.length ? (
        <section className="space-y-2" data-testid="compare-views3d">
          <h3 className="font-semibold text-ink-50">{t('compare.views3d')}</h3>
          {VIEWS_3D.map((v) => (
            <div key={v} className="grid gap-3 md:grid-cols-2">
              {solid
                .filter((s) => s.points[0].views.includes(v))
                .map((s) => (
                  <figure key={s.id} className="space-y-1">
                    <img src={api.studyViewUrl(s.id, 0, v)} alt={t(`study.view.${v}` as MessageKey)} className="w-full rounded border border-ink-700" />
                    <figcaption className="text-xs text-ink-300">
                      <span className="mr-1 inline-block h-2 w-3 rounded-sm" style={{ background: PALETTE[ids.indexOf(s.id)] }} />
                      {s.name} · {t(`study.view.${v}` as MessageKey)}
                    </figcaption>
                  </figure>
                ))}
            </div>
          ))}
          <p className="text-xs text-ink-300">{t('compare.views3d.note')}</p>
        </section>
      ) : null}

      {flat.length ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-ink-50">{t('study.fields')}</h3>
            {(['speed', 'cp', 'vorticity'] as FieldShown[]).map((f) => (
              <button key={f} className={`rounded px-2 py-0.5 text-xs ${shown === f ? 'bg-ink-600 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`} onClick={() => setShown(f)}>
                {t(`study.field.${f}` as MessageKey)}
              </button>
            ))}
            {drawn ? (
              <span className="ml-auto">
                <Legend map={map} range={drawn.range} title={t(`study.field.${shown}` as MessageKey)} digits={digitsFor(drawn.range)} />
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2" data-testid="compare-fields">
            {ids.map((id, i) => {
              if (!flat.some((s) => s.id === id)) return null
              const f = drawn?.byId.get(id) ?? null
              const study = studies[i].data?.study
              return (
                <figure key={id} className="space-y-1">
                  {f && drawn ? (
                    <FieldImage fields={f} values={drawn.values.get(f)!} range={drawn.range} map={map} frame={frameAround(f, drawn.width, 0.42)} width={640} className="rounded" />
                  ) : (
                    <div className="grid aspect-[2.4] place-items-center rounded bg-ink-850 text-xs text-ink-300">
                      {study && !study.points[0]?.result.fields.length ? t('study.noFields') : t('common.loading')}
                    </div>
                  )}
                  <figcaption className="text-xs text-ink-300">
                    <span className="mr-1 inline-block h-2 w-3 rounded-sm" style={{ background: PALETTE[i] }} />
                    {study?.name}
                  </figcaption>
                </figure>
              )
            })}
          </div>
          <p className="text-xs text-ink-300">{t('compare.frame')}</p>
        </section>
      ) : null}

      {singles.length ? <CpOverlay studies={singles} ids={ids} /> : null}
      {parameters.map((parameter) => (
        <SeriesOverlay key={parameter} studies={series.filter((s) => s.series!.parameter === parameter)} ids={ids} />
      ))}
    </div>
  )
}

function CpOverlay({ studies, ids }: { studies: Study[]; ids: string[] }) {
  const contours = useQueries({ queries: studies.map((s) => ({ queryKey: ['study-contour', s.id, 0], queryFn: () => api.studyContour(s.id, 0) })) })
  const chord = studies.every((s) => {
    const r = s.points[0].result
    return !is3d(r) && r.contour_cp.chord
  })
  const curves: XYCurve[] = studies.flatMap((s, i) => {
    const c = contours[i].data
    if (!c) return []
    const color = PALETTE[ids.indexOf(s.id)]
    return [
      {
        label: s.name,
        color,
        line: false,
        points: c.cp.map((cp, k) => ({ x: chord ? c.xc[k] : c.s[k], y: cp, filled: c.upper[k] })),
      },
    ]
  })
  return (
    <section className="space-y-1">
      <h3 className="flex items-center gap-1.5 font-semibold text-ink-50">{t('tunnel.cp')} <GuideLink section="charts" entry="cp" /></h3>
      <XYChart curves={curves} xLabel={chord ? t('tunnel.cp.xc') : t('tunnel.cp.s')} yLabel="Cp" invertY testId="compare-cp" />
      <p className="text-xs text-ink-300">{t('compare.cp.note')}</p>
    </section>
  )
}

function SeriesOverlay({ studies, ids }: { studies: Study[]; ids: string[] }) {
  const parameter = studies[0].series!.parameter
  const curve = (s: Study, key: 'cd' | 'cl'): XYCurve => ({
    label: `${s.name} — ${key === 'cd' ? 'Cd' : 'Cl'}`,
    color: PALETTE[ids.indexOf(s.id)],
    points: s.points.flatMap((p) => {
      const v = p.result.coefficients[key]
      return v ? [{ x: seriesX(parameter, p), y: v.mean, filled: p.result.status === 'converged' }] : []
    }),
  })
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-ink-50">{t('compare.series', { parameter: t(`series.parameter.${parameter}` as MessageKey) })}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <XYChart curves={studies.map((s) => curve(s, 'cl'))} xLabel={parameterLabel(parameter)} yLabel="Cl" testId="compare-series-cl" />
        <XYChart curves={studies.map((s) => curve(s, 'cd'))} xLabel={parameterLabel(parameter)} yLabel="Cd" />
      </div>
      {parameter === 'depth' ? <p className="text-xs text-warn">{t('series.depth.note')}</p> : null}
    </section>
  )
}
