// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pieces of the study page and of the report: conditions, coefficients with
// their status, the warnings that go with them (SPEC §2.3), a point's history
// and Cp, the mean fields, a series' curves (SPEC §11.3).
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CpCurve } from '../charts/CpCurve'
import { TimeSeries } from '../charts/TimeSeries'
import { PALETTE, XYChart, type XYCurve } from '../charts/XYChart'
import { FieldImage } from '../components/FieldImage'
import { ProfileView } from '../components/ProfileView'
import { api } from '../lib/api'
import { frameAround, frameWidthFor, bodyBox, parseFields, rangeOf, valuesOf, type FieldShown } from '../lib/fields'
import { num } from '../lib/format'
import { useSettings } from '../lib/settings'
import type { SimulationResult, Study } from '../lib/types'
import { Legend, digitsFor } from '../tunnel/parts'
import { t, type MessageKey } from '../i18n/it'
import { conditionRows, parameterLabel, seriesX, warningsOf } from './present'
import { GuideLink } from '../guide/Guide'

export const STATUS_TONE = { converged: 'text-ok', provisional: 'text-warn', unstable: 'text-danger' } as const

export function ConditionsTable({ result, steps }: { result: SimulationResult; steps: number }) {
  return (
    <table className="w-full text-sm" data-testid="study-conditions">
      <tbody>
        {conditionRows(result, steps).map(([label, value]) => (
          <tr key={label} className="border-b border-ink-700/60 print:border-neutral-300">
            <th className="py-1 pr-3 text-left font-normal text-ink-300 print:text-neutral-600">{label}</th>
            <td className="py-1">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function CoefficientsTable({ result }: { result: SimulationResult }) {
  const c = result.coefficients
  const f = result.forces_real
  const point = t(result.plan.reference_kind === 'chord' ? 'tunnel.point.quarter' : 'tunnel.point.centre')
  const stat = (s: { mean: number; std: number } | null) => (s ? `${num(s.mean, 4)} ± ${num(s.std, 4)}` : '—')
  const rows: [string, string][] = [
    ['Cd', stat(c.cd)],
    ['Cl', stat(c.cl)],
    [t('study.coef.cm', { point }), stat(c.cm)],
    ['Cl/Cd', c.clcd !== null ? num(c.clcd, 3) : '—'],
    ['St', c.strouhal !== null ? num(c.strouhal, 3) : '—'],
    [t('tunnel.forces.drag'), f.drag !== null ? t('tunnel.forces.unit', { value: num(f.drag, 4) }) : '—'],
    [t('tunnel.forces.lift'), f.lift !== null ? t('tunnel.forces.unit', { value: num(f.lift, 4) }) : '—'],
    [t('study.coef.moment'), f.moment !== null ? t('study.coef.momentUnit', { value: num(f.moment, 4) }) : '—'],
  ]
  return (
    <div className="space-y-1">
      <p className={`text-sm font-semibold ${STATUS_TONE[result.status]}`} data-testid="study-status">
        {t(`tunnel.status.${result.status === 'unstable' ? 'unstable' : result.status}` as MessageKey)}
      </p>
      <table className="w-full text-sm" data-testid="study-coefficients">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-ink-700/60 print:border-neutral-300">
              <th className="py-1 pr-3 text-left font-normal text-ink-300 print:text-neutral-600">{label}</th>
              <td className="py-1 font-mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-ink-300 print:text-neutral-600">
        {t('tunnel.conditions.used', { length: num(result.plan.reference_length, 4) + ' m', reynolds: result.plan.texts.reynolds })}
      </p>
    </div>
  )
}

export function Warnings({ result }: { result: SimulationResult }) {
  const list = warningsOf(result)
  if (!list.length) return null
  const tone = { warn: 'text-warn', info: 'text-accent', danger: 'text-danger' }
  return (
    <ul className="space-y-1 text-xs" data-testid="study-warnings">
      {list.map((w) => (
        <li key={w.key} className={`${tone[w.tone]} print:text-neutral-800`}>
          {w.text}
        </li>
      ))}
    </ul>
  )
}

export function PointCharts({
  studyId,
  k,
  result,
  height = 170,
  stacked = false,
}: {
  studyId: string
  k: number
  result: SimulationResult
  height?: number
  /** One chart under the other (the report: the width is the page's). */
  stacked?: boolean
}) {
  const history = useQuery({ queryKey: ['study-history', studyId, k], queryFn: () => api.studyHistory(studyId, k) })
  const contour = useQuery({ queryKey: ['study-contour', studyId, k], queryFn: () => api.studyContour(studyId, k) })
  const samples = useMemo(
    () => (history.data ? history.data.step.map((step, i) => ({ step, cd: history.data.cd[i], cl: history.data.cl[i], cm: history.data.cm[i] })) : []),
    [history.data],
  )
  const cp = useMemo(
    () =>
      contour.data
        ? contour.data.xc.map((xc, i) => ({ xc, s: contour.data.s[i], upper: contour.data.upper[i], cp: contour.data.cp[i], x: contour.data.x[i], y: contour.data.y[i] }))
        : [],
    [contour.data],
  )
  return (
    <div className={`grid gap-4 ${stacked ? '' : 'md:grid-cols-2'}`}>
      <div>
        <h4 className="mb-1 flex items-center gap-1.5 text-sm text-ink-200 print:text-neutral-700">{t('tunnel.history')} <GuideLink section="charts" entry="history" /></h4>
        {samples.length > 1 ? <TimeSeries samples={samples} dt={result.plan.dt} height={height} /> : <p className="text-xs text-ink-300">{t('study.noHistory')}</p>}
      </div>
      <div>
        <h4 className="mb-1 flex items-center gap-1.5 text-sm text-ink-200 print:text-neutral-700">{t('tunnel.cp')} <GuideLink section="charts" entry="cp" /></h4>
        {cp.length > 2 ? <CpCurve points={cp} chord={result.contour_cp.chord} height={height} /> : <p className="text-xs text-ink-300">{t('study.noCp')}</p>}
      </div>
    </div>
  )
}

export function MeanFields({ studyId, k, result }: { studyId: string; k: number; result: SimulationResult }) {
  const [shown, setShown] = useState<FieldShown>('speed')
  const { values: settings } = useSettings()
  const query = useQuery({
    queryKey: ['study-fields', studyId, k],
    queryFn: async () => parseFields(await api.studyFields(studyId, k)),
    enabled: result.fields.length > 0,
    staleTime: Infinity,
  })
  const drawn = useMemo(() => {
    const f = query.data
    if (!f) return null
    const values = valuesOf(f, shown)
    const range = rangeOf(f, values, shown !== 'speed')
    const box = bodyBox(f)
    const frame = frameAround(f, box ? frameWidthFor(box.x1 - box.x0) : null, 0.42)
    return { f, values, range, frame }
  }, [query.data, shown])
  if (!result.fields.length) return <p className="text-xs text-ink-300">{t('study.noFields')}</p>
  const map = shown === 'speed' ? settings.mappa_sequenziale : settings.mappa_divergente
  const unit = result.fields.find((r) => r.name === (shown === 'speed' ? 'u' : shown))?.unit ?? ''
  return (
    <div className="space-y-2" data-testid="study-fields">
      <div className="flex gap-1 text-xs">
        {(['speed', 'cp', 'vorticity'] as FieldShown[]).map((f) => (
          <button key={f} className={`rounded px-2 py-0.5 ${shown === f ? 'bg-ink-600 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`} onClick={() => setShown(f)}>
            {t(`study.field.${f}` as MessageKey)}
          </button>
        ))}
      </div>
      {drawn ? (
        <>
          <FieldImage fields={drawn.f} values={drawn.values} range={drawn.range} map={map} frame={drawn.frame} width={960} className="rounded" />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-ink-300">{t('study.fields.note', { samples: num(drawn.f.samples, 0) })}</p>
            <Legend map={map} range={drawn.range} title={`${t(`study.field.${shown}` as MessageKey)}${unit ? ` (${unit})` : ''}`} digits={digitsFor(drawn.range)} />
          </div>
        </>
      ) : (
        <p className="text-xs text-ink-300">{t('common.loading')}</p>
      )}
    </div>
  )
}

/** The coefficients of a series against its parameter, and for incidence the polar Cl–Cd. */
export function SeriesCharts({ study, height = 220 }: { study: Study; height?: number }) {
  const parameter = study.series?.parameter ?? 'angle'
  const points = study.points.filter((p) => p.result.status !== 'unstable')
  const curve = (label: string, color: string, y: (r: SimulationResult) => number | null | undefined, line = true): XYCurve => ({
    label,
    color,
    line,
    points: points.flatMap((p) => {
      const v = y(p.result)
      return v === null || v === undefined ? [] : [{ x: seriesX(parameter, p), y: v, filled: p.result.status === 'converged' }]
    }),
  })
  const coefficients = [
    curve('Cd', PALETTE[0], (r) => r.coefficients.cd?.mean),
    curve('Cl', PALETTE[1], (r) => r.coefficients.cl?.mean),
    curve('Cm', PALETTE[2], (r) => r.coefficients.cm?.mean),
  ]
  const polar: XYCurve = {
    label: 'Cl–Cd',
    color: PALETTE[1],
    line: false,
    points: points.flatMap((p) => {
      const c = p.result.coefficients
      return c.cd && c.cl ? [{ x: c.cd.mean, y: c.cl.mean, filled: p.result.status === 'converged' }] : []
    }),
  }
  return (
    <div className="space-y-4" data-testid="series-charts">
      <XYChart curves={coefficients} xLabel={parameterLabel(parameter)} height={height} testId="series-coefficients" />
      {parameter === 'angle' ? (
        <div className="grid grid-cols-2 gap-4">
          <XYChart curves={[polar]} xLabel="Cd" yLabel="Cl" height={height} testId="series-polar" />
          <XYChart curves={[curve('Cl/Cd', PALETTE[3], (r) => r.coefficients.clcd)]} xLabel={parameterLabel(parameter)} height={height} />
        </div>
      ) : null}
      {parameter === 'depth' ? <p className="text-xs text-warn print:text-neutral-700">{t('series.depth.note')}</p> : null}
      <p className="flex items-center gap-1.5 text-xs text-ink-300 print:text-neutral-600">
        {t('series.hollow')} <GuideLink section="charts" entry={parameter === 'angle' ? 'polar' : parameter} />
      </p>
    </div>
  )
}

/** The section of each point of a depth series (SPEC §11.3: «con la miniatura di ogni sezione»). */
export function SectionStrip({ study }: { study: Study }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2" data-testid="series-sections">
      {study.points.map((p, k) => (
        <li key={k} className="rounded border border-ink-700 p-1 text-center text-xs print:border-neutral-300">
          <ProfileView loops={p.result.case.profile.loops.map((l) => l.points)} grid={false} className="h-16 w-full" />
          {num(100 * (p.value ?? 0), 1)}%
        </li>
      ))}
    </ul>
  )
}
