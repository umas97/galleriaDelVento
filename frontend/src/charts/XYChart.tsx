// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Curves of points against a shared x (SPEC §11.3, §11.4): coefficients
// against incidence, speed or depth, polars, Cp of several studies. Points of
// a case that did not converge are drawn hollow. Each curve becomes up to
// three uPlot series on the union of the x values -- the line through every
// point, the filled points, the hollow points -- and the legend is ours.
import { useMemo } from 'react'
import type uPlot from 'uplot'
import { AXIS, Chart } from './Chart'

export type XYPoint = { x: number; y: number; filled: boolean }
export type XYCurve = { label: string; color: string; points: XYPoint[]; line?: boolean }

const BACKGROUND = '#1c1c1c'

export function XYChart({
  curves,
  xLabel,
  yLabel,
  height = 220,
  invertY = false,
  testId,
}: {
  curves: XYCurve[]
  xLabel: string
  yLabel?: string
  height?: number
  invertY?: boolean
  testId?: string
}) {
  const { data, series, shape } = useMemo(() => {
    const xs = Array.from(new Set(curves.flatMap((c) => c.points.map((p) => p.x)))).sort((a, b) => a - b)
    const index = new Map(xs.map((x, i) => [x, i]))
    const columns: (number | null)[][] = []
    const opts: uPlot.Series[] = [{}]
    for (const c of curves) {
      const at = (keep: (p: XYPoint) => boolean) => {
        const col: (number | null)[] = xs.map(() => null)
        for (const p of c.points) if (keep(p)) col[index.get(p.x)!] = p.y
        return col
      }
      if (c.line !== false) {
        columns.push(at(() => true))
        opts.push({ label: c.label, stroke: c.color, width: 1.4, spanGaps: true, points: { show: false } })
      }
      columns.push(at((p) => p.filled))
      opts.push({ label: c.label, stroke: c.color, width: 0, paths: () => null, points: { show: true, size: 6, fill: c.color, stroke: c.color } })
      columns.push(at((p) => !p.filled))
      opts.push({ label: c.label, stroke: c.color, width: 0, paths: () => null, points: { show: true, size: 6, fill: BACKGROUND, stroke: c.color, width: 1.5 } })
    }
    return {
      data: [xs, ...columns] as uPlot.AlignedData,
      series: opts,
      shape: curves.map((c) => `${c.label}:${c.color}:${c.line !== false}`).join('|') + `|${invertY}`,
    }
  }, [curves, invertY])

  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(
    () => ({
      legend: { show: false },
      cursor: { show: false },
      scales: { x: { time: false }, y: { dir: invertY ? -1 : 1 } },
      axes: [
        { ...AXIS, label: xLabel, size: 32, labelSize: 14 },
        { ...AXIS, label: yLabel, size: 50, labelSize: yLabel ? 14 : 0 },
      ],
      series,
    }),
    [series, xLabel, yLabel, invertY],
  )

  return (
    <div data-testid={testId}>
      <Chart options={options} data={data} shape={`${shape}|${xLabel}|${yLabel}`} height={height} />
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-200">
        {curves.map((c) => (
          <li key={c.label} className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ background: c.color }} />
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Distinct colours for up to eight curves, readable on dark and on paper. */
export const PALETTE = ['#7aa2f7', '#f5c26b', '#7fbf7f', '#e06c6c', '#c49af0', '#5fc7c7', '#f09a5f', '#b0b0b0']
