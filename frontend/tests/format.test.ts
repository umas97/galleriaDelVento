// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { bytes, metres, num, parseDecimal } from '../src/lib/format'

describe('Italian numbers', () => {
  it('formats with a decimal comma', () => {
    expect(num(4.35)).toBe('4,35')
    expect(metres(4.35)).toBe('4,35 m')
    expect(bytes(1536)).toBe('1,5 KB')
  })
  it('parses comma and dot alike, and refuses junk', () => {
    expect(parseDecimal('4,35')).toBe(4.35)
    expect(parseDecimal(' 4.35 ')).toBe(4.35)
    expect(parseDecimal('1e-3')).toBe(0.001)
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('')).toBeNull()
  })
})
