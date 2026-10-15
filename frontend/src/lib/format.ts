// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Numbers as an Italian reader expects them: decimal comma, grouped thousands.

const cache = new Map<string, Intl.NumberFormat>()

function formatter(digits: number): Intl.NumberFormat {
  const key = String(digits)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('it-IT', { maximumFractionDigits: digits })
    cache.set(key, f)
  }
  return f
}

export function num(value: number, digits = 2): string {
  return formatter(digits).format(value)
}

/** Lengths in metres with a sensible number of significant digits. */
export function metres(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6
  return `${formatter(digits).format(value)} m`
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let v = value / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${formatter(1).format(v)} ${units[i]}`
}

/** Parse a number typed by the user: "4,35" and "4.35" are the same. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}
