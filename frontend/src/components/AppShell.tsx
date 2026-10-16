// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The frame every screen sits in: the name and "Esci", which is how a desktop
// program ends without hunting for the terminal it was started from.
// In a browser window it also shows the notice that explains a tab.
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { leaveWarning, useBusy } from '../lib/busy'
import { Button, Dialog } from './Dialog'
import { t } from '../i18n/it'
import { WindowBanner } from './WindowBanner'

export function AppShell({ children }: { children: ReactNode }) {
  const { data: window_ } = useQuery({ queryKey: ['window'], queryFn: api.window })
  const [quitting, setQuitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ message: string; go: () => void } | null>(null)
  const busy = useBusy()
  const navigate = useNavigate()

  /** Whatever leaving loses is said first (SPEC §13): a series, unsaved results. */
  const guarded = (go: () => void) => {
    const message = leaveWarning()
    if (message) setAsking({ message, go })
    else go()
  }

  const quit = async () => {
    setQuitting(true)
    try {
      await api.quit()
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
      setQuitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col print:block print:h-auto">
      <div className="print:hidden">
        <WindowBanner info={window_} />
      </div>
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-4 py-2.5 print:hidden">
        <h1 className="text-base font-semibold text-ink-50">
          <Link
            to="/"
            className="hover:text-accent"
            onClick={(event) => {
              // A series holds the in-app navigation too.
              if (!busy.series) return
              event.preventDefault()
              guarded(() => navigate('/'))
            }}
          >
            {t('app.name')}
          </Link>
        </h1>
        {window_?.can_quit ? (
          <button
            className="rounded-md px-3 py-1 text-ink-200 hover:bg-ink-700 disabled:opacity-60"
            onClick={() => guarded(() => void quit())}
            disabled={quitting}
          >
            {quitting ? t('nav.quitting') : t('nav.quit')}
          </button>
        ) : null}
      </header>
      {error ? <p className="border-b border-ink-700 px-4 py-2 text-warn">{error}</p> : null}
      <main className="min-h-0 flex-1 overflow-hidden print:overflow-visible">{done ? <p className="p-6">{t('quit.done')}</p> : children}</main>
      {asking ? (
        <Dialog
          title={t('leave.title')}
          onClose={() => setAsking(null)}
          actions={
            <>
              <Button onClick={() => setAsking(null)}>{t('common.cancel')}</Button>
              <Button
                kind="danger"
                onClick={() => {
                  const go = asking.go
                  setAsking(null)
                  go()
                }}
              >
                {t('leave.confirm')}
              </Button>
            </>
          }
        >
          <p>{asking.message}</p>
        </Dialog>
      ) : null}
    </div>
  )
}
