// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What closing the window would lose (SPEC §13): a series running, or results
// in the tunnel not saved as a study. The tunnel says so here; the window's
// beforeunload and «Esci» ask before going. A series also holds the in-app
// navigation (its controls are locked anyway).
import { useSyncExternalStore } from 'react'

type State = { series: string | null; unsaved: string | null }

let state: State = { series: null, unsaved: null }
const listeners = new Set<() => void>()

function set(next: Partial<State>): void {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

/** A series is running: `message` says which point (null when it ends). */
export function setSeriesBusy(message: string | null): void {
  if (message !== state.series) set({ series: message })
}

/** The tunnel has results not saved as a study (null when saved or gone). */
export function setUnsaved(message: string | null): void {
  if (message !== state.unsaved) set({ unsaved: message })
}

/** What leaving would lose, the series first; null if nothing. */
export function leaveWarning(): string | null {
  return state.series ?? state.unsaved
}

export function useBusy(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    const warning = leaveWarning()
    if (!warning) return
    event.preventDefault()
    // Browsers show their own text; the value is still required to ask.
    event.returnValue = warning
  })
}
