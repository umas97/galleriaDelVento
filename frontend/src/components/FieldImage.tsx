// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A saved mean field drawn on a 2D canvas (no WebGL: the study pages and the
// report must work where the tunnel cannot), within a frame in metres, with a
// given colour range: the comparison draws every study with the same range
// and the same frame (SPEC §11.4).
import { useEffect, useRef } from 'react'
import { lut, type ColorMap } from '../sim2d/colormaps'
import type { Frame, MeanFields } from '../lib/fields'

const BODY = [201, 206, 216]
const OUTSIDE = [17, 17, 17]

export function FieldImage({
  fields,
  values,
  range,
  map,
  frame,
  width = 640,
  className = '',
  testId,
}: {
  fields: MeanFields
  values: Float32Array
  range: [number, number]
  map: ColorMap
  frame: Frame
  width?: number
  className?: string
  testId?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const height = Math.max(1, Math.round((width * (frame.y1 - frame.y0)) / Math.max(frame.x1 - frame.x0, 1e-12)))

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const image = ctx.createImageData(width, height)
    const table = lut(map)
    const { nx, ny, dx, solid } = fields
    const span = Math.max(range[1] - range[0], 1e-12)
    const sx = (frame.x1 - frame.x0) / width
    const sy = (frame.y1 - frame.y0) / height
    for (let py = 0; py < height; py++) {
      const y = frame.y1 - (py + 0.5) * sy
      const j = Math.floor(y / dx)
      for (let px = 0; px < width; px++) {
        const x = frame.x0 + (px + 0.5) * sx
        const i = Math.floor(x / dx)
        const o = 4 * (py * width + px)
        let rgb: number[]
        if (i < 0 || j < 0 || i >= nx || j >= ny) rgb = OUTSIDE
        else {
          const k = j * nx + i
          if (solid[k]) rgb = BODY
          else {
            const t = Math.min(1, Math.max(0, (values[k] - range[0]) / span))
            const c = 4 * Math.round(t * 255)
            rgb = [table[c], table[c + 1], table[c + 2]]
          }
        }
        image.data[o] = rgb[0]
        image.data[o + 1] = rgb[1]
        image.data[o + 2] = rgb[2]
        image.data[o + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [fields, values, range, map, frame, width, height])

  return <canvas ref={ref} width={width} height={height} className={`w-full ${className}`} data-testid={testId} />
}
