// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A saved result of the 3D tunnel (SPEC §24.2 #7), for the study page and the
// report: its conditions -- rotations, reference area, the blockage its
// numbers are corrected for (SPEC §24.6) -- the whole body's coefficients and
// forces in N, the warnings, the pictures taken when it was saved and the
// history of Cd, Cl and Cs.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TimeSeries } from '../charts/TimeSeries'
import { api } from '../lib/api'
import { num } from '../lib/format'
import type { SimulationResult3D, Stat, StudyPoint } from '../lib/types'
import { t, type MessageKey } from '../i18n/it'
import { conditionRows3d, warningsOf3d } from './present'
import { STATUS_TONE } from './StudyParts'
import { GuideLink } from '../guide/Guide'

const stat = (s: Stat | null) => (s ? `${num(s.mean, 4)} ± ${num(s.std, 4)}` : '—')
const newtons = (v: number | null) => (v !== null ? t('tunnel3d.forces.unit', { value: num(v, 4) }) : '—')

export function Conditions3DTable({ result, steps }: { result: SimulationResult3D; steps: number }) {
  return (
    <table className="w-full text-sm" data-testid="study-conditions">
      <tbody>
        {conditionRows3d(result, steps).map(([label, value]) => (
          <tr key={label} className="border-b border-ink-700/60 print:border-neutral-300">
            <th className="py-1 pr-3 text-left font-normal text-ink-300 print:text-neutral-600">{label}</th>
            <td className="py-1">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Coefficients3DTable({ result }: { result: SimulationResult3D }) {
  const c = result.coefficients
  const f = result.forces_real
  const rows: [string, string][] = [
    [t('tunnel3d.coef.cd'), stat(c.cd)],
    [t('tunnel3d.coef.cdMeasured'), stat(c.cd_measured)],
    [t('tunnel3d.coef.cl'), stat(c.cl)],
    [t('tunnel3d.coef.cs'), stat(c.cs)],
    [t('tunnel3d.forces.drag'), newtons(f.drag)],
    [t('tunnel3d.forces.lift'), newtons(f.lift)],
    [t('tunnel3d.forces.side'), newtons(f.side)],
  ]
  return (
    <div className="space-y-1">
      <p className={`text-sm font-semibold ${STATUS_TONE[result.status]}`} data-testid="study-status">
        {t(`tunnel.status.${result.status}` as MessageKey)}
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
        {t('tunnel3d.conditions.used', { area: num(result.plan.reference_area, 4), reynolds: result.plan.texts.reynolds, factor: num(c.blockage_correction, 3) })}
      </p>
    </div>
  )
}

export function Warnings3D({ result }: { result: SimulationResult3D }) {
  const tone = { warn: 'text-warn', info: 'text-accent', danger: 'text-danger' }
  return (
    <ul className="space-y-1 text-xs" data-testid="study-warnings">
      {warningsOf3d(result).map((w) => (
        <li key={w.key} className={`${tone[w.tone]} print:text-neutral-800`}>
          {w.text}
        </li>
      ))}
    </ul>
  )
}

export function History3D({ studyId, k, result, height = 170 }: { studyId: string; k: number; result: SimulationResult3D; height?: number }) {
  const history = useQuery({ queryKey: ['study-history', studyId, k], queryFn: () => api.studyHistory3d(studyId, k) })
  const samples = useMemo(
    () => (history.data ? history.data.step.map((step, i) => ({ step, cd: history.data.cd[i], cl: history.data.cl[i], cm: history.data.cs[i] })) : []),
    [history.data],
  )
  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1.5 text-sm text-ink-200 print:text-neutral-700">
        {t('tunnel.history')} <GuideLink section="charts" entry="history" />
      </h4>
      {samples.length > 1 ? <TimeSeries samples={samples} dt={result.plan.dt} height={height} third="Cs" /> : <p className="text-xs text-ink-300">{t('study.noHistory')}</p>}
    </div>
  )
}

export function Views3D({ studyId, k, point }: { studyId: string; k: number; point: StudyPoint }) {
  if (!point.views.length) return null
  return (
    <div className="grid gap-3 md:grid-cols-2 print:grid-cols-1" data-testid="study-views">
      {point.views.map((v) => (
        <figure key={v} className="space-y-1 break-inside-avoid">
          <img src={api.studyViewUrl(studyId, k, v)} alt={t(`study.view.${v}` as MessageKey)} className="w-full rounded border border-ink-700" />
          <figcaption className="text-xs text-ink-300 print:text-neutral-600">{t(`study.view.${v}` as MessageKey)}</figcaption>
        </figure>
      ))}
    </div>
  )
}

/** Everything of a 3D point on the study page. */
export function Point3D({ studyId, k, point, result }: { studyId: string; k: number; point: StudyPoint; result: SimulationResult3D }) {
  return (
    <section className="space-y-4" data-testid="study-point">
      <Warnings3D result={result} />
      <div className="grid gap-6 md:grid-cols-2">
        <Conditions3DTable result={result} steps={point.steps} />
        <Coefficients3DTable result={result} />
      </div>
      <Views3D studyId={studyId} k={k} point={point} />
      {result.fields.length ? (
        <p className="text-xs text-ink-300">{t('study.fields3d.note', { samples: num(result.fields[0].samples, 0) })}</p>
      ) : (
        <p className="text-xs text-ink-300">{t('study.noFields')}</p>
      )}
      <History3D studyId={studyId} k={k} result={result} />
    </section>
  )
}
