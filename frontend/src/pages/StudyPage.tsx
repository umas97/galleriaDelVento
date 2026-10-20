// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A saved study (SPEC §11.2, §12.1 #6): its numbers with their conditions,
// the pictures taken when it was saved, the mean fields, history and Cp, and
// for a series its points and curves; name and notes, every export (SPEC
// §11.5), the report, deletion. A study of a newer version is shown, never
// written (SPEC §14.2).
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { ApiError, api } from '../lib/api'
import { bytes, num } from '../lib/format'
import { useSetSetting, useSettings } from '../lib/settings'
import type { Study, StudyEnvelope } from '../lib/types'
import { sectionOf, studyStatus } from '../study/present'
import { CoefficientsTable, ConditionsTable, MeanFields, PointCharts, STATUS_TONE, SectionStrip, SeriesCharts, Warnings } from '../study/StudyParts'
import { t, type MessageKey } from '../i18n/it'

/** Back to the library, on the studies tab. */
export function toStudies(): void {
  try {
    localStorage.setItem('library-tab', 'studies')
  } catch {
    // nothing to remember it with
  }
}

export function StudyPage() {
  const { id = '' } = useParams()
  const query = useQuery({ queryKey: ['study', id], queryFn: () => api.study(id) })
  if (query.isError)
    return (
      <div className="space-y-3 p-6">
        <Link to="/" onClick={toStudies} className="text-sm text-accent hover:underline">
          {t('study.back')}
        </Link>
        <ErrorNotice error={query.error} />
      </div>
    )
  if (!query.data) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  return <StudyView envelope={query.data} />
}

function StudyView({ envelope }: { envelope: StudyEnvelope }) {
  const { study, read_only: readOnly } = envelope
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [k, setK] = useState(0)
  const [name, setName] = useState(study.name)
  const [notes, setNotes] = useState(study.notes)
  const { values: settings } = useSettings()
  const setSetting = useSetSetting()
  const separator = settings.csv_separatore
  const [exportError, setExportError] = useState<unknown>(null)
  const [noChrome, setNoChrome] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => setName(study.name), [study.name])
  useEffect(() => setNotes(study.notes), [study.notes])

  const update = useMutation({
    mutationFn: (change: { name?: string; notes?: string }) => api.updateStudy(study.id, change),
    onSuccess: (s: Study) => {
      queryClient.setQueryData(['study', study.id], { ...envelope, study: s })
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteStudy(study.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
      toStudies()
      navigate('/')
    },
  })

  const point = study.points[Math.min(k, study.points.length - 1)]
  const result = point?.result
  const status = studyStatus(study)
  const series = study.series

  const run = async (label: string, what: () => Promise<void>) => {
    setExportError(null)
    setNoChrome(false)
    setExporting(label)
    try {
      await what()
    } catch (error) {
      if (label === 'pdf' && error instanceof ApiError && error.status === 409) setNoChrome(true)
      else setExportError(error)
    } finally {
      setExporting(null)
    }
  }
  const exportPoint = (label: string, path: string) => run(label, () => api.exportStudy(study.id, path))
  const sep = `?separatore=${encodeURIComponent(separator)}`

  return (
    <div className="mx-auto h-full max-w-6xl space-y-5 overflow-y-auto p-6" data-testid="study-page">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" onClick={toStudies} className="text-sm text-accent hover:underline">
          {t('study.back')}
        </Link>
        <input
          className="min-w-64 flex-1 rounded border border-transparent bg-transparent px-1 text-lg font-semibold text-ink-50 hover:border-ink-600 focus:border-ink-500"
          value={name}
          disabled={readOnly}
          aria-label={t('study.name')}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== study.name && update.mutate({ name })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {status ? <span className={`text-sm ${STATUS_TONE[status]}`}>{t(`tunnel.status.${status}` as MessageKey)}</span> : null}
      </div>
      <p className="text-sm text-ink-300">
        {series
          ? t('study.kind.series', { parameter: t(`series.parameter.${series.parameter}` as MessageKey), count: study.points.length, planned: series.values.length })
          : t('study.kind.single')}
        {series ? ` · ${t(`series.state.${series.state}` as MessageKey)}` : ''} · {new Date(study.created_at).toLocaleString('it-IT')} · {bytes(envelope.size_bytes)}
        {study.profile_id ? (
          <>
            {' · '}
            <Link className="text-accent hover:underline" to={`/profili/${study.profile_id}`}>
              {study.profile_name}
            </Link>
          </>
        ) : (
          ` · ${study.profile_name}`
        )}
        {study.model_id ? (
          <>
            {' · '}
            <Link className="text-accent hover:underline" to={`/modelli/${study.model_id}`}>
              {study.model_name}
            </Link>
          </>
        ) : null}
      </p>
      {readOnly ? <p className="text-warn">{t('study.readOnly')}</p> : null}
      {update.isError ? <ErrorNotice error={update.error} /> : null}

      {/* Exports (SPEC §11.5) */}
      <section className="space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-3" data-testid="study-exports">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink-50">{t('study.export')}</span>
          {result ? (
            <>
              <Button disabled={!!exporting} onClick={() => void exportPoint('csv', `points/${k}/history.csv${sep}`)}>
                {t('study.export.history')}
              </Button>
              <Button disabled={!!exporting} onClick={() => void exportPoint('cp', `points/${k}/contour.csv${sep}`)}>
                {t('study.export.cp')}
              </Button>
              {series ? (
                <Button disabled={!!exporting} onClick={() => void exportPoint('series', `series.csv${sep}`)}>
                  {t('study.export.series')}
                </Button>
              ) : null}
              <Button disabled={!!exporting || !result.fields.length} onClick={() => void exportPoint('vti', `points/${k}/fields.vti`)}>
                {t('study.export.vti')}
              </Button>
              <Button disabled={!!exporting} onClick={() => void exportPoint('vtp', `points/${k}/contour.vtp`)}>
                {t('study.export.vtp')}
              </Button>
              <Button disabled={!!exporting} onClick={() => void run('dxf', () => api.exportDraft(result.case.profile, 'dxf'))}>
                {t('study.export.dxf')}
              </Button>
              <Button disabled={!!exporting} onClick={() => void run('svg', () => api.exportDraft(result.case.profile, 'svg'))}>
                {t('study.export.svg')}
              </Button>
            </>
          ) : null}
          <Button disabled={!!exporting} onClick={() => void exportPoint('json', 'export.json')}>
            {t('study.export.json')}
          </Button>
          <Button kind="primary" disabled={!!exporting || !result} onClick={() => void exportPoint('pdf', 'report.pdf')} testId="study-pdf">
            {exporting === 'pdf' ? t('study.export.pdfBusy') : t('study.export.pdf')}
          </Button>
          <Link to={`/report/${study.id}`} className="text-sm text-accent hover:underline">
            {t('study.report')}
          </Link>
          <label className="ml-auto flex items-center gap-1 text-xs text-ink-300">
            {t('study.export.separator')}
            <select
              className="rounded border border-ink-500 bg-ink-900 px-1 py-0.5"
              value={separator}
              onChange={(e) => setSetting.mutate({ key: 'csv_separatore', value: e.target.value === ',' ? ',' : ';' })}
            >
              <option value=";">{t('study.export.semicolon')}</option>
              <option value=",">{t('study.export.comma')}</option>
            </select>
          </label>
        </div>
        {noChrome ? (
          <p className="text-sm text-warn" role="alert">
            {t('study.noChrome')}{' '}
            <Link to={`/report/${study.id}`} className="text-accent hover:underline">
              {t('study.report')}
            </Link>
          </p>
        ) : null}
        {exportError ? <ErrorNotice error={exportError} /> : null}
      </section>

      {series && study.points.length ? (
        <section className="space-y-3">
          <h3 className="font-semibold text-ink-50">{t('study.points')}</h3>
          <table className="w-full text-sm" data-testid="series-points">
            <thead className="text-left text-ink-300">
              <tr>
                <th className="py-1">{t(`series.parameter.${series.parameter}` as MessageKey)}</th>
                <th>{t('study.col.status')}</th>
                <th>Cd</th>
                <th>Cl</th>
                <th>Cm</th>
                <th>St</th>
                <th>Re</th>
              </tr>
            </thead>
            <tbody>
              {study.points.map((p, i) => {
                const c = p.result.coefficients
                return (
                  <tr key={i} className={`cursor-pointer border-t border-ink-700 ${i === k ? 'bg-ink-800' : 'hover:bg-ink-850'}`} onClick={() => setK(i)}>
                    <td className="py-1">{series.parameter === 'depth' ? `${num(100 * (p.value ?? 0), 1)}%` : num(p.value ?? 0, 2)}</td>
                    <td className={STATUS_TONE[p.result.status]}>{t(`tunnel.status.${p.result.status}` as MessageKey)}</td>
                    <td className="font-mono">{c.cd ? num(c.cd.mean, 4) : '—'}</td>
                    <td className="font-mono">{c.cl ? num(c.cl.mean, 4) : '—'}</td>
                    <td className="font-mono">{c.cm ? num(c.cm.mean, 4) : '—'}</td>
                    <td className="font-mono">{c.strouhal !== null ? num(c.strouhal, 3) : '—'}</td>
                    <td>{p.result.plan.texts.reynolds}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <SeriesCharts study={study} />
          {series.parameter === 'depth' ? <SectionStrip study={study} /> : null}
        </section>
      ) : null}
      {series && !study.points.length ? <p className="text-ink-300">{t('study.noPoints')}</p> : null}

      {result && point ? (
        <section className="space-y-4" data-testid="study-point">
          {series ? <h3 className="font-semibold text-ink-50">{t('study.point', { n: k + 1 })}</h3> : null}
          <Warnings result={result} />
          <div className="grid gap-6 md:grid-cols-2">
            <ConditionsTable result={result} steps={point.steps} />
            <CoefficientsTable result={result} />
          </div>
          {point.views.length ? (
            <div className="grid gap-3 md:grid-cols-2" data-testid="study-views">
              {point.views.map((v) => (
                <figure key={v} className="space-y-1">
                  <img src={api.studyViewUrl(study.id, k, v)} alt={t(`study.view.${v}` as MessageKey)} className="w-full rounded border border-ink-700" />
                  <figcaption className="text-xs text-ink-300">{t(`study.view.${v}` as MessageKey)}</figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          <div>
            <h4 className="mb-1 text-sm text-ink-200">{t('study.fields')}</h4>
            <MeanFields studyId={study.id} k={k} result={result} />
          </div>
          <PointCharts studyId={study.id} k={k} result={result} />
          {sectionOf(result.case.profile.source) ? <p className="text-xs text-ink-300">{t('section.badge2d.tip')}</p> : null}
        </section>
      ) : null}

      <section className="space-y-1">
        <h3 className="font-semibold text-ink-50">{t('study.notes')}</h3>
        <textarea
          className="h-28 w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-ink-100"
          value={notes}
          disabled={readOnly}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== study.notes && update.mutate({ notes })}
          aria-label={t('study.notes')}
        />
      </section>

      <div className="flex justify-end">
        <Button kind="danger" onClick={() => setDeleting(true)}>
          {t('study.delete')}
        </Button>
      </div>
      {deleting ? (
        <Dialog
          title={t('library.delete', { name: study.name })}
          onClose={remove.isPending ? undefined : () => setDeleting(false)}
          actions={
            <>
              <Button onClick={() => setDeleting(false)} disabled={remove.isPending}>
                {t('common.cancel')}
              </Button>
              <Button kind="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p>{t('study.delete.body', { size: bytes(envelope.size_bytes) })}</p>
          {remove.isError ? <ErrorNotice error={remove.error} /> : null}
        </Dialog>
      ) : null}
    </div>
  )
}
