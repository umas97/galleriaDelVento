// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Everything works, but the experience is degraded and the user must know
// why": with no Chromium the interface opens in a tab, and the server hands us
// the sentence that explains it. Dismissible for good.
import { useEffect, useState } from 'react'
import type { WindowInfo } from '../lib/api'
import { t } from '../i18n/it'
import { installState, promptInstall, subscribeInstall, type InstallState } from '../pwa/install'

const DISMISSED = 'tab-notice-dismissed'

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) !== null
  } catch {
    return false
  }
}

export function WindowBanner({ info }: { info: WindowInfo | undefined }) {
  const [install, setInstall] = useState<InstallState>(installState)
  const [dismissed, setDismissed] = useState(wasDismissed)

  useEffect(() => subscribeInstall(setInstall), [])

  if (!info || info.mode !== 'tab' || dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED, '1')
    } catch {
      // nothing to remember it with
    }
  }

  return (
    <div className="flex items-start gap-3 border-b border-ink-700 bg-ink-850 px-4 py-2 text-sm">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink-100">{t('window.tabNotice.title')}</p>
        <p className="text-ink-300">{info.note}</p>
      </div>
      {install.available ? (
        <button
          className="rounded-md border border-ink-500 px-3 py-1 hover:bg-ink-700"
          onClick={() => void promptInstall()}
        >
          {t('nav.install')}
        </button>
      ) : null}
      <button className="rounded-md px-3 py-1 hover:bg-ink-700" onClick={dismiss}>
        {t('window.tabNotice.dismiss')}
      </button>
    </div>
  )
}
