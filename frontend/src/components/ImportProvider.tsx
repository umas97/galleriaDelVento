// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Importing is always an upload (SPEC §2.1): a file picker or a drop anywhere on
// the window. The backend receives bytes, never a path. The kind of file is
// recognised from its content and routed to the right flow; re-importing a
// model already in the library offers to open that one instead.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { sniffFile, type FileKind } from '../lib/sniff'
import type { DrawingInfo, ModelRecord } from '../lib/types'
import { t } from '../i18n/it'
import { Button, Dialog } from './Dialog'
import { DrawingImportDialog } from './DrawingImport'
import { ErrorNotice } from './ErrorNotice'

type ImportApi = { openPicker: () => void; importFile: (file: File) => void }

const ImportContext = createContext<ImportApi>({ openPicker: () => undefined, importFile: () => undefined })

export const useImport = () => useContext(ImportContext)

type State =
  | { step: 'idle' }
  | { step: 'uploading'; name: string; progress: number }
  | { step: 'exists'; model: ModelRecord }
  | { step: 'drawing'; info: DrawingInfo }
  | { step: 'unsupported'; name: string; kind: FileKind }
  | { step: 'error'; name: string; error: unknown }

const ACCEPT = '.stl,.obj,.svg,.dxf,.jpg,.jpeg,.png,.webp'

export function ImportProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ step: 'idle' })
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const importFile = useCallback(
    async (file: File) => {
      const kind = await sniffFile(file)
      if (kind === 'svg' || kind === 'dxf') {
        setState({ step: 'uploading', name: file.name, progress: 0 })
        try {
          const info = await api.importDrawing(file, (progress) => setState({ step: 'uploading', name: file.name, progress }))
          setState({ step: 'drawing', info })
        } catch (error) {
          setState({ step: 'error', name: file.name, error })
        }
        return
      }
      if (kind !== 'mesh') {
        setState({ step: 'unsupported', name: file.name, kind })
        return
      }
      setState({ step: 'uploading', name: file.name, progress: 0 })
      try {
        const result = await api.importModel(file, (progress) =>
          setState({ step: 'uploading', name: file.name, progress }),
        )
        await queryClient.invalidateQueries({ queryKey: ['models'] })
        if (result.status === 'exists') {
          setState({ step: 'exists', model: result.model })
        } else {
          setState({ step: 'idle' })
          navigate(`/modelli/${result.model.id}`)
        }
      } catch (error) {
        setState({ step: 'error', name: file.name, error })
      }
    },
    [navigate, queryClient],
  )

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth++
      setDragging(true)
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const file = event.dataTransfer?.files[0]
      if (file) void importFile(file)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [importFile])

  const close = () => setState({ step: 'idle' })
  const busy = state.step === 'uploading'

  return (
    <ImportContext.Provider value={{ openPicker: () => input.current?.click(), importFile: (f) => void importFile(f) }}>
      {children}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        data-testid="import-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importFile(file)
        }}
      />
      {dragging && !busy ? (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-ink-950/80">
          <p className="text-lg text-ink-50">{t('import.dropHere')}</p>
        </div>
      ) : null}
      {state.step === 'uploading' ? (
        <Dialog title={t('import.title')}>
          <p className="truncate text-ink-200">{state.name}</p>
          <div className="h-2 overflow-hidden rounded bg-ink-700">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </div>
          <p className="text-ink-300">
            {state.progress < 1
              ? t('import.uploading', { percent: Math.round(state.progress * 100) })
              : t('import.analysing')}
          </p>
        </Dialog>
      ) : null}
      {state.step === 'exists' ? (
        <Dialog
          title={t('import.exists.title')}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button
                kind="primary"
                onClick={() => {
                  close()
                  navigate(`/modelli/${state.model.id}`)
                }}
              >
                {t('import.exists.open')}
              </Button>
            </>
          }
        >
          <p>{t('import.exists.body', { name: state.model.name })}</p>
        </Dialog>
      ) : null}
      {state.step === 'drawing' ? <DrawingImportDialog info={state.info} onClose={close} /> : null}
      {state.step === 'unsupported' ? (
        <Dialog title={state.name} onClose={close} actions={<Button onClick={close}>{t('common.ok')}</Button>}>
          <p>{state.kind === 'unknown' ? t('import.unknown') : t('import.notYet')}</p>
        </Dialog>
      ) : null}
      {state.step === 'error' ? (
        <Dialog title={t('import.failed', { name: state.name })} onClose={close} actions={<Button onClick={close}>{t('common.ok')}</Button>}>
          <ErrorNotice error={state.error} />
        </Dialog>
      ) : null}
    </ImportContext.Provider>
  )
}
