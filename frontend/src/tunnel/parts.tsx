// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Small pieces of the tunnel screen: panels, badges, a number field that
// commits on Enter or on leaving it (a replan per keystroke would restart the
// flow at every digit), and the colour legend.
import { useEffect, useState, type ReactNode } from 'react'
import { Tip } from '../components/Tip'
import { GuideLink } from '../guide/Guide'
import type { GuideTarget } from '../guide/content'
import { num, parseDecimal } from '../lib/format'
import { colorAt, type ColorMap } from '../sim2d/colormaps'

export function Panel({
  title,
  children,
  tip,
  testId,
  guide,
}: {
  title: string
  children: ReactNode
  tip?: string
  testId?: string
  /** Where the guide explains what the panel shows. */
  guide?: GuideTarget
}) {
  return (
    <section className="space-y-2 border-t border-ink-700 pt-3" data-testid={testId}>
      {title ? (
        <h3 className="flex items-center gap-1.5 font-semibold text-ink-50">
          {title}
          {tip ? (
            <Tip text={tip}>
              <span className="cursor-help text-xs text-ink-300">ⓘ</span>
            </Tip>
          ) : null}
          {guide ? <GuideLink {...guide} className="ml-auto" /> : null}
        </h3>
      ) : null}
      {children}
    </section>
  )
}

export function Badge({ children, tip, tone = 'info', testId }: { children: ReactNode; tip: string; tone?: 'info' | 'warn' | 'danger' | 'ok'; testId?: string }) {
  const style = {
    info: 'bg-accent/15 text-accent',
    warn: 'bg-warn/20 text-warn',
    danger: 'bg-danger/20 text-danger',
    ok: 'bg-ok/15 text-ok',
  }[tone]
  return (
    <Tip text={tip}>
      <span className={`cursor-help rounded px-2 py-0.5 text-xs whitespace-nowrap ${style}`} data-testid={testId}>
        {children}
      </span>
    </Tip>
  )
}

export function Row({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-ink-200">
        {tip ? (
          <Tip text={tip}>
            <span className="cursor-help">{label} ⓘ</span>
          </Tip>
        ) : (
          label
        )}
      </span>
      {children}
    </label>
  )
}

const FIELD = 'w-28 rounded border border-ink-500 bg-ink-900 px-2 py-1 text-right text-ink-50 disabled:opacity-50'

/** A number typed in Italian ("4,35"), committed on Enter or blur, clamped to [min, max]. */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  digits = 2,
  disabled,
  label,
  testId,
}: {
  value: number
  onCommit: (v: number) => void
  min: number
  max: number
  digits?: number
  disabled?: boolean
  label: string
  testId?: string
}) {
  const [text, setText] = useState(num(value, digits))
  useEffect(() => setText(num(value, digits)), [value, digits])
  const commit = () => {
    // With a decimal comma, dots can only be thousands separators.
    const parsed = parseDecimal(text.includes(',') ? text.replace(/\./g, '') : text)
    if (parsed === null) {
      setText(num(value, digits))
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setText(num(clamped, digits))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <input
      className={FIELD}
      value={text}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  testId,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <select
      className="rounded border border-ink-500 bg-ink-900 px-2 py-1 text-ink-50 disabled:opacity-50"
      value={value}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** A colour bar with its range in real units. */
export function Legend({ map, range, title, digits = 2 }: { map: ColorMap; range: [number, number]; title: string; digits?: number }) {
  const stops = Array.from({ length: 11 }, (_, k) => `${colorAt(map, k / 10)} ${k * 10}%`).join(', ')
  return (
    <div className="pointer-events-none w-56 rounded bg-ink-850/90 px-2 py-1.5 text-xs text-ink-200" data-testid="legend">
      <p className="mb-1">{title}</p>
      <div className="h-2.5 rounded-sm" style={{ background: `linear-gradient(to right, ${stops})` }} />
      <p className="mt-0.5 flex justify-between">
        <span>{num(range[0], digits)}</span>
        <span>{num(range[1], digits)}</span>
      </p>
    </div>
  )
}

/** Significant digits that suit a range's width. */
export function digitsFor(range: [number, number]): number {
  const width = Math.abs(range[1] - range[0])
  if (!(width > 0)) return 2
  return Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(width))))
}
