// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The library thumbnail of a profile (SPEC §14.1: profili/<uuid>.png), drawn on
// a canvas with the same look as the 3D thumbnails: light shape on dark, 16:10.
import { boxOf, type Pt } from '../profile/geometry'

export function profilePng(loops: readonly (readonly Pt[])[], width = 320, height = 200): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.fillStyle = '#1c1c1c'
  ctx.fillRect(0, 0, width, height)
  const b = boxOf(loops)
  if (Number.isFinite(b.minX)) {
    const scale = 0.84 * Math.min(width / Math.max(b.maxX - b.minX, 1e-12), height / Math.max(b.maxY - b.minY, 1e-12))
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    ctx.beginPath()
    for (const loop of loops) {
      loop.forEach(([x, y], i) => {
        const px = width / 2 + (x - cx) * scale
        const py = height / 2 - (y - cy) * scale
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath()
    }
    ctx.fillStyle = '#c9ced8'
    ctx.fill('evenodd')
    ctx.strokeStyle = '#f5f5f5'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}
