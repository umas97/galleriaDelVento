// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A short tooltip (at most two lines, SPEC §12.3), on hover and on keyboard focus.
import type { ReactNode } from 'react'

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex items-center" tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden w-max max-w-64 -translate-x-1/2 rounded bg-ink-950 px-2 py-1 text-xs leading-snug text-ink-100 shadow-lg ring-1 ring-ink-600 group-hover:block group-focus:block"
      >
        {text}
      </span>
    </span>
  )
}
