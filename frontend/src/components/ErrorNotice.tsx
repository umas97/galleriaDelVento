// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// An error as the user sees it (SPEC §15): one Italian sentence, and the
// technical part behind a collapsible, copyable "Dettagli". Never a traceback.
import { useState } from 'react'
import { ApiError } from '../lib/api'
import { t } from '../i18n/it'

export function errorParts(error: unknown): { message: string; technical: string } {
  if (error instanceof ApiError) return { message: error.message, technical: error.technical }
  if (error instanceof Error) return { message: t('error.generic'), technical: `${error.name}: ${error.message}` }
  return { message: t('error.generic'), technical: String(error) }
}

export function ErrorNotice({ error, className = '' }: { error: unknown; className?: string }) {
  const { message, technical } = errorParts(error)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard
      ?.writeText(`${message}\n${technical}`)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }
  return (
    <div role="alert" className={`rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm ${className}`}>
      <p className="text-ink-50">{message}</p>
      {technical ? (
        <details className="mt-1 text-ink-300">
          <summary className="cursor-pointer select-none">{t('error.details')}</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs select-text">
            {technical}
          </pre>
          <button className="mt-1 text-xs text-accent hover:underline" onClick={copy}>
            {copied ? t('error.copied') : t('error.copy')}
          </button>
        </details>
      ) : null}
    </div>
  )
}
