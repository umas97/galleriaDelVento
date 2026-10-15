// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cp along the contour (SPEC §10.7): against x/c, upper and lower surface apart,
// for a chord reference; along the perimeter for blunt bodies. The Cp axis
// points down, as aerodynamicists draw it (suction on top).
import { useMemo } from 'react'
import type uPlot from 'uplot'
import type { CpPoint } from '../sim2d/engine'
import { t } from '../i18n/it'
import { AXIS, Chart } from './Chart'

export function CpCurve({ points, chord, height = 170 }: { points: CpPoint[]; chord: boolean; height?: number }) {
  const data = useMemo<uPlot.AlignedData>(() => {
    if (!chord) {
      const sorted = [...points].sort((a, b) => a.s - b.s)
      return [sorted.map((p) => p.s), sorted.map((p) => p.cp)]
    }
    // One x axis for both surfaces: each point belongs to one series, null elsewhere.
    const sorted = [...points].sort((a, b) => a.xc - b.xc)
    return [
      sorted.map((p) => p.xc),
      sorted.map((p) => (p.upper ? p.cp : null)),
      sorted.map((p) => (p.upper ? null : p.cp)),
    ] as uPlot.AlignedData
  }, [points, chord])
  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(
    () => ({
      legend: { show: true, live: false },
      cursor: { show: false },
      scales: { x: { time: false }, y: { dir: -1 } },
      axes: [
        { ...AXIS, label: chord ? t('tunnel.cp.xc') : t('tunnel.cp.s'), size: 30, labelSize: 14 },
        { ...AXIS, label: 'Cp', size: 44, labelSize: 14 },
      ],
      series: chord
        ? [
            {},
            { label: t('tunnel.cp.upper'), stroke: '#e06c6c', width: 0, points: { show: true, size: 3, fill: '#e06c6c' }, spanGaps: false },
            { label: t('tunnel.cp.lower'), stroke: '#7aa2f7', width: 0, points: { show: true, size: 3, fill: '#7aa2f7' }, spanGaps: false },
          ]
        : [{}, { label: t('tunnel.cp.perimeter'), stroke: '#f5c26b', width: 1.2 }],
    }),
    [chord],
  )
  return <Chart options={options} data={data} shape={`cp-${chord}`} height={height} testId="chart-cp" />
}
