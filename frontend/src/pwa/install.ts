// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Installa come app". The button exists only when the browser offered the
// prompt and we are not already installed: offering to install something that
// is installed is how an application ends up twice in the menu.
export type InstallState = { available: boolean; standalone: boolean }

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<(state: InstallState) => void>()

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches
  )
}

export function installState(): InstallState {
  return { available: deferred !== null && !isStandalone(), standalone: isStandalone() }
}

function publish(): void {
  const current = installState()
  listeners.forEach((listener) => listener(current))
}

window.addEventListener('beforeinstallprompt', (event) => {
  // Keep the event: in the dedicated window the browser's own chrome is not
  // visible, so the button has to live in our interface.
  event.preventDefault()
  deferred = event as InstallPromptEvent
  publish()
})

window.addEventListener('appinstalled', () => {
  deferred = null
  publish()
})

export function subscribeInstall(listener: (state: InstallState) => void): () => void {
  listeners.add(listener)
  listener(installState())
  return () => listeners.delete(listener)
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  await deferred.prompt()
  const choice = await deferred.userChoice
  deferred = null
  publish()
  return choice.outcome === 'accepted'
}
