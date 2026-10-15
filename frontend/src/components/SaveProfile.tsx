// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Saving a profile, from any screen (SPEC §7.1, §7.2 #6). The server checks the
// draft first; an invalid one is never repaired silently: the dialog shows the
// before and the after, «Salva» stores the repaired version and «Annulla»
// stores nothing. A live section already repaired in the browser shows its raw
// cut and the repair the same way. After saving, the thumbnail is drawn here.
import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { profilePng } from '../lib/thumbnail'
import type { Issue, Profile2D, ProfileDraft } from '../lib/types'
import type { Pt } from '../profile/geometry'
import { t, type MessageKey } from '../i18n/it'
import { Button, Dialog } from './Dialog'
import { ErrorNotice } from './ErrorNotice'
import { ProfileView } from './ProfileView'

export type SaveTarget = { kind: 'create' } | { kind: 'update'; id: string }

type Pending = {
  before: Pt[][]
  after: ProfileDraft | null
  issues: Issue[]
  target: SaveTarget
  resolve: (profile: Profile2D | null) => void
}

const loopsOf = (draft: ProfileDraft): Pt[][] => draft.loops.map((l) => l.points)

export function issueText(issue: Issue): string {
  return t(`profile.issue.${issue.code}` as MessageKey, { loop: issue.loop === null ? '' : issue.loop + 1 })
}

export function useProfileSaver() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const commit = async (draft: ProfileDraft, target: SaveTarget): Promise<Profile2D> => {
    const profile = target.kind === 'create' ? await api.createProfile(draft) : await api.updateProfile(target.id, draft)
    const png = await profilePng(loopsOf(profile))
    if (png) await api.putProfileThumbnail(profile.id, png).catch(() => undefined)
    await queryClient.invalidateQueries({ queryKey: ['profiles'] })
    queryClient.setQueryData(['profile', profile.id], { profile, read_only: false, has_thumbnail: Boolean(png) })
    return profile
  }

  const ask = (p: Omit<Pending, 'resolve'>) =>
    new Promise<Profile2D | null>((resolve) => setPending({ ...p, resolve }))

  /**
   * Check and save `draft`. `repairedFrom` is the raw cut of a live section the
   * browser has already repaired: the user confirms that repair first.
   */
  const save = async (draft: ProfileDraft, target: SaveTarget, repairedFrom?: Pt[][]): Promise<Profile2D | null> => {
    setError(null)
    if (repairedFrom) return ask({ before: repairedFrom, after: draft, issues: [], target })
    setBusy(true)
    try {
      const check = await api.checkProfile(draft)
      if (check.report.valid) return await commit(check.draft, target)
      const usable = check.repaired && check.repaired_report?.valid ? check.repaired : null
      setBusy(false)
      return await ask({ before: loopsOf(check.draft), after: usable, issues: check.report.issues, target })
    } catch (err) {
      setError(err)
      return null
    } finally {
      setBusy(false)
    }
  }

  const close = (result: Profile2D | null) => {
    pending?.resolve(result)
    setPending(null)
  }

  const confirm = async () => {
    if (!pending?.after) return
    setBusy(true)
    try {
      if (pending.issues.length === 0) {
        // A browser repair: the server still has the last word.
        const check = await api.checkProfile(pending.after)
        if (!check.report.valid) {
          const usable = check.repaired && check.repaired_report?.valid ? check.repaired : null
          setPending({ ...pending, before: loopsOf(check.draft), after: usable, issues: check.report.issues })
          return
        }
        close(await commit(check.draft, pending.target))
      } else {
        close(await commit(pending.after, pending.target))
      }
    } catch (err) {
      setError(err)
      close(null)
    } finally {
      setBusy(false)
    }
  }

  let element: ReactNode = null
  if (pending) {
    element = (
      <Dialog
        wide
        title={t('profileRepair.title')}
        onClose={busy ? undefined : () => close(null)}
        actions={
          <>
            <Button onClick={() => close(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button kind="primary" onClick={() => void confirm()} disabled={busy || !pending.after}>
              {t('profileRepair.save')}
            </Button>
          </>
        }
      >
        <p>{t('profileRepair.body')}</p>
        {pending.issues.length ? (
          <ul className="list-disc pl-5 text-warn">
            {pending.issues.map((issue, i) => (
              <li key={i}>{issueText(issue)}</li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <figure className="space-y-1">
            <figcaption className="text-xs text-ink-300">{t('profileRepair.before')}</figcaption>
            <ProfileView
              className="h-56 rounded bg-ink-900"
              loops={pending.before}
              markers={pending.issues.flatMap((i) => (i.at ? [i.at] : []))}
            />
          </figure>
          <figure className="space-y-1">
            <figcaption className="text-xs text-ink-300">{t('profileRepair.after')}</figcaption>
            {pending.after ? (
              <ProfileView className="h-56 rounded bg-ink-900" loops={loopsOf(pending.after)} />
            ) : (
              <p className="grid h-56 place-items-center rounded bg-ink-900 p-4 text-center text-warn">
                {t('profileRepair.impossible')}
              </p>
            )}
          </figure>
        </div>
      </Dialog>
    )
  }
  return { save, element, busy, error }
}

export function NameDialog({
  title,
  initial,
  onCancel,
  onConfirm,
  busy,
  children,
}: {
  title: string
  initial: string
  onCancel: () => void
  onConfirm: (name: string) => void
  busy?: boolean
  children?: ReactNode
}) {
  const [name, setName] = useState(initial)
  const ok = name.trim().length > 0
  return (
    <Dialog
      title={title}
      onClose={busy ? undefined : onCancel}
      actions={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button kind="primary" disabled={!ok || busy} onClick={() => onConfirm(name.trim())}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-xs text-ink-300">{t('name.label')}</span>
        <input
          className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1"
          value={name}
          maxLength={200}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ok) onConfirm(name.trim())
          }}
        />
      </label>
      {children}
    </Dialog>
  )
}

export function SaveError({ error }: { error: unknown }) {
  return error ? <ErrorNotice error={error} /> : null
}
