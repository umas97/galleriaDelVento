// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A short tooltip (at most two lines, SPEC §12.3), on hover and on keyboard focus.
//
// The bubble lives in a portal on <body>, positioned on the viewport: inside
// the side panels (which scroll, hence clip) an absolutely placed bubble was
// cut at the panel's edge and hidden under the canvas next to it. Above the
// anchor when there is room, below otherwise, always inside the window.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 6
const GAP = 6

/** Where a bubble of `size` goes next to `anchor`, inside a `view` of w × h. */
export function placeTip(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  let top = anchor.top - GAP - size.height
  if (top < MARGIN) top = anchor.bottom + GAP
  top = Math.max(MARGIN, Math.min(view.height - MARGIN - size.height, top))
  const centre = (anchor.left + anchor.right) / 2
  const left = Math.max(MARGIN, Math.min(view.width - MARGIN - size.width, centre - size.width / 2))
  return { left, top }
}

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) {
      setPos(null)
      return
    }
    const a = anchor.current.getBoundingClientRect()
    const b = bubble.current.getBoundingClientRect()
    setPos(placeTip(a, b, { width: window.innerWidth, height: window.innerHeight }))
    // A panel that scrolls under the pointer would leave the bubble behind.
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, text])

  return (
    <span
      ref={anchor}
      className="inline-flex items-center"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open
        ? createPortal(
            <span
              ref={bubble}
              id={id}
              role="tooltip"
              style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              className="pointer-events-none fixed z-1000 w-max max-w-72 rounded bg-ink-950 px-2 py-1 text-xs leading-snug font-normal text-ink-100 shadow-lg ring-1 ring-ink-600"
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
