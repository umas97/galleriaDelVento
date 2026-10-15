// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every string the user can read lives here: no visible literal in a component,
// so another language is translation work, not a refactor. Keys read like
// paths: screen, then element. When this file grows, split it per screen
// (it.home.ts, ...) and spread the parts in here.
export const it = {
  'app.name': 'galleriaDelVento',
  'nav.quit': 'Esci',
  'nav.quitting': 'Chiusura in corso…',
  'nav.install': 'Installa come app',
  'window.tabNotice.title': 'Aperto in una scheda del browser',
  'window.tabNotice.dismiss': 'Non mostrare più',
  'home.title': 'Pronto',
  'home.body':
    'Lo scheletro funziona: server, finestra e installazione. Le schermate vere arrivano con la Fase 1.',
  'quit.done': 'galleriaDelVento è stato chiuso. Puoi chiudere questa finestra.',
  'error.network': 'Il programma non risponde: è ancora in esecuzione?',
  'error.title': 'Qualcosa è andato storto',
  'error.reload': 'Ricarica',
} as const

export type MessageKey = keyof typeof it

/** The string for `key`, with `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return it[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}
