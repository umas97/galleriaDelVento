// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One probe over time (SPEC §10.7): speed (left axis) and Cp (right axis).
import { useMemo } from 'react'
import type uPlot from 'uplot'
import { AXIS, Chart } from './Chart'

export type ProbeHistory = { step: number; speed: number; cp: number }[]

export function ProbeChart({ history, dt, speedFactor, unit, index }: { history: ProbeHistory; dt: number; speedFactor: number; unit: string; index: number }) {
  const data = useMemo<uPlot.AlignedData>(
    () => [history.map((h) => h.step * dt), history.map((h) => h.speed * speedFactor), history.map((h) => h.cp)],
    [history, dt, speedFactor],
  )
  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(
    () => ({
      legend: { show: false },
      cursor: { show: false },
      scales: { x: { time: false } },
      axes: [
        { ...AXIS, size: 22, font: '10px sans-serif' },
        { ...AXIS, scale: unit, size: 40, font: '10px sans-serif', stroke: '#7aa2f7' },
        { ...AXIS, scale: 'cp', side: 1, size: 36, font: '10px sans-serif', stroke: '#f5c26b', grid: { show: false } },
      ],
      series: [{}, { scale: unit, stroke: '#7aa2f7', width: 1 }, { scale: 'cp', stroke: '#f5c26b', width: 1 }],
    }),
    [unit],
  )
  return <Chart options={options} data={data} shape={`probe-${unit}`} height={80} testId={`probe-chart-${index}`} />
}
