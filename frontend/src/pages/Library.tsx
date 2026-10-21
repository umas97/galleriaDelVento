// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The library, the home screen (SPEC §12.1 #1): 3D models, 2D profiles and
// studies, with search and sorting, and the drop area that recognises the file.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { useImport } from '../components/ImportProvider'
import { api } from '../lib/api'
import { bytes, metres, num } from '../lib/format'
import type { ModelRecord, ProfileSummary, StudySummary } from '../lib/types'
import { t, type MessageKey } from '../i18n/it'

type Tab = 'models' | 'profiles' | 'studies'
type Sort = 'date' | 'name' | 'size'

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'models', label: 'library.tab.models' },
  { id: 'profiles', label: 'library.tab.profiles' },
  { id: 'studies', label: 'library.tab.studies' },
]

function readTab(): Tab {
  try {
    const saved = localStorage.getItem('library-tab')
    return saved === 'profiles' || saved === 'studies' ? saved : 'models'
  } catch {
    return 'models'
  }
}

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>(readTab)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('date')
  const { openPicker } = useImport()
  const navigate = useNavigate()
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles })
  const studies = useQuery({ queryKey: ['studies'], queryFn: api.studies })

  const chooseTab = (next: Tab) => {
    setTab(next)
    try {
      localStorage.setItem('library-tab', next)
    } catch {
      // nothing to remember it with
    }
  }

  return (
    <div className="mx-auto h-full max-w-6xl space-y-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex gap-1 rounded-md bg-ink-850 p-1" role="tablist">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`rounded px-3 py-1 text-sm ${tab === id ? 'bg-ink-600 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}
              onClick={() => chooseTab(id)}
            >
              {t(label)}
              {id === 'models' && models.data ? <span className="ml-1.5 text-ink-300">{models.data.length}</span> : null}
              {id === 'profiles' && profiles.data ? <span className="ml-1.5 text-ink-300">{profiles.data.length}</span> : null}
              {id === 'studies' && studies.data ? <span className="ml-1.5 text-ink-300">{studies.data.length}</span> : null}
            </button>
          ))}
        </nav>
        <input
          className="min-w-48 flex-1 rounded-md border border-ink-600 bg-ink-850 px-3 py-1.5 text-sm"
          placeholder={t('library.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t('library.search')}
        />
        <select
          className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm"
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
          aria-label={t('library.sort')}
        >
          <option value="date">{t('library.sort.date')}</option>
          <option value="name">{t('library.sort.name')}</option>
          <option value="size">{t(tab === 'profiles' ? 'library.sort.points' : tab === 'studies' ? 'library.sort.bytes' : 'library.sort.size')}</option>
        </select>
        <Button kind="primary" onClick={openPicker}>
          {t('library.import')}
        </Button>
        <Button onClick={() => navigate('/profili/nuovo')}>{t('library.newProfile')}</Button>
      </div>

      <button
        className="w-full rounded-lg border-2 border-dashed border-ink-600 px-4 py-6 text-center text-ink-300 hover:border-accent hover:text-ink-100"
        onClick={openPicker}
      >
        {t('import.dropHere')}
      </button>

      {tab === 'models' ? <ModelGrid query={models} search={search} sort={sort} /> : null}
      {tab === 'profiles' ? <ProfileGrid query={profiles} search={search} sort={sort} /> : null}
      {tab === 'studies' ? <StudyGrid query={studies} search={search} sort={sort} /> : null}
    </div>
  )
}

function ModelGrid({
  query,
  search,
  sort,
}: {
  query: ReturnType<typeof useQuery<ModelRecord[]>>
  search: string
  sort: Sort
}) {
  const [toDelete, setToDelete] = useState<ModelRecord | null>(null)
  const [freed, setFreed] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteModel(id),
    onSuccess: (result) => {
      setToDelete(null)
      setFreed(result.freed_bytes)
      void queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = (query.data ?? []).filter(
      (m) => !needle || m.name.toLowerCase().includes(needle) || m.original_name.toLowerCase().includes(needle),
    )
    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'it'))
    if (sort === 'size') sorted.sort((a, b) => b.report.triangles - a.report.triangles)
    return sorted
  }, [query.data, search, sort])

  if (query.isPending) return <p className="text-ink-300">{t('common.loading')}</p>
  if (query.isError) return <ErrorNotice error={query.error} />
  if (!query.data.length) return <p className="py-10 text-center text-ink-300">{t('library.models.empty')}</p>
  if (!items.length) return <p className="py-10 text-center text-ink-300">{t('library.noMatch')}</p>

  return (
    <>
      {freed !== null ? (
        <p className="text-sm text-ink-300" role="status">
          {t('library.deleted', { size: bytes(freed) })}
        </p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {items.map((model) => (
          <li key={model.id} className="group relative overflow-hidden rounded-lg border border-ink-700 bg-ink-850 hover:border-ink-500">
            <Link to={`/modelli/${model.id}`} className="block">
              <div className="aspect-[16/10] bg-ink-800">
                {model.has_thumbnail ? (
                  <img
                    src={`${api.thumbnailUrl(model.id)}?v=${encodeURIComponent(JSON.stringify(model.placement))}`}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-3xl text-ink-500">▲</div>
                )}
              </div>
              <div className="space-y-0.5 p-3">
                <p className="truncate font-medium text-ink-50">{model.name}</p>
                <p className="text-xs text-ink-300">
                  {t('library.model.triangles', { count: num(model.report.triangles, 0) })} ·{' '}
                  {model.dimensions_m.map((d) => metres(d)).join(' × ')}
                </p>
                <p className="flex gap-2 text-xs">
                  <span className="text-ink-300">{t(`studyType.${model.study_type}` as MessageKey)}</span>
                  {!model.units_confirmed ? <span className="text-warn">{t('setup.units.unconfirmed')}</span> : null}
                  {model.read_only ? <span className="text-warn">{t('library.model.readOnly')}</span> : null}
                </p>
              </div>
            </Link>
            <button
              className="absolute top-2 right-2 hidden rounded bg-ink-950/80 px-2 py-0.5 text-xs text-ink-200 group-hover:block hover:text-danger focus:block"
              onClick={() => setToDelete(model)}
              aria-label={t('library.delete', { name: model.name })}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>
      {toDelete ? (
        <Dialog
          title={t('library.delete', { name: toDelete.name })}
          onClose={remove.isPending ? undefined : () => setToDelete(null)}
          actions={
            <>
              <Button onClick={() => setToDelete(null)} disabled={remove.isPending}>
                {t('common.cancel')}
              </Button>
              <Button kind="danger" onClick={() => remove.mutate(toDelete.id)} disabled={remove.isPending}>
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p>{t('library.delete.body')}</p>
          {remove.isError ? <ErrorNotice error={remove.error} /> : null}
        </Dialog>
      ) : null}
    </>
  )
}

function ProfileGrid({
  query,
  search,
  sort,
}: {
  query: ReturnType<typeof useQuery<ProfileSummary[]>>
  search: string
  sort: Sort
}) {
  const [toDelete, setToDelete] = useState<ProfileSummary | null>(null)
  const [freed, setFreed] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: (result) => {
      setToDelete(null)
      setFreed(result.freed_bytes)
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = (query.data ?? []).filter(
      (p) =>
        !needle || p.name.toLowerCase().includes(needle) || (p.model_name ?? '').toLowerCase().includes(needle),
    )
    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'it'))
    if (sort === 'size') sorted.sort((a, b) => b.points - a.points)
    return sorted
  }, [query.data, search, sort])

  if (query.isPending) return <p className="text-ink-300">{t('common.loading')}</p>
  if (query.isError) return <ErrorNotice error={query.error} />
  if (!query.data.length) return <p className="py-10 text-center text-ink-300">{t('library.profiles.empty')}</p>
  if (!items.length) return <p className="py-10 text-center text-ink-300">{t('library.noMatch')}</p>

  return (
    <>
      {freed !== null ? (
        <p className="text-sm text-ink-300" role="status">
          {t('library.profile.deleted', { size: bytes(freed) })}
        </p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {items.map((profile) => (
          <li key={profile.id} className="group relative overflow-hidden rounded-lg border border-ink-700 bg-ink-850 hover:border-ink-500">
            <Link to={`/profili/${profile.id}`} className="block">
              <div className="aspect-[16/10] bg-ink-800">
                {profile.has_thumbnail ? (
                  <img
                    src={`${api.profileThumbnailUrl(profile.id)}?v=${encodeURIComponent(profile.size.join(',') + profile.points)}`}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-3xl text-ink-500">◆</div>
                )}
              </div>
              <div className="space-y-0.5 p-3">
                <p className="truncate font-medium text-ink-50">{profile.name}</p>
                <p className="text-xs text-ink-300">
                  {profile.size.map((d) => metres(d)).join(' × ')} · {t('library.profile.points', { count: num(profile.points, 0) })}
                  {profile.loops > 1 ? ` · ${t('library.profile.loops', { count: profile.loops })}` : ''}
                </p>
                <p className="flex gap-2 text-xs">
                  <span className="text-ink-300">{t(`source.${profile.source_kind}` as MessageKey)}</span>
                  {profile.model_name ? <span className="truncate text-ink-300">{profile.model_name}</span> : null}
                  {profile.read_only ? <span className="text-warn">{t('library.model.readOnly')}</span> : null}
                </p>
              </div>
            </Link>
            <button
              className="absolute top-2 right-2 hidden rounded bg-ink-950/80 px-2 py-0.5 text-xs text-ink-200 group-hover:block hover:text-danger focus:block"
              onClick={() => setToDelete(profile)}
              aria-label={t('library.delete', { name: profile.name })}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>
      {toDelete ? (
        <Dialog
          title={t('library.delete', { name: toDelete.name })}
          onClose={remove.isPending ? undefined : () => setToDelete(null)}
          actions={
            <>
              <Button onClick={() => setToDelete(null)} disabled={remove.isPending}>
                {t('common.cancel')}
              </Button>
              <Button kind="danger" onClick={() => remove.mutate(toDelete.id)} disabled={remove.isPending}>
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p>{t('library.profile.delete.body')}</p>
          {remove.isError ? <ErrorNotice error={remove.error} /> : null}
        </Dialog>
      ) : null}
    </>
  )
}

const STATUS_TONE = { converged: 'text-ok', provisional: 'text-warn', unstable: 'text-danger' } as const

function StudyGrid({
  query,
  search,
  sort,
}: {
  query: ReturnType<typeof useQuery<StudySummary[]>>
  search: string
  sort: Sort
}) {
  const [toDelete, setToDelete] = useState<StudySummary | null>(null)
  const [freed, setFreed] = useState<number | null>(null)
  const [subject, setSubject] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteStudy(id),
    onSuccess: (result, id) => {
      setToDelete(null)
      setFreed(result.freed_bytes)
      setChosen((c) => c.filter((x) => x !== id))
      void queryClient.invalidateQueries({ queryKey: ['studies'] })
    },
  })

  // Filter by what was studied: a profile or a model (SPEC §11.2).
  const subjects = useMemo(() => {
    const out = new Map<string, string>()
    for (const s of query.data ?? []) {
      if (s.model_id) out.set(`m:${s.model_id}`, t('library.studies.model', { name: s.model_name ?? '' }))
      else if (s.profile_id) out.set(`p:${s.profile_id}`, t('library.studies.profile', { name: s.profile_name }))
    }
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it'))
  }, [query.data])

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = (query.data ?? []).filter(
      (s) =>
        (!needle || [s.name, s.profile_name, s.model_name ?? ''].some((x) => x.toLowerCase().includes(needle))) &&
        (!subject || (subject.startsWith('m:') ? s.model_id === subject.slice(2) : s.profile_id === subject.slice(2) && !s.model_id)),
    )
    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'it'))
    if (sort === 'size') sorted.sort((a, b) => b.size_bytes - a.size_bytes)
    return sorted
  }, [query.data, search, sort, subject])

  if (query.isPending) return <p className="text-ink-300">{t('common.loading')}</p>
  if (query.isError) return <ErrorNotice error={query.error} />
  if (!query.data.length) return <p className="py-10 text-center text-ink-300">{t('library.studies.empty')}</p>

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? c : [...c, id]))

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label={t('library.studies.filter')}
        >
          <option value="">{t('library.studies.all')}</option>
          {subjects.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-sm text-ink-300">{t('library.studies.chosen', { count: chosen.length })}</span>
        <Button kind="primary" disabled={!chosen.length} onClick={() => navigate(`/confronto?studi=${chosen.join(',')}`)} testId="compare-button">
          {t('library.studies.compare', { count: chosen.length })}
        </Button>
        {freed !== null ? (
          <span className="text-sm text-ink-300" role="status">
            {t('library.study.deleted', { size: bytes(freed) })}
          </span>
        ) : null}
      </div>
      {!items.length ? <p className="py-10 text-center text-ink-300">{t('library.noMatch')}</p> : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" data-testid="study-grid">
        {items.map((study) => (
          <li key={study.id} className="group relative overflow-hidden rounded-lg border border-ink-700 bg-ink-850 hover:border-ink-500">
            <Link to={`/studi/${study.id}`} className="block">
              <div className="aspect-[16/10] bg-ink-800">
                {study.has_thumbnail ? (
                  <img src={`${api.studyThumbnailUrl(study.id)}?v=${study.points}`} alt="" className="h-full w-full object-cover" draggable={false} />
                ) : (
                  <div className="grid h-full place-items-center text-3xl text-ink-500">≋</div>
                )}
              </div>
              <div className="space-y-0.5 p-3">
                <p className="truncate font-medium text-ink-50">{study.name}</p>
                <p className="text-xs text-ink-300">
                  {study.kind === 'series' && study.parameter
                    ? t('library.study.series', { parameter: t(`series.parameter.${study.parameter}` as MessageKey), count: study.points, planned: study.planned })
                    : study.cd !== null
                      ? t('library.study.coefficients', { cd: num(study.cd, 3), cl: num(study.cl ?? 0, 3) })
                      : t('study.kind.single')}
                </p>
                <p className="flex gap-2 text-xs">
                  {study.dimension === '3d' ? (
                    <span className="rounded bg-accent/20 px-1 text-accent" data-testid="study-3d">
                      {t('library.study.3d')}
                    </span>
                  ) : null}
                  {study.status ? <span className={STATUS_TONE[study.status]}>{t(`tunnel.status.${study.status}` as MessageKey)}</span> : null}
                  {study.state === 'running' ? <span className="text-warn">{t('series.state.running')}</span> : null}
                  <span className="truncate text-ink-300">{study.model_name ?? study.profile_name}</span>
                  {study.read_only ? <span className="text-warn">{t('library.model.readOnly')}</span> : null}
                </p>
                <p className="text-xs text-ink-400">{new Date(study.created_at).toLocaleString('it-IT')}</p>
              </div>
            </Link>
            <label className="absolute top-2 left-2 flex items-center gap-1 rounded bg-ink-950/80 px-1.5 py-0.5 text-xs text-ink-200">
              <input type="checkbox" checked={chosen.includes(study.id)} onChange={() => toggle(study.id)} aria-label={t('library.studies.choose', { name: study.name })} />
              {t('library.studies.compareShort')}
            </label>
            <button
              className="absolute top-2 right-2 hidden rounded bg-ink-950/80 px-2 py-0.5 text-xs text-ink-200 group-hover:block hover:text-danger focus:block"
              onClick={() => setToDelete(study)}
              aria-label={t('library.delete', { name: study.name })}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>
      {toDelete ? (
        <Dialog
          title={t('library.delete', { name: toDelete.name })}
          onClose={remove.isPending ? undefined : () => setToDelete(null)}
          actions={
            <>
              <Button onClick={() => setToDelete(null)} disabled={remove.isPending}>
                {t('common.cancel')}
              </Button>
              <Button kind="danger" onClick={() => remove.mutate(toDelete.id)} disabled={remove.isPending}>
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p>{t('study.delete.body', { size: bytes(toDelete.size_bytes) })}</p>
          {remove.isError ? <ErrorNotice error={remove.error} /> : null}
        </Dialog>
      ) : null}
    </>
  )
}
