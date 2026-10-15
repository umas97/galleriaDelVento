// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The coefficients against time (SPEC §10.7): Cd, Cl and Cm over a sliding
// window of 20 000 steps, the time axis in seconds of the real flow.
import { useMemo } from 'react'
import type uPlot from 'uplot'
import type { CoefSample } from '../sim2d/series'
import { AXIS, Chart } from './Chart'

export function TimeSeries({ samples, dt, height = 150 }: { samples: CoefSample[]; dt: number; height?: number }) {
  const data = useMemo<uPlot.AlignedData>(
    () => [samples.map((s) => s.step * dt), samples.map((s) => s.cd), samples.map((s) => s.cl), samples.map((s) => s.cm)],
    [samples, dt],
  )
  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(
    () => ({
      legend: { show: true, live: false },
      cursor: { show: false },
      scales: { x: { time: false } },
      axes: [
        { ...AXIS, label: 's', size: 30, labelSize: 14 },
        { ...AXIS, size: 44 },
      ],
      series: [
        { label: 't' },
        { label: 'Cd', stroke: '#7aa2f7', width: 1.2 },
        { label: 'Cl', stroke: '#f5c26b', width: 1.2 },
        { label: 'Cm', stroke: '#7fbf7f', width: 1.2 },
      ],
    }),
    [],
  )
  return <Chart options={options} data={data} shape="timeseries" height={height} testId="chart-history" />
}
