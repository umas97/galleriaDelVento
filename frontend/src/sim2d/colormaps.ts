// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Colour maps (SPEC §10.6, §14.3): sequential ones for magnitudes, diverging
// ones centred on zero, the same in light and dark themes. Stops sampled from
// matplotlib's maps at ninths; in between, linear in sRGB -- at 9 stops the
// difference from the full tables does not show. Diverging maps run from blue
// (negative) to red (positive): positive vorticity is counter-clockwise, red.

export type SequentialMap = 'viridis' | 'inferno' | 'cividis'
export type DivergingMap = 'coolwarm' | 'RdBu'
export type ColorMap = SequentialMap | DivergingMap

const STOPS: Record<ColorMap, string[]> = {
  viridis: ['#440154', '#472c7a', '#3b518b', '#2c718e', '#21908d', '#27ad81', '#5cc863', '#aadc32', '#fde725'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#fcffa4'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8778', '#a69d75', '#c4b56c', '#fee838'],
  coolwarm: ['#3b4cc0', '#5977e3', '#7b9ff9', '#9ebeff', '#dddddd', '#f7b89c', '#f49a7b', '#de604d', '#b40426'],
  RdBu: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#67001f'],
}

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** 256 RGBA bytes of the map, from 0 to 1. */
export function lut(map: ColorMap): Uint8Array {
  const stops = STOPS[map].map(rgb)
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1)
    const k = Math.min(stops.length - 2, Math.floor(x))
    const w = x - k
    for (let c = 0; c < 3; c++) out[4 * i + c] = Math.round(stops[k][c] * (1 - w) + stops[k + 1][c] * w)
    out[4 * i + 3] = 255
  }
  return out
}

const tables = new Map<ColorMap, Uint8Array>()

/** CSS colour of the map at t in [0, 1] (legends, the contour coloured by Cp). */
export function colorAt(map: ColorMap, t: number): string {
  let table = tables.get(map)
  if (!table) tables.set(map, (table = lut(map)))
  const i = Math.max(0, Math.min(255, Math.round(t * 255)))
  return `rgb(${table[4 * i]}, ${table[4 * i + 1]}, ${table[4 * i + 2]})`
}

export function isDiverging(map: ColorMap): map is DivergingMap {
  return map === 'coolwarm' || map === 'RdBu'
}
