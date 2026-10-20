// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The last case used in the tunnel (SPEC §7.5), remembered in localStorage
// next to the settings' defaults it was started from (SPEC §14.3).
import type { AppSettings } from '../lib/types'
import type { CaseState } from './TunnelCore'

const STORE = 'tunnel-case'

/** The last case, and the settings' defaults it was started from. */
type Remembered = Partial<Pick<CaseState, 'fluid' | 'temperature_c' | 'speed' | 'resolution'>> & {
  defaults?: Partial<Pick<CaseState, 'fluid' | 'temperature_c' | 'resolution'>>
}

/**
 * The case the tunnel opens with (SPEC §7.5: «l'ultimo caso usato»): the last
 * fluid, temperature, speed and resolution -- except where the default in the
 * settings changed since that case was used. Then the new default wins: it is
 * the more recent choice.
 */
export function rememberedCase(settings: AppSettings): Partial<CaseState> {
  const defaults = {
    fluid: settings.fluido_predefinito,
    temperature_c: settings.temperatura_predefinita_c,
    resolution: settings.risoluzione,
  }
  let last: Remembered = {}
  try {
    const raw = localStorage.getItem(STORE)
    last = raw ? (JSON.parse(raw) as Remembered) : {}
  } catch {
    last = {}
  }
  // Saved before the settings existed (no `defaults`): the last case stands as it is.
  const same = <K extends keyof typeof defaults>(key: K) => !last.defaults || last.defaults[key] === defaults[key]
  // Fluid and temperature travel together: a water temperature with air is not a case.
  const pair = last.fluid !== undefined && last.temperature_c !== undefined && same('fluid') && same('temperature_c')
  const fluid = pair ? last.fluid! : defaults.fluid
  const temperature_c = pair ? last.temperature_c! : defaults.temperature_c
  return {
    fluid,
    temperature_c,
    resolution: last.resolution !== undefined && same('resolution') ? last.resolution : defaults.resolution,
    reference_mode: settings.riferimento_in_profondita === 'sezione' ? 'section' : 'fixed',
    ...(last.speed !== undefined ? { speed: last.speed } : {}),
  }
}

export function remember(state: CaseState, settings: AppSettings): void {
  try {
    const { fluid, temperature_c, speed, resolution } = state
    const defaults = { fluid: settings.fluido_predefinito, temperature_c: settings.temperatura_predefinita_c, resolution: settings.risoluzione }
    localStorage.setItem(STORE, JSON.stringify({ fluid, temperature_c, speed, resolution, defaults }))
  } catch {
    // nothing to remember it with
  }
}

