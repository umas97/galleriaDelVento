// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The live results (SPEC §10.7): coefficients with mean and deviation and their
// state, the real forces per metre of depth, the history chart, Cp along the
// contour and the probes. Every number carries its conditions (SPEC §2.3):
// the reference length and the Reynolds numbers sit right under them, and a
// case that is not converged says so.
import type { ReactNode } from 'react'
import { CpCurve } from '../charts/CpCurve'
import { TimeSeries } from '../charts/TimeSeries'
import { Tip } from '../components/Tip'
import { metres, num } from '../lib/format'
import type { CasePlan } from '../lib/types'
import type { EngineSnapshot } from '../sim2d/engine'
import type { Stat } from '../sim2d/series'
import { t, type MessageKey } from '../i18n/it'
import { Badge, Panel } from './parts'

function Coef({ name, stat, tip, testId }: { name: string; stat: Stat | null; tip?: string; testId: string }) {
  const label = <span className="text-ink-300">{name}</span>
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={testId}>
      {tip ? (
        <Tip text={tip}>
          <span className="cursor-help">{label} ⓘ</span>
        </Tip>
      ) : (
        label
      )}
      <span className="font-mono text-ink-50">
        {stat ? num(stat.mean, 3) : '—'}
        {stat ? <span className="ml-1 text-xs text-ink-300">± {num(stat.std, 3)}</span> : null}
      </span>
    </div>
  )
}

const STATUS_TONE = { transient: 'info', provisional: 'warn', converged: 'ok', unstable: 'danger' } as const

export function Results({
  plan,
  snapshot,
  badges,
}: {
  plan: CasePlan
  snapshot: EngineSnapshot
  badges: ReactNode
}) {
  const s = snapshot.stats
  const status = snapshot.unstable ? 'unstable' : s.status
  const numbers = !snapshot.unstable
  const point = t(plan.reference_kind === 'chord' ? 'tunnel.point.quarter' : 'tunnel.point.centre')
  const forces = numbers && s.cd && s.cl
  return (
    <div className="space-y-3 text-sm">
      <Panel title={t('tunnel.results')} testId="results">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tip={t('tunnel.status.tip')} tone={STATUS_TONE[status]} testId="result-status">
            {t(`tunnel.status.${status}` as MessageKey)}
          </Badge>
          {badges}
        </div>
        <div className="space-y-1">
          <Coef name={t('tunnel.coef.cd')} stat={numbers ? s.cd : null} testId="coef-cd" />
          <Coef name={t('tunnel.coef.cl')} stat={numbers ? s.cl : null} testId="coef-cl" />
          <Coef name={t('tunnel.coef.cm')} stat={numbers ? s.cm : null} tip={t('tunnel.coef.cm.tip', { point })} testId="coef-cm" />
          <div className="flex items-baseline justify-between">
            <span className="text-ink-300">{t('tunnel.coef.clcd')}</span>
            <span className="font-mono text-ink-50" data-testid="coef-clcd">
              {numbers && s.clcd !== null ? num(s.clcd, 2) : '—'}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <Tip text={t('tunnel.coef.st.tip')}>
              <span className="cursor-help text-ink-300">{t('tunnel.coef.st')} ⓘ</span>
            </Tip>
            <span className="font-mono text-ink-50" data-testid="coef-st">
              {numbers && s.strouhal !== null ? num(s.strouhal, 3) : '—'}
            </span>
          </div>
        </div>
        <p className="text-xs text-ink-300" data-testid="result-conditions">
          {t('tunnel.conditions.used', { length: metres(plan.reference_length), reynolds: plan.texts.reynolds })}
        </p>
      </Panel>

      <Panel title={t('tunnel.forces')}>
        <div className="flex justify-between">
          <span className="text-ink-300">{t('tunnel.forces.drag')}</span>
          <span className="font-mono" data-testid="force-drag">
            {forces ? t('tunnel.forces.unit', { value: num(s.cd!.mean * plan.force_per_coefficient, 3) }) : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-300">{t('tunnel.forces.lift')}</span>
          <span className="font-mono" data-testid="force-lift">
            {forces ? t('tunnel.forces.unit', { value: num(s.cl!.mean * plan.force_per_coefficient, 3) }) : '—'}
          </span>
        </div>
      </Panel>

      <Panel title={t('tunnel.history')}>
        {snapshot.chart.length > 1 ? (
          <TimeSeries samples={snapshot.chart} dt={plan.dt} />
        ) : (
          <p className="text-xs text-ink-300">{t('tunnel.history.empty')}</p>
        )}
      </Panel>

      <Panel title={t('tunnel.cp')} tip={t('tunnel.coef.cp.tip')}>
        {snapshot.cp.length > 2 ? (
          <CpCurve points={snapshot.cp} chord={plan.reference_kind === 'chord'} />
        ) : (
          <p className="text-xs text-ink-300">{t('tunnel.cp.empty')}</p>
        )}
      </Panel>
    </div>
  )
}
