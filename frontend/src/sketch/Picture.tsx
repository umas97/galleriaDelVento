// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// An image filling its box, with an SVG overlay in the image's own pixels
// (y down): handles, outlines and arrows are drawn and picked in the same
// coordinates the server uses. Pointer events come with that position.
import { useRef, type PointerEvent, type ReactNode } from 'react'
import type { Pt } from './geometry'

type Handler = (point: Pt, event: PointerEvent<SVGSVGElement>) => void

export function Picture({
  href,
  size,
  dim = 1,
  children,
  onDown,
  onMove,
  onUp,
  cursor,
  testId,
}: {
  href: string | null
  size: readonly [number, number]
  /** Opacity of the image under the overlay. */
  dim?: number
  children?: ReactNode
  onDown?: Handler
  onMove?: Handler
  onUp?: Handler
  cursor?: string
  testId?: string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [w, h] = size
  const at = (event: PointerEvent<SVGSVGElement>): Pt => {
    const element = svg.current
    const matrix = element?.getScreenCTM()
    if (!element || !matrix) return [0, 0]
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return [p.x, p.y]
  }
  return (
    <svg
      ref={svg}
      className="h-full w-full touch-none select-none"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ cursor }}
      data-testid={testId}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        onDown?.(at(event), event)
      }}
      onPointerMove={(event) => onMove?.(at(event), event)}
      onPointerUp={(event) => onUp?.(at(event), event)}
    >
      <rect width={w} height={h} fill="#0c0c0c" />
      {href ? <image href={href} width={w} height={h} opacity={dim} preserveAspectRatio="none" /> : null}
      {children}
    </svg>
  )
}

/** A size in image pixels that looks the same whatever the image's resolution. */
export const unit = (size: readonly [number, number]) => Math.max(size[0], size[1]) / 400

export function pathOf(points: readonly Pt[], closed = true): string {
  if (!points.length) return ''
  return `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}${closed ? 'Z' : ''}`
}
