// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A modal dialog. Esc closes it (SPEC §12.2) unless it is busy.
import { useEffect, type ReactNode } from 'react'

type Props = {
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose?: () => void
  wide?: boolean
}

export function Dialog({ title, children, actions, onClose, wide }: Props) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg border border-ink-600 bg-ink-850 shadow-2xl`}
      >
        <h2 className="border-b border-ink-700 px-5 py-3 text-base font-semibold text-ink-50">{title}</h2>
        <div className="space-y-3 px-5 py-4 text-sm">{children}</div>
        {actions ? (
          <div className="flex justify-end gap-2 border-t border-ink-700 px-5 py-3">{actions}</div>
        ) : null}
      </div>
    </div>
  )
}

export function Button({
  children,
  onClick,
  kind = 'secondary',
  disabled,
  title,
  label,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
  /** Accessible name, when the visible text alone is ambiguous. */
  label?: string
  type?: 'button' | 'submit'
}) {
  const styles = {
    primary: 'bg-accent text-ink-950 hover:brightness-110',
    secondary: 'border border-ink-500 text-ink-100 hover:bg-ink-700',
    danger: 'bg-danger text-ink-950 hover:brightness-110',
    ghost: 'text-ink-200 hover:bg-ink-700',
  }[kind]
  return (
    <button
      type={type}
      className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
    >
      {children}
    </button>
  )
}
