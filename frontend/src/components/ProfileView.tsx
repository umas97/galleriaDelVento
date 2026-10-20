// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A 2D profile drawn to scale, y up: bodies filled (holes stay empty: even-odd
// on one path), open chains in red, an optional dashed ghost (the raw cut
// before a repair), markers at given points, a metric grid and a scale label.
// `box` fixes the framing, so a section does not jump while it is scrolled.
import { useMemo } from 'react'
import { boxOf, type Box, type Pt } from '../profile/geometry'
import { metres } from '../lib/format'

type Props = {
  loops: readonly (readonly Pt[])[]
  open?: readonly (readonly Pt[])[]
  ghost?: readonly (readonly Pt[])[]
  markers?: readonly Pt[]
  box?: Box
  className?: string
  /** Blank border as a fraction of the framed size. */
  padding?: number
  grid?: boolean
  testId?: string
}

export function pathOf(loops: readonly (readonly Pt[])[]): string {
  return loops
    .filter((l) => l.length >= 2)
    .map((l) => `M${l.map(([x, y]) => `${x} ${y}`).join('L')}Z`)
    .join('')
}

function openPath(lines: readonly (readonly Pt[])[]): string {
  return lines
    .filter((l) => l.length >= 2)
    .map((l) => `M${l.map(([x, y]) => `${x} ${y}`).join('L')}`)
    .join('')
}

/** A power of ten (or twice, or five times one) giving about `count` lines across `size`. */
export function niceStep(size: number, count = 8): number {
  if (!(size > 0)) return 1
  const raw = size / count
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p
  return 10 * p
}

export function ProfileView({ loops, open = [], ghost = [], markers = [], box, className = '', padding = 0.08, grid = true, testId }: Props) {
  const frame = useMemo(() => {
    const b = box ?? boxOf([...loops, ...open, ...ghost])
    if (!Number.isFinite(b.minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
    const w = Math.max(b.maxX - b.minX, 1e-9)
    const h = Math.max(b.maxY - b.minY, 1e-9)
    const pad = Math.max(w, h) * padding
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
  }, [box, loops, open, ghost, padding])
  const w = frame.maxX - frame.minX
  const h = frame.maxY - frame.minY
  const step = niceStep(Math.max(w, h))
  const stroke = Math.max(w, h) / 500
  const lines: string[] = []
  if (grid) {
    for (let x = Math.ceil(frame.minX / step) * step; x <= frame.maxX; x += step) lines.push(`M${x} ${frame.minY}V${frame.maxY}`)
    for (let y = Math.ceil(frame.minY / step) * step; y <= frame.maxY; y += step) lines.push(`M${frame.minX} ${y}H${frame.maxX}`)
  }
  return (
    <div className={`relative ${className}`} data-testid={testId}>
      <svg
        className="h-full w-full"
        viewBox={`${frame.minX} ${-frame.maxY} ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <g transform="scale(1,-1)">
          {grid ? <path d={lines.join('')} className="stroke-ink-700" strokeWidth={stroke * 0.6} fill="none" /> : null}
          {ghost.length ? (
            <path d={pathOf(ghost)} className="stroke-warn" strokeWidth={stroke} strokeDasharray={`${stroke * 4} ${stroke * 3}`} fill="none" />
          ) : null}
          <path d={pathOf(loops)} className="fill-body stroke-body-line" fillOpacity={0.85} fillRule="evenodd" strokeWidth={stroke} />
          {open.length ? <path d={openPath(open)} className="stroke-danger" strokeWidth={stroke * 2.5} fill="none" /> : null}
          {markers.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={stroke * 6} fill="none" className="stroke-danger" strokeWidth={stroke * 1.5} />
          ))}
        </g>
      </svg>
      {grid ? (
        <span className="pointer-events-none absolute right-1.5 bottom-1 text-[10px] text-ink-300">{metres(step)}</span>
      ) : null}
    </div>
  )
}
