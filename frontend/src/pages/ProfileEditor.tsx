// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The profile editor (SPEC §7.5, §12.1 #3): `/profili/nuovo` starts from a
// symmetric teardrop of 1 m chord, `/profili/:id` opens a saved profile.
// «Salva come…» always makes a new profile (the default); «Salva» overwrites
// and is explicit. The source of an edited profile records where it came from.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Dialog } from '../components/Dialog'
import { ErrorNotice } from '../components/ErrorNotice'
import { NameDialog, SaveError, issueText, useProfileSaver } from '../components/SaveProfile'
import { Tip } from '../components/Tip'
import { niceStep } from '../components/ProfileView'
import {
  History,
  addLoop,
  circleLoop,
  deletePoint,
  docCentre,
  docFromProfile,
  docToDraft,
  insertPoint,
  makeEditable,
  movePoint,
  outlines,
  removeLoop,
  rotateDoc,
  scaleDoc,
  setLoopKind,
  setSymmetric,
  toggleCorner,
  type EditorDoc,
  type ShapeLoop,
} from '../editor/doc'
import { EditorCanvas, type Tool } from '../editor/EditorCanvas'
import { api } from '../lib/api'
import { isTextField, metres, num, parseDecimal } from '../lib/format'
import type { EditorSource, PhotoSource, Profile2D, ProfileSource } from '../lib/types'
import { boxOf, type Pt } from '../profile/geometry'
import { DEFAULT_CONTROL_POINTS } from '../profile/fit'
import { profileMetrics } from '../profile/metrics'
import { validateLoops } from '../profile/validate'
import { t } from '../i18n/it'

function teardrop(): EditorDoc {
  const points: Pt[] = [
    [1, 0],
    [0.6, 0.055],
    [0.25, 0.075],
    [0.05, 0.045],
    [0, 0],
    [0.05, -0.045],
    [0.25, -0.075],
    [0.6, -0.055],
  ]
  const loop: ShapeLoop = { kind: 'spline', points, corners: points.map((_, i) => i === 0), symmetricAxisY: null }
  return setSymmetric({ loops: [loop] }, 0, true)
}

/** «Salva come…»: a new profile edited from `original`. */
function derivedSource(original: Profile2D | null): EditorSource {
  if (!original) return { kind: 'editor', derived_from: null, origin: null }
  const s = original.source
  return { kind: 'editor', derived_from: original.id, origin: s.kind === 'editor' ? s.origin : s }
}

/** The photographed sketch a profile comes from, directly or through edits. */
function photoOrigin(source: ProfileSource): PhotoSource | null {
  if (source.kind === 'photo') return source
  if (source.kind === 'editor' && source.origin?.kind === 'photo') return source.origin
  return null
}

/** «Salva»: the same profile, now edited; an imported one keeps its origin. */
function overwriteSource(original: Profile2D): ProfileSource {
  const s = original.source
  return s.kind === 'editor' ? s : { kind: 'editor', derived_from: null, origin: s }
}

export function ProfileEditorPage() {
  const { id } = useParams()
  const isNew = !id || id === 'nuovo'
  const profile = useQuery({
    queryKey: ['profile', id],
    queryFn: () => api.profile(id!),
    enabled: !isNew,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  if (!isNew && profile.isError)
    return (
      <div className="space-y-3 p-6">
        <Link to="/" className="text-sm text-accent hover:underline">
          {t('editor.back')}
        </Link>
        <ErrorNotice error={profile.error} />
      </div>
    )
  if (!isNew && !profile.data) return <p className="p-6 text-ink-300">{t('common.loading')}</p>
  const original = isNew ? null : profile.data!.profile
  return (
    <Editor
      key={original?.id ?? 'nuovo'}
      original={original}
      readOnly={!isNew && profile.data!.read_only}
    />
  )
}

function Editor({ original, readOnly }: { original: Profile2D | null; readOnly: boolean }) {
  const navigate = useNavigate()
  const history = useRef(new History<EditorDoc>(original ? docFromProfile(original) : teardrop()))
  const [, setVersion] = useState(0)
  const doc = history.current.present
  const [savedDoc, setSavedDoc] = useState<EditorDoc | null>(original ? doc : null)
  const [name, setName] = useState(original?.name ?? t('editor.untitled'))
  const [tool, setTool] = useState<Tool>('move')
  const [selected, setSelected] = useState<number | null>(doc.loops.length ? 0 : null)
  const [gridOn, setGridOn] = useState(true)
  const [snap, setSnap] = useState(false)
  const [gridText, setGridText] = useState('')
  const [fitKey, setFitKey] = useState(0)
  const [naming, setNaming] = useState(false)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [fitInfo, setFitInfo] = useState<string | null>(null)
  const saver = useProfileSaver()
  const dirty = savedDoc !== doc || (original !== null && name !== original.name)

  const commit = useCallback((next: EditorDoc, replace = false) => {
    if (replace) history.current.replace(next)
    else history.current.push(next)
    setVersion((v) => v + 1)
  }, [])

  const undo = useCallback(() => {
    history.current.undo()
    setVersion((v) => v + 1)
  }, [])
  const redo = useCallback(() => {
    history.current.redo()
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTextField(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const shapes = useMemo(() => outlines(doc), [doc])
  const report = useMemo(() => validateLoops(shapes), [shapes])
  const metrics = useMemo(() => profileMetrics(shapes), [shapes])
  const box = useMemo(() => boxOf(shapes), [shapes])
  const autoStep = niceStep(Math.max(box.maxX - box.minX, box.maxY - box.minY) || 1, 10)
  const gridStep = gridOn ? (parseDecimal(gridText) ?? autoStep) : null
  const editable = !readOnly

  const saveAs = async (newName: string) => {
    setNaming(false)
    const saved = await saver.save(docToDraft(doc, newName, derivedSource(original)), { kind: 'create' })
    if (saved) {
      setSavedDoc(doc)
      setName(saved.name)
      navigate(`/profili/${saved.id}`, { replace: true })
    }
  }

  const save = async () => {
    if (!original) {
      setNaming(true)
      return
    }
    const saved = await saver.save(docToDraft(doc, name.trim() || original.name, overwriteSource(original)), {
      kind: 'update',
      id: original.id,
    })
    if (saved) setSavedDoc(doc)
  }

  const exportAs = (format: 'svg' | 'dxf') => {
    void api.exportDraft(docToDraft(doc, name, derivedSource(original)), format)
  }

  const photo = original ? photoOrigin(original.source) : null

  const goBack = (to: string) => {
    if (dirty) setLeaving(to)
    else navigate(to)
  }

  return (
    <div className="flex h-full min-h-0">
      <section className="relative min-w-0 flex-1">
        <EditorCanvas
          doc={doc}
          tool={tool}
          selected={selected}
          gridStep={gridStep}
          snap={snap}
          readOnly={!editable}
          fitKey={String(fitKey)}
          events={{
            onMove: (li, k, to, first) => commit(movePoint(doc, li, k, to), !first),
            onInsert: (li, after, at) => commit(insertPoint(doc, li, after, at)),
            onDelete: (li, k) => commit(deletePoint(doc, li, k)),
            onToggleCorner: (li, k) => commit(toggleCorner(doc, li, k)),
            onSelect: setSelected,
          }}
        />
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          {(['move', 'add', 'delete', 'ruler'] as Tool[]).map((name_) => (
            <button
              key={name_}
              disabled={!editable && name_ !== 'ruler' && name_ !== 'move'}
              className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${tool === name_ ? 'bg-accent text-ink-950' : 'bg-ink-850/90 text-ink-200 hover:bg-ink-700'}`}
              onClick={() => setTool(name_)}
            >
              {t(`editor.tool.${name_}`)}
            </button>
          ))}
          <Tip text={t('editor.tool.tip')}>
            <span className="cursor-help rounded bg-ink-850/90 px-2 py-1 text-xs text-ink-300">ⓘ</span>
          </Tip>
          <button className="rounded bg-ink-850/90 px-2 py-1 text-xs text-ink-200 hover:bg-ink-700" onClick={() => setFitKey((k) => k + 1)}>
            ⤢
          </button>
        </div>
        {!report.valid ? (
          <div className="absolute bottom-2 left-2 max-w-md rounded bg-ink-850/95 px-3 py-2 text-xs text-warn" role="status">
            <p>{t('editor.invalid')}</p>
            <ul className="list-disc pl-4">
              {report.issues.slice(0, 4).map((issue, i) => (
                <li key={i}>{issueText(issue)}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <aside className="w-90 shrink-0 space-y-4 overflow-y-auto border-l border-ink-700 bg-ink-850 p-4 text-sm">
        <button className="text-sm text-accent hover:underline" onClick={() => goBack('/')}>
          {t('editor.back')}
        </button>
        <input
          aria-label={t('name.label')}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold text-ink-50 hover:border-ink-600 focus:border-accent focus:outline-none"
          value={name}
          disabled={!editable}
          onChange={(event) => setName(event.target.value)}
        />
        {readOnly ? <p className="rounded bg-warn/15 px-3 py-2 text-warn">{t('editor.readOnly')}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="primary" disabled={!editable || saver.busy || (!dirty && original !== null)} onClick={() => void save()}>
            {t('editor.save')}
          </Button>
          <Button disabled={saver.busy} onClick={() => setNaming(true)}>
            {t('editor.saveAs')}
          </Button>
          <Button kind="ghost" disabled={!history.current.canUndo} onClick={undo} label={t('editor.undo')} title={t('editor.undo')}>
            ↶
          </Button>
          <Button kind="ghost" disabled={!history.current.canRedo} onClick={redo} label={t('editor.redo')} title={t('editor.redo')}>
            ↷
          </Button>
          <span className={`text-xs ${dirty ? 'text-warn' : 'text-ink-300'}`}>{dirty ? t('editor.unsaved') : original ? t('editor.saved') : ''}</span>
        </div>
        <SaveError error={saver.error} />

        <Panel title={t('editor.loops')}>
          <ul className="space-y-2">
            {doc.loops.map((loop, li) => (
              <li
                key={li}
                className={`space-y-1.5 rounded border px-2 py-1.5 ${selected === li ? 'border-accent/60 bg-ink-800' : 'border-ink-700'}`}
                onClick={() => setSelected(li)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink-100">{t('editor.loop', { n: li + 1 })}</span>
                  <button
                    className="text-xs text-ink-300 hover:text-danger disabled:opacity-40"
                    disabled={!editable || doc.loops.length <= 1}
                    onClick={(event) => {
                      event.stopPropagation()
                      commit(removeLoop(doc, li))
                      setSelected(null)
                    }}
                  >
                    {t('editor.loop.delete')}
                  </button>
                </div>
                {loop.kind === 'raw' ? (
                  <MakeEditable
                    count={loop.points.length}
                    disabled={!editable}
                    onFit={(n) => {
                      const { doc: next, maxError } = makeEditable(doc, li, n)
                      commit(next)
                      setFitInfo(t('editor.makeEditable.error', { error: metres(maxError) }))
                    }}
                  />
                ) : (
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-2">
                      <select
                        className="rounded border border-ink-600 bg-ink-800 px-1 py-0.5"
                        value={loop.kind}
                        disabled={!editable}
                        onChange={(event) => commit(setLoopKind(doc, li, event.target.value as ShapeLoop['kind']))}
                        aria-label={t('editor.loop', { n: li + 1 })}
                      >
                        <option value="spline">{t('editor.loop.spline')}</option>
                        <option value="polyline">{t('editor.loop.polyline')}</option>
                      </select>
                      <span className="text-ink-300">{t('editor.loop.points', { count: loop.points.length })}</span>
                    </div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={loop.symmetricAxisY !== null}
                        disabled={!editable}
                        onChange={(event) => commit(setSymmetric(doc, li, event.target.checked))}
                      />
                      {t('editor.loop.symmetric')}
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {fitInfo ? <p className="text-xs text-ink-300" data-testid="fit-info">{fitInfo}</p> : null}
          <Button
            disabled={!editable}
            onClick={() => {
              const [cx, cy] = docCentre(doc)
              const size = Math.max(box.maxX - box.minX, box.maxY - box.minY) || 1
              commit(addLoop(doc, circleLoop(cx, cy + size * 0.6, size * 0.1)))
              setSelected(doc.loops.length)
            }}
          >
            {t('editor.loop.add')}
          </Button>
        </Panel>

        <Panel title={t('editor.grid')}>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={gridOn} onChange={(event) => setGridOn(event.target.checked)} />
            {t('editor.grid')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={snap} disabled={!gridOn} onChange={(event) => setSnap(event.target.checked)} />
            {t('editor.grid.snap')}
          </label>
          <label className="flex items-center gap-2 text-xs">
            {t('editor.grid.size')}
            <input
              className="w-24 rounded border border-ink-600 bg-ink-800 px-2 py-0.5"
              placeholder={num(autoStep, 4)}
              value={gridText}
              onChange={(event) => setGridText(event.target.value)}
            />
          </label>
        </Panel>

        <Panel title={t('editor.transform')}>
          <NumberAction
            label={t('editor.scale')}
            placeholder="1,5"
            button={t('editor.scale.apply')}
            disabled={!editable}
            valid={(v) => v > 0}
            onApply={(v) => commit(scaleDoc(doc, v))}
          />
          <NumberAction
            label={t('editor.rotate')}
            placeholder="5"
            button={t('editor.rotate.apply')}
            disabled={!editable}
            valid={(v) => v !== 0}
            onApply={(v) => commit(rotateDoc(doc, (v * Math.PI) / 180))}
          />
        </Panel>

        <Panel title={t('editor.metrics')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="metrics">
            <dt className="text-ink-300">{t('editor.metrics.chord')}</dt>
            <dd>{metres(metrics.chord)}</dd>
            <dt className="text-ink-300">{t('editor.metrics.thickness')}</dt>
            <dd>
              {t('editor.metrics.thicknessAt', { thickness: metres(metrics.thickness), percent: num(metrics.thicknessAt * 100, 0) })}
            </dd>
            <dt className="text-ink-300">{t('editor.metrics.area')}</dt>
            <dd>{num(metrics.area, 6)} m²</dd>
            <dt className="text-ink-300">{t('editor.metrics.perimeter')}</dt>
            <dd>{metres(metrics.perimeter)}</dd>
          </dl>
        </Panel>

        {photo ? (
          <Panel title={t('editor.origin')}>
            <p className="text-ink-200">{t('editor.origin.photo', { file: photo.file_name })}</p>
            <Button onClick={() => goBack(`/schizzi/${photo.sha256.slice(0, 16)}?profilo=${original!.id}`)}>
              {t('editor.reopenSketch')}
            </Button>
          </Panel>
        ) : null}

        <Panel title={t('editor.export')}>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!report.valid} onClick={() => exportAs('svg')}>
              SVG
            </Button>
            <Button disabled={!report.valid} onClick={() => exportAs('dxf')}>
              DXF
            </Button>
            {original ? (
              <Button kind="primary" onClick={() => goBack(`/galleria/profilo/${original.id}`)}>
                {t('editor.openTunnel')}
              </Button>
            ) : (
              <Tip text={t('editor.openTunnel.unsaved')}>
                <Button kind="primary" disabled>
                  {t('editor.openTunnel')}
                </Button>
              </Tip>
            )}
          </div>
        </Panel>
      </aside>

      {naming ? (
        <NameDialog title={t('editor.saveAs')} initial={name} onCancel={() => setNaming(false)} onConfirm={(n) => void saveAs(n)} />
      ) : null}
      {leaving ? (
        <Dialog
          title={t('editor.unsaved')}
          onClose={() => setLeaving(null)}
          actions={
            <>
              <Button onClick={() => setLeaving(null)}>{t('common.cancel')}</Button>
              <Button kind="danger" onClick={() => navigate(leaving)}>
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <p>{t('editor.leave')}</p>
        </Dialog>
      ) : null}
      {saver.element}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-ink-700 pt-3">
      <h3 className="font-semibold text-ink-50">{title}</h3>
      {children}
    </section>
  )
}

function MakeEditable({ count, disabled, onFit }: { count: number; disabled: boolean; onFit: (n: number) => void }) {
  const [n, setN] = useState(String(DEFAULT_CONTROL_POINTS))
  const value = Number.parseInt(n, 10)
  const ok = Number.isFinite(value) && value >= 4 && value <= 400
  return (
    <div className="space-y-1 text-xs">
      <p className="text-ink-300">{t('editor.loop.raw', { count: num(count, 0) })}</p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1">
          {t('editor.makeEditable.points')}
          <input
            className="w-14 rounded border border-ink-600 bg-ink-800 px-1 py-0.5"
            value={n}
            onChange={(event) => setN(event.target.value)}
          />
        </label>
        <Button disabled={disabled || !ok} onClick={() => onFit(value)}>
          {t('editor.makeEditable')}
        </Button>
      </div>
    </div>
  )
}

function NumberAction({
  label,
  placeholder,
  button,
  disabled,
  valid,
  onApply,
}: {
  label: string
  placeholder: string
  button: string
  disabled: boolean
  valid: (v: number) => boolean
  onApply: (v: number) => void
}) {
  const [text, setText] = useState('')
  const value = parseDecimal(text)
  const ok = value !== null && valid(value)
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="flex flex-1 items-center justify-between gap-2">
        {label}
        <input
          className="w-20 rounded border border-ink-600 bg-ink-800 px-2 py-0.5"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <Button
        disabled={disabled || !ok}
        onClick={() => {
          if (value !== null) onApply(value)
          setText('')
        }}
      >
        {button}
      </Button>
    </div>
  )
}
