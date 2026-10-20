// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// uPlot in React (SPEC §4): the plot is made once per shape of the series and
// then only fed new data, which is what keeps live charts cheap. It follows
// the width of its box.
import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import { token, useTheme } from '../lib/theme'
import 'uplot/dist/uPlot.min.css'

export type ChartProps = {
  /** Options without width and height; a new `shape` rebuilds the plot. */
  options: Omit<uPlot.Options, 'width' | 'height'>
  data: uPlot.AlignedData
  shape: string
  height: number
  className?: string
  testId?: string
}

export const AXIS = { stroke: '#8a8a8a', grid: { stroke: '#2a2a2a', width: 1 }, ticks: { stroke: '#2a2a2a', width: 1 } }

export function Chart({ options, data, shape, height, className = '', testId }: ChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const latest = useRef(data)
  latest.current = data

  const theme = useTheme()

  useEffect(() => {
    const el = box.current
    if (!el) return
    // Axes in the theme's colours (a canvas does not read CSS variables).
    const ink = { stroke: token('ink-300', el), grid: token('ink-700', el) }
    const axes = options.axes?.map((a) => ({
      ...a,
      // Axes coloured on purpose (a probe's two scales) keep their colour.
      stroke: a.stroke === undefined || a.stroke === AXIS.stroke ? ink.stroke : a.stroke,
      grid: { ...a.grid, stroke: ink.grid },
      ticks: { ...a.ticks, stroke: ink.grid },
    }))
    const p = new uPlot({ ...options, axes, width: Math.max(100, el.clientWidth), height }, latest.current, el)
    plot.current = p
    const observer = new ResizeObserver(() => p.setSize({ width: Math.max(100, el.clientWidth), height }))
    observer.observe(el)
    return () => {
      observer.disconnect()
      p.destroy()
      plot.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when the shape changes
  }, [shape, height, theme])

  useEffect(() => {
    plot.current?.setData(data)
  }, [data])

  return <div ref={box} className={className} data-testid={testId} />
}
