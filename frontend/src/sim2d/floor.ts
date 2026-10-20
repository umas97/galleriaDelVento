// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The floor is the chamber's bottom wall, y = 0 (SPEC §9.2, §9.3). Plain
// arithmetic for keeping a body on or above it (tested in Node).
import type { Pt } from '../profile/geometry'

/** The lowest y of the placed loops (chamber metres), or null without a body. */
export function bottomOf(placed: readonly (readonly Pt[])[]): number | null {
  let low = Infinity
  for (const loop of placed) for (const [, y] of loop) low = Math.min(low, y)
  return Number.isFinite(low) ? low : null
}

/**
 * The y of the body's position closest to `wantedY` that keeps it on or above
 * the floor -- at least `gap` above it (the moving floor's few cells) -- given
 * its position `currentY` now and its lowest point `bottom` now.
 */
export function aboveFloor(currentY: number, bottom: number, wantedY: number, gap = 0): number {
  return Math.max(wantedY, currentY - bottom + gap)
}
