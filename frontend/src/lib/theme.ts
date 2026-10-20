// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The theme follows the system (SPEC §12.3). CSS does that by itself; what
// draws on a canvas (the tunnel's letterbox, the 3D scene, the charts) reads
// the same tokens here and redraws when the system switches.
import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const QUERY = '(prefers-color-scheme: light)'

export function currentTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches ? 'light' : 'dark'
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const on = () => setTheme(media.matches ? 'light' : 'dark')
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [])
  return theme
}

/**
 * A colour token (`ink-900`, `accent`, `body`...) as the current theme has it --
 * at `element` when given, so a chart on the report's paper gets the paper's.
 */
export function token(name: string, element: Element = document.documentElement): string {
  const value = getComputedStyle(element).getPropertyValue(`--color-${name}`).trim()
  return value || '#111111'
}
