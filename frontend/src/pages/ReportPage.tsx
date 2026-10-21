// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The report of a study (SPEC §11.6), on paper whatever the theme: title,
// date, the profile (and for a section the model with the plane), the
// conditions, the coefficients, the pictures saved with the study, the charts
// and every warning. No WebGL: Chrome in headless mode prints this page
// (studies/report.py), opening it with a one-time token (`?stampa=`) that the
// page claims; without the token it is the preview, with «Stampa». A study
// of the 3D tunnel (SPEC §24.2 #7) has the model's thumbnail, its conditions
// with the blockage correction, the whole body's numbers, its three pictures
// and the history.
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Button } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { ProfileView } from '../components/ProfileView'
import { api } from '../lib/api'
import { num } from '../lib/format'
import { is3d, type SimulationResult3D, type Study, type StudyPoint } from '../lib/types'
import { sectionOf, studyStatus } from '../study/present'
import { CoefficientsTable, ConditionsTable, PointCharts, STATUS_TONE, SectionStrip, SeriesCharts, Warnings } from '../study/StudyParts'
import { Coefficients3DTable, Conditions3DTable, History3D, Warnings3D } from '../study/Study3D'
import { t, type MessageKey } from '../i18n/it'

export function ReportPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const token = params.get('stampa')
  const [claim, setClaim] = useState<'none' | 'pending' | 'ok' | 'expired'>(token ? 'pending' : 'none')
  useEffect(() => {
    if (!token) return
    let alive = true
    api
      .claimReport(token)
      .then((r) => alive && setClaim(r.study_id === id ? 'ok' : 'expired'))
      .catch(() => alive && setClaim('expired'))
    return () => {
      alive = false
    }
  }, [token, id])
  const query = useQuery({ queryKey: ['study', id], queryFn: () => api.study(id) })

  if (claim === 'expired') return <p className="paper p-8">{t('studyReport.expired')}</p>
  if (query.isError) return <ErrorNotice error={query.error} className="m-6" />
  if (!query.data || claim === 'pending') return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  return <Report study={query.data.study} printing={claim === 'ok'} />
}

/** The body of a 3D study's report. */
function Report3D({ study, first, result }: { study: Study; first: StudyPoint; result: SimulationResult3D }) {
  // The model's thumbnail, if it has one (the setup screen takes it; the model may be gone).
  const model = useQuery({ queryKey: ['model', study.model_id], queryFn: () => api.model(study.model_id!), enabled: Boolean(study.model_id), retry: false })
  return (
    <>
      {study.model_id && model.data?.has_thumbnail ? (
        <figure className="w-1/2 space-y-1">
          <img src={api.thumbnailUrl(study.model_id)} alt="" className="h-44 w-full rounded border border-ink-700 object-contain" />
          <figcaption className="text-xs text-ink-300">{t('studyReport.model3d', { name: result.case.name })}</figcaption>
        </figure>
      ) : null}
      <Warnings3D result={result} />
      {study.notes ? <p className="text-sm whitespace-pre-wrap">{study.notes}</p> : null}
      <section className="grid grid-cols-2 gap-5">
        <div>
          <h2 className="mb-1 font-semibold text-ink-50">{t('studyReport.conditions')}</h2>
          <Conditions3DTable result={result} steps={first.steps} />
        </div>
        <div>
          <h2 className="mb-1 font-semibold text-ink-50">{t('studyReport.coefficients')}</h2>
          <Coefficients3DTable result={result} />
        </div>
      </section>
      {first.views.length ? (
        <section className="break-before-page space-y-2">
          <h2 className="font-semibold text-ink-50">{t('studyReport.views')}</h2>
          <div className="grid grid-cols-1 gap-3">
            {first.views.map((v) => (
              <figure key={v} className="break-inside-avoid space-y-1">
                <img src={api.studyViewUrl(study.id, 0, v)} alt="" className="w-full rounded" />
                <figcaption className="text-xs text-ink-300">{t(`study.view.${v}` as MessageKey)}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}
      <section className="break-before-page space-y-2">
        <h2 className="font-semibold text-ink-50">{t('studyReport.charts')}</h2>
        <History3D studyId={study.id} k={0} result={result} height={220} />
      </section>
    </>
  )
}

function Report({ study, printing }: { study: Study; printing: boolean }) {
  const first = study.points[0]
  const any = first?.result
  const result = any && !is3d(any) ? any : undefined
  const status = studyStatus(study)
  const section = result ? sectionOf(result.case.profile.source) : null
  return (
    <div className="paper h-full overflow-y-auto print:h-auto print:overflow-visible" data-testid="report">
      <article className="mx-auto max-w-[190mm] space-y-5 p-8 print:max-w-none print:p-0">
        {!printing ? (
          <div className="flex gap-2 print:hidden">
            <Link to={`/studi/${study.id}`} className="text-sm text-accent hover:underline">
              {t('studyReport.back')}
            </Link>
            <span className="flex-1" />
            <Button kind="primary" onClick={() => window.print()}>
              {t('studyReport.print')}
            </Button>
          </div>
        ) : null}

        <header className="space-y-1 border-b border-ink-700 pb-3">
          <h1 className="text-2xl font-semibold text-ink-50">{t('studyReport.title', { name: study.name })}</h1>
          <p className="text-sm text-ink-300">
            {t('studyReport.subtitle', {
              date: new Date(study.created_at).toLocaleString('it-IT'),
              version: any?.app_version ?? '',
            })}
            {status ? <span className={`ml-2 ${STATUS_TONE[status]}`}>{t(`tunnel.status.${status}` as MessageKey)}</span> : null}
          </p>
          {study.series ? (
            <p className="text-sm text-ink-200">
              {t('study.kind.series', { parameter: t(`series.parameter.${study.series.parameter}` as MessageKey), count: study.points.length, planned: study.series.values.length })}
            </p>
          ) : null}
        </header>

        {any && first && is3d(any) ? <Report3D study={study} first={first} result={any} /> : null}
        {any && first && is3d(any) ? null : result && first ? (
          <>
            <section className="grid grid-cols-2 gap-4">
              <figure className="space-y-1">
                <ProfileView loops={result.case.profile.loops.map((l) => l.points)} className="h-44 w-full rounded border border-ink-700" testId="report-profile" />
                <figcaption className="text-xs text-ink-300">{t('studyReport.profile', { name: result.case.profile.name })}</figcaption>
              </figure>
              {section && first.views.includes('modello') ? (
                <figure className="space-y-1">
                  <img src={api.studyViewUrl(study.id, 0, 'modello')} alt="" className="h-44 w-full rounded border border-ink-700 object-contain" />
                  <figcaption className="text-xs text-ink-300">{t('studyReport.model', { name: section.model_name })}</figcaption>
                </figure>
              ) : null}
            </section>
            <Warnings result={result} />
            {study.notes ? <p className="text-sm whitespace-pre-wrap">{study.notes}</p> : null}
            <section className="grid grid-cols-2 gap-5">
              <div>
                <h2 className="mb-1 font-semibold text-ink-50">{t('studyReport.conditions')}</h2>
                <ConditionsTable result={result} steps={first.steps} />
              </div>
              <div>
                <h2 className="mb-1 font-semibold text-ink-50">{study.series ? t('studyReport.firstPoint') : t('studyReport.coefficients')}</h2>
                <CoefficientsTable result={result} />
              </div>
            </section>

            {study.series ? (
              <section className="break-before-page space-y-3">
                <h2 className="font-semibold text-ink-50">{t('study.points')}</h2>
                <table className="w-full text-sm">
                  <thead className="text-left text-ink-300">
                    <tr>
                      <th>{t(`series.parameter.${study.series.parameter}` as MessageKey)}</th>
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
                      const r = p.result
                      if (is3d(r)) return null
                      const c = r.coefficients
                      return (
                        <tr key={i} className="border-t border-ink-700">
                          <td>{study.series!.parameter === 'depth' ? `${num(100 * (p.value ?? 0), 1)}%` : num(p.value ?? 0, 2)}</td>
                          <td className={STATUS_TONE[r.status]}>{t(`tunnel.status.${r.status}` as MessageKey)}</td>
                          <td className="font-mono">{c.cd ? num(c.cd.mean, 4) : '—'}</td>
                          <td className="font-mono">{c.cl ? num(c.cl.mean, 4) : '—'}</td>
                          <td className="font-mono">{c.cm ? num(c.cm.mean, 4) : '—'}</td>
                          <td className="font-mono">{c.strouhal !== null ? num(c.strouhal, 3) : '—'}</td>
                          <td className="text-xs">{r.plan.texts.reynolds}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <SeriesCharts study={study} height={200} />
                {study.series.parameter === 'depth' ? <SectionStrip study={study} /> : null}
              </section>
            ) : null}

            {first.views.filter((v) => v !== 'modello').length ? (
              <section className="break-before-page space-y-2">
                <h2 className="font-semibold text-ink-50">{study.series ? t('studyReport.viewsFirst') : t('studyReport.views')}</h2>
                <div className="grid grid-cols-1 gap-3">
                  {first.views
                    .filter((v) => v !== 'modello')
                    .map((v) => (
                      <figure key={v} className="break-inside-avoid space-y-1">
                        <img src={api.studyViewUrl(study.id, 0, v)} alt="" className="w-full rounded" />
                        <figcaption className="text-xs text-ink-300">{t(`study.view.${v}` as MessageKey)}</figcaption>
                      </figure>
                    ))}
                </div>
              </section>
            ) : null}

            <section className="break-before-page space-y-2">
              <h2 className="font-semibold text-ink-50">{study.series ? t('studyReport.chartsFirst') : t('studyReport.charts')}</h2>
              <PointCharts studyId={study.id} k={0} result={result} height={220} stacked />
            </section>
          </>
        ) : (
          <p>{t('study.noPoints')}</p>
        )}
        <footer className="border-t border-ink-700 pt-2 text-xs text-ink-300">{t('studyReport.footer')}</footer>
      </article>
    </div>
  )
}
