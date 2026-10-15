// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The second step of an SVG or DXF import (SPEC §7.3, §7.4): the drawing has
// been read; the user names the profile and confirms the scale -- the file's
// own units when it declares them, otherwise a real length along the wind.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { metres, parseDecimal } from '../lib/format'
import type { DrawingInfo } from '../lib/types'
import { t } from '../i18n/it'
import { Button, Dialog } from './Dialog'
import { ErrorNotice } from './ErrorNotice'
import { ProfileView } from './ProfileView'
import { useProfileSaver } from './SaveProfile'

export function DrawingImportDialog({ info, onClose }: { info: DrawingInfo; onClose: () => void }) {
  const navigate = useNavigate()
  const saver = useProfileSaver()
  const stem = info.file_name.replace(/\.[^.]+$/, '') || info.file_name
  const [name, setName] = useState(stem)
  const [mode, setMode] = useState<'file' | 'length'>(info.metres_per_unit ? 'file' : 'length')
  const [length, setLength] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const lengthValue = parseDecimal(length)
  const scale =
    mode === 'file'
      ? info.metres_per_unit
      : lengthValue && lengthValue > 0 && info.extent[0] > 0
        ? lengthValue / info.extent[0]
        : null

  const create = async () => {
    if (!scale) return
    setBusy(true)
    setError(null)
    try {
      const check = await api.drawingDraft(info.id, scale, name.trim() || stem)
      const profile = await saver.save(check.draft, { kind: 'create' })
      if (profile) {
        onClose()
        navigate(`/profili/${profile.id}`)
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        wide
        title={t('drawing.title')}
        onClose={busy ? undefined : onClose}
        actions={
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button kind="primary" disabled={!scale || !name.trim() || busy} onClick={() => void create()}>
              {t('drawing.create')}
            </Button>
          </>
        }
      >
        <p className="truncate text-ink-200">{info.file_name}</p>
        <ProfileView className="h-56 rounded bg-ink-900" loops={info.preview} grid={false} />
        <p className="text-ink-300">{t('drawing.loops', { count: info.loops })}</p>
        {info.open_discarded > 0 ? (
          <p className="text-warn">{t('drawing.openDiscarded', { count: info.open_discarded })}</p>
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs text-ink-300">{t('name.label')}</span>
          <input
            className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs text-ink-300">{t('drawing.scale')}</legend>
          {info.metres_per_unit ? (
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'file'} onChange={() => setMode('file')} />
              {t('drawing.scale.file', { units: info.units ?? '' })}
            </label>
          ) : (
            <p className="text-ink-300">{t('drawing.noUnits')}</p>
          )}
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'length'} onChange={() => setMode('length')} />
            {t('drawing.scale.length')}
          </label>
          {mode === 'length' ? (
            <div className="flex items-center gap-2 pl-6">
              <input
                className="w-28 rounded border border-ink-600 bg-ink-800 px-2 py-1"
                placeholder="1,2"
                value={length}
                onChange={(event) => setLength(event.target.value)}
                aria-label={t('drawing.scale.lengthLabel')}
                autoFocus
              />
              <span>m</span>
            </div>
          ) : null}
        </fieldset>
        <p className="rounded bg-ink-800 px-3 py-2 text-ink-200">
          {scale
            ? t('drawing.result', { w: metres(info.extent[0] * scale), h: metres(info.extent[1] * scale) })
            : '—'}
        </p>
        {error ? <ErrorNotice error={error} /> : null}
        {saver.error ? <ErrorNotice error={saver.error} /> : null}
      </Dialog>
      {saver.element}
    </>
  )
}
