// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The library, the home screen (SPEC §12.1 #1): 3D models, 2D profiles and
// studies, with search and sorting, and the drop area that recognises the file.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { useImport } from '../components/ImportProvider'
import { api } from '../lib/api'
import { bytes, metres, num } from '../lib/format'
import type { ModelRecord } from '../lib/types'
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
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })

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
          <option value="size">{t('library.sort.size')}</option>
        </select>
        <Button kind="primary" onClick={openPicker}>
          {t('library.import')}
        </Button>
        <Button disabled title={t('library.newProfile.soon')}>
          {t('library.newProfile')}
        </Button>
      </div>

      <button
        className="w-full rounded-lg border-2 border-dashed border-ink-600 px-4 py-6 text-center text-ink-300 hover:border-accent hover:text-ink-100"
        onClick={openPicker}
      >
        {t('import.dropHere')}
      </button>

      {tab === 'models' ? <ModelGrid query={models} search={search} sort={sort} /> : null}
      {tab === 'profiles' ? <p className="py-10 text-center text-ink-300">{t('library.profiles.empty')}</p> : null}
      {tab === 'studies' ? <p className="py-10 text-center text-ink-300">{t('library.studies.empty')}</p> : null}
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
