// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The live numbers of the 3D tunnel (SPEC §24.2 #5): Cd, Cl and the side force
// Cs of the whole body with mean, deviation and state, corrected for the
// blockage (the measured Cd in the tooltip, SPEC §24.6); the real forces in N;
// the history chart; and «Salva studio» (SPEC §24.2 #7). Every number says its
// reference area, Reynolds numbers and correction (SPEC §2.3).
import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { TimeSeries } from '../charts/TimeSeries'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { Tip } from '../components/Tip'
import { num } from '../lib/format'
import type { CasePlan3D, Stat } from '../lib/types'
import type { Snapshot3D } from '../sim3d/engine'
import { t, type MessageKey } from '../i18n/it'
import { Badge, Panel } from './parts'

const STATUS_TONE = { transient: 'info', provisional: 'warn', converged: 'ok', unstable: 'danger' } as const

function Coef({ name, stat, tip, testId }: { name: string; stat: Stat | null; tip: string; testId: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={testId}>
      <Tip text={tip}>
        <span className="cursor-help text-ink-300">{name} ⓘ</span>
      </Tip>
      <span className="font-mono text-ink-50">
        {stat ? num(stat.mean, 3) : '—'}
        {stat ? <span className="ml-1 text-xs text-ink-300">± {num(stat.std, 3)}</span> : null}
      </span>
    </div>
  )
}

export type Save3D = {
  /** The name proposed in the dialog. */
  defaultName: () => string
  /** Collect and upload the current case; the saved study. */
  save: (name: string, notes: string) => Promise<{ id: string; name: string } | null>
}

export function Results3D({ plan, snapshot, badges, saver }: { plan: CasePlan3D; snapshot: Snapshot3D; badges: ReactNode; saver: Save3D }) {
  const s = snapshot.stats
  const status = snapshot.unstable ? 'unstable' : s.status
  const numbers = !snapshot.unstable
  const factor = plan.blockage_correction
  const per = plan.force_per_coefficient
  const force = (stat: Stat | null, testId: string, label: string) => (
    <div className="flex justify-between">
      <span className="text-ink-300">{label}</span>
      <span className="font-mono" data-testid={testId}>
        {numbers && stat ? t('tunnel3d.forces.unit', { value: num(stat.mean * per, 3) }) : '—'}
      </span>
    </div>
  )
  return (
    <div className="space-y-3 text-sm">
      <Panel title={t('tunnel3d.results')} testId="results3d" guide={{ section: 'status', entry: 'converged' }}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tip={t('tunnel.status.tip')} tone={STATUS_TONE[status]} testId="result-status">
            {t(`tunnel.status.${status}` as MessageKey)}
          </Badge>
          {badges}
        </div>
        <div className="space-y-1">
          <Coef
            name={t('tunnel3d.coef.cd')}
            stat={numbers ? s.cd : null}
            tip={t('tunnel3d.coef.cd.tip', { measured: s.cd && factor > 0 ? num(s.cd.mean / factor, 3) : '—', factor: num(factor, 3) })}
            testId="coef-cd"
          />
          <Coef name={t('tunnel3d.coef.cl')} stat={numbers ? s.cl : null} tip={t('tunnel3d.coef.cl.tip')} testId="coef-cl" />
          <Coef name={t('tunnel3d.coef.cs')} stat={numbers ? s.cm : null} tip={t('tunnel3d.coef.cs.tip')} testId="coef-cs" />
        </div>
        <p className="text-xs text-ink-300" data-testid="result-conditions">
          {t('tunnel3d.conditions.used', { area: num(plan.reference_area, 4), reynolds: plan.texts.reynolds, factor: num(factor, 3) })}
        </p>
      </Panel>

      <Panel title={t('tunnel3d.forces')} tip={t('tunnel3d.forces.tip')}>
        {force(s.cd, 'force-drag', t('tunnel3d.forces.drag'))}
        {force(s.cl, 'force-lift', t('tunnel3d.forces.lift'))}
        {force(s.cm, 'force-side', t('tunnel3d.forces.side'))}
      </Panel>

      <Panel title={t('tunnel.history')} guide={{ section: 'charts', entry: 'history' }}>
        {snapshot.chart.length > 1 ? (
          <TimeSeries samples={snapshot.chart} dt={plan.dt} third="Cs" />
        ) : (
          <p className="text-xs text-ink-300">{t('tunnel.history.empty')}</p>
        )}
      </Panel>

      <SavePanel saver={saver} ready={snapshot.ready && snapshot.step > 0} />
    </div>
  )
}

function SavePanel({ saver, ready }: { saver: Save3D; ready: boolean }) {
  const queryClient = useQueryClient()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)
  const save = async () => {
    setNaming(false)
    setBusy(true)
    setError(null)
    try {
      const study = await saver.save(name.trim() || saver.defaultName(), notes)
      if (study) {
        setSaved(study)
        void queryClient.invalidateQueries({ queryKey: ['studies'] })
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title={t('study.title')}>
      <Tip text={t('tunnel3d.save.tip')}>
        <Button
          kind="primary"
          disabled={!ready || busy}
          onClick={() => {
            setName(saver.defaultName())
            setNotes('')
            setNaming(true)
          }}
          testId="study-save"
        >
          {busy ? t('tunnel3d.save.busy') : t('tunnel3d.save')}
        </Button>
      </Tip>
      {saved ? (
        <p className="text-xs text-ok" data-testid="study-saved">
          {t('study.saved', { name: saved.name })}{' '}
          <Link to={`/studi/${saved.id}`} className="text-accent hover:underline">
            {t('study.open')}
          </Link>
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {naming ? (
        <Dialog
          title={t('tunnel3d.save')}
          onClose={() => setNaming(false)}
          actions={
            <>
              <Button onClick={() => setNaming(false)}>{t('common.cancel')}</Button>
              <Button kind="primary" onClick={() => void save()} testId="study-save-confirm">
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <label className="block space-y-1 text-sm">
            <span className="text-ink-300">{t('study.name')}</span>
            <input
              className="w-full rounded border border-ink-600 bg-ink-900 px-2 py-1"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              data-testid="study-name"
            />
          </label>
          <label className="mt-2 block space-y-1 text-sm">
            <span className="text-ink-300">{t('study.notes')}</span>
            <textarea className="h-20 w-full rounded border border-ink-600 bg-ink-900 px-2 py-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </Dialog>
      ) : null}
    </Panel>
  )
}

