// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A fatal error must not leave a white window with no way out: the window has
// no reload button of its own, so this one provides it.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n/it'

type State = { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-lg space-y-3">
          <h1 className="text-lg font-semibold text-ink-50">{t('error.title')}</h1>
          <p className="text-ink-300">{this.state.error.message}</p>
          <button
            className="rounded-md border border-ink-500 px-4 py-1.5 hover:bg-ink-700"
            onClick={() => location.reload()}
          >
            {t('error.reload')}
          </button>
        </div>
      </div>
    )
  }
}
