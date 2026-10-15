// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The frame every screen sits in: the name and "Esci", which is how a desktop
// program ends without hunting for the terminal it was started from.
// In a browser window it also shows the notice that explains a tab.
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { t } from '../i18n/it'
import { WindowBanner } from './WindowBanner'

export function AppShell({ children }: { children: ReactNode }) {
  const { data: window_ } = useQuery({ queryKey: ['window'], queryFn: api.window })
  const [quitting, setQuitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <div className="flex h-full flex-col">
      <WindowBanner info={window_} />
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-4 py-2.5">
        <h1 className="text-base font-semibold text-ink-50">{t('app.name')}</h1>
        {window_?.can_quit ? (
          <button
            className="rounded-md px-3 py-1 text-ink-200 hover:bg-ink-700 disabled:opacity-60"
            onClick={() => void quit()}
            disabled={quitting}
          >
            {quitting ? t('nav.quitting') : t('nav.quit')}
          </button>
        ) : null}
      </header>
      {error ? <p className="border-b border-ink-700 px-4 py-2 text-warn">{error}</p> : null}
      <main className="flex-1 overflow-auto p-6">{done ? <p>{t('quit.done')}</p> : children}</main>
    </div>
  )
}
