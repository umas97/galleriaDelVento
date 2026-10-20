// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The tunnel view's zoom and pan, as plain arithmetic (tested in Node).
import type { Pt } from '../profile/geometry'
import type { Transform } from './views'

/** How far the view zooms in: at the default grid, a cell grows to a few dozen pixels. */
export const MAX_ZOOM = 32

/**
 * Canvas pixels ↔ chamber cells for a view zoomed `zoom` times (1 = the whole
 * chamber, letterboxed) around the cell `centre`. The centre is kept so that
 * the chamber never slides out of a view it could fill.
 */
export function viewTransform(w: number, h: number, nx: number, ny: number, zoom: number, centre: Pt | null): Transform {
  const scale = Math.min(w / nx, h / ny) * zoom
  const [cx, cy] = clampCentre(w, h, nx, ny, scale, centre ?? [nx / 2, ny / 2])
  return { originX: w / 2 - cx * scale, originY: h / 2 - cy * scale, cellsPerPixel: 1 / scale }
}

export function clampCentre(w: number, h: number, nx: number, ny: number, scale: number, centre: Pt): Pt {
  const halfW = w / (2 * scale)
  const halfH = h / (2 * scale)
  const cx = halfW >= nx / 2 ? nx / 2 : Math.min(nx - halfW, Math.max(halfW, centre[0]))
  const cy = halfH >= ny / 2 ? ny / 2 : Math.min(ny - halfH, Math.max(halfH, centre[1]))
  return [cx, cy]
}
