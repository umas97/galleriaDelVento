// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The drawing area of the profile editor (SPEC §7.5): metres, y up. Wheel to
// zoom about the cursor, drag the background to pan. With the move tool the
// control points are dragged (one undo step per drag); «add» puts a point on
// the curve where it is clicked; «delete» removes the point clicked; a double
// click on a point turns its corner on or off; the ruler measures between two
// clicks. Raw (imported) loops are drawn but not editable.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { niceStep, pathOf } from '../components/ProfileView'
import { metres } from '../lib/format'
import { boxOf, type Pt } from '../profile/geometry'
import { sampleShape } from '../profile/spline'
import { t } from '../i18n/it'
import type { EditorDoc } from './doc'

export type Tool = 'move' | 'add' | 'delete' | 'ruler'

export type CanvasEvents = {
  /** A drag of point k of loop li: `first` is true for the first move of the drag. */
  onMove: (li: number, k: number, to: Pt, first: boolean) => void
  onInsert: (li: number, after: number, at: Pt) => void
  onDelete: (li: number, k: number) => void
  onToggleCorner: (li: number, k: number) => void
  onSelect: (li: number | null) => void
}

type View = { cx: number; cy: number; scale: number }

const HIT_PX = 8

function snapTo(p: Pt, step: number | null): Pt {
  if (!step) return p
  return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step]
}

export function EditorCanvas({
  doc,
  tool,
  selected,
  gridStep,
  snap,
  readOnly,
  fitKey,
  events,
}: {
  doc: EditorDoc
  tool: Tool
  selected: number | null
  gridStep: number | null
  snap: boolean
  readOnly: boolean
  /** Changing it re-frames the view on the drawing. */
  fitKey: string
  events: CanvasEvents
}) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState<View>({ cx: 0.5, cy: 0, scale: 500 })
  const [ruler, setRuler] = useState<Pt[]>([])
  const drag = useRef<{ kind: 'point'; li: number; k: number; moved: boolean } | { kind: 'pan'; x: number; y: number; view: View } | null>(null)
  const sampled = useMemo(
    () => doc.loops.map((loop) => (loop.kind === 'raw' ? { points: loop.points, segment: [] as number[] } : sampleShape(loop))),
    [doc],
  )

  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Frame the drawing when asked (on load, on «fit»).
  useEffect(() => {
    const b = boxOf(sampled.map((s) => s.points))
    if (!Number.isFinite(b.minX)) return
    const w = Math.max(b.maxX - b.minX, 1e-6)
    const h = Math.max(b.maxY - b.minY, 1e-6)
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: 0.8 * Math.min(size.w / w, size.h / h) })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on request and on resize
  }, [fitKey, size.w, size.h])

  const toScreen = ([x, y]: Pt): Pt => [(x - view.cx) * view.scale + size.w / 2, size.h / 2 - (y - view.cy) * view.scale]
  const toWorld = (sx: number, sy: number): Pt => [(sx - size.w / 2) / view.scale + view.cx, (size.h / 2 - sy) / view.scale + view.cy]
  const local = (event: { clientX: number; clientY: number }): [number, number] => {
    const r = host.current!.getBoundingClientRect()
    return [event.clientX - r.left, event.clientY - r.top]
  }

  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const r = el.getBoundingClientRect()
      const sx = event.clientX - r.left
      const sy = event.clientY - r.top
      setView((v) => {
        const factor = Math.exp(-event.deltaY * 0.0015)
        const wx = (sx - size.w / 2) / v.scale + v.cx
        const wy = (size.h / 2 - sy) / v.scale + v.cy
        const scale = v.scale * factor
        return { scale, cx: wx - (sx - size.w / 2) / scale, cy: wy - (size.h / 2 - sy) / scale }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [size.w, size.h])

  const hitPoint = (sx: number, sy: number): { li: number; k: number } | null => {
    let best: { li: number; k: number; d: number } | null = null
    doc.loops.forEach((loop, li) => {
      if (loop.kind === 'raw') return
      loop.points.forEach((p, k) => {
        const [px, py] = toScreen(p)
        const d = Math.hypot(px - sx, py - sy)
        if (d <= HIT_PX && (!best || d < best.d)) best = { li, k, d }
      })
    })
    return best
  }

  const hitCurve = (sx: number, sy: number): { li: number; after: number } | null => {
    let best: { li: number; after: number; d: number } | null = null
    sampled.forEach((s, li) => {
      if (doc.loops[li].kind === 'raw') return
      const n = s.points.length
      for (let i = 0; i < n; i++) {
        const a = toScreen(s.points[i])
        const b = toScreen(s.points[(i + 1) % n])
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const len2 = dx * dx + dy * dy
        const f = len2 > 0 ? Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / len2)) : 0
        const d = Math.hypot(sx - a[0] - f * dx, sy - a[1] - f * dy)
        if (d <= HIT_PX && (!best || d < best.d)) best = { li, after: s.segment[i], d }
      }
    })
    return best
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button === 1 || event.button === 2) return
    const [sx, sy] = local(event)
    const world = toWorld(sx, sy)
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    if (tool === 'ruler') {
      const p = snapTo(world, snap ? gridStep : null)
      setRuler((r) => (r.length >= 2 ? [p] : [...r, p]))
      return
    }
    const point = readOnly ? null : hitPoint(sx, sy)
    if (point) {
      events.onSelect(point.li)
      if (tool === 'delete') events.onDelete(point.li, point.k)
      else if (tool === 'move') drag.current = { kind: 'point', li: point.li, k: point.k, moved: false }
      return
    }
    const curve = readOnly ? null : hitCurve(sx, sy)
    if (curve) {
      events.onSelect(curve.li)
      if (tool === 'add') events.onInsert(curve.li, curve.after, snapTo(world, snap ? gridStep : null))
      return
    }
    events.onSelect(null)
    drag.current = { kind: 'pan', x: sx, y: sy, view }
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const [sx, sy] = local(event)
    if (d.kind === 'pan') {
      setView({ ...d.view, cx: d.view.cx - (sx - d.x) / d.view.scale, cy: d.view.cy + (sy - d.y) / d.view.scale })
      return
    }
    events.onMove(d.li, d.k, snapTo(toWorld(sx, sy), snap ? gridStep : null), !d.moved)
    d.moved = true
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const onDoubleClick = (event: React.MouseEvent) => {
    if (readOnly) return
    const [sx, sy] = local(event)
    const point = hitPoint(sx, sy)
    if (point) events.onToggleCorner(point.li, point.k)
  }

  // The world shown, for the grid.
  const [wx0, wy1] = toWorld(0, 0)
  const [wx1, wy0] = toWorld(size.w, size.h)
  const step = gridStep ?? niceStep(Math.max(wx1 - wx0, wy1 - wy0), 12)
  const grid: string[] = []
  if (gridStep !== null && (wx1 - wx0) / step < 400) {
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
      const [px] = toScreen([x, 0])
      grid.push(`M${px} 0V${size.h}`)
    }
    for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
      const [, py] = toScreen([0, y])
      grid.push(`M0 ${py}H${size.w}`)
    }
  }
  const [ox, oy] = toScreen([0, 0])
  const screenLoops = sampled.map((s) => s.points.map(toScreen))
  const cursor = tool === 'move' ? 'default' : tool === 'ruler' ? 'crosshair' : 'copy'

  return (
    <div
      ref={host}
      className="relative h-full w-full touch-none overflow-hidden bg-ink-900"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(event) => event.preventDefault()}
      data-testid="editor-canvas"
    >
      <svg className="absolute inset-0" width={size.w} height={size.h}>
        <path d={grid.join('')} stroke="#262626" strokeWidth={1} fill="none" />
        <path d={`M${ox} 0V${size.h}M0 ${oy}H${size.w}`} stroke="#3a3a3a" strokeWidth={1} fill="none" />
        <path d={pathOf(screenLoops)} fill="#c9ced8" fillOpacity={0.22} fillRule="evenodd" stroke="none" />
        {doc.loops.map((loop, li) => {
          const active = selected === li
          if (loop.kind === 'raw')
            return <path key={li} d={pathOf([screenLoops[li]])} fill="none" stroke={active ? '#b4b4b4' : '#8a8a8a'} strokeWidth={1.5} />
          const ctrl = loop.points.map(toScreen)
          return (
            <g key={li}>
              {loop.symmetricAxisY !== null ? (
                <path
                  d={`M0 ${toScreen([0, loop.symmetricAxisY])[1]}H${size.w}`}
                  stroke="#7aa2f7"
                  strokeOpacity={0.5}
                  strokeDasharray="6 5"
                />
              ) : null}
              <path d={pathOf([ctrl])} fill="none" stroke="#5a5a5a" strokeDasharray="3 4" strokeWidth={1} />
              <path d={pathOf([screenLoops[li]])} fill="none" stroke={active ? '#f5f5f5' : '#d4d4d4'} strokeWidth={active ? 2 : 1.5} />
              {readOnly
                ? null
                : ctrl.map(([x, y], k) =>
                    loop.kind === 'polyline' || loop.corners[k] ? (
                      <rect key={k} x={x - 4.5} y={y - 4.5} width={9} height={9} fill={active ? '#7aa2f7' : '#4f6aa8'} stroke="#111" />
                    ) : (
                      <circle key={k} cx={x} cy={y} r={5} fill={active ? '#7aa2f7' : '#4f6aa8'} stroke="#111" />
                    ),
                  )}
            </g>
          )
        })}
        {ruler.length ? (
          <g>
            {ruler.map((p, i) => {
              const [x, y] = toScreen(p)
              return <circle key={i} cx={x} cy={y} r={3.5} fill="#f5c26b" />
            })}
            {ruler.length === 2 ? (
              <path d={`M${toScreen(ruler[0]).join(' ')}L${toScreen(ruler[1]).join(' ')}`} stroke="#f5c26b" strokeWidth={1.5} />
            ) : null}
          </g>
        ) : null}
      </svg>
      <div className="pointer-events-none absolute right-2 bottom-2 space-y-1 text-right text-xs text-ink-300">
        {ruler.length === 2 ? (
          <p className="rounded bg-ink-850/90 px-2 py-1 text-ink-100" data-testid="ruler">
            {t('editor.ruler', { length: metres(Math.hypot(ruler[1][0] - ruler[0][0], ruler[1][1] - ruler[0][1])) })}
          </p>
        ) : null}
        {gridStep !== null ? <p className="rounded bg-ink-850/90 px-2 py-1">{t('scene.grid', { size: metres(step) })}</p> : null}
      </div>
    </div>
  )
}
