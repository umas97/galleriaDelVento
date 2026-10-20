// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The guide: what the symbols, formulas, charts, colours, states and shortcuts
// mean (SPEC §12.2: the shortcuts list opens with "?"). A drawer over the right
// side of the window, not a page: the tunnel keeps running underneath, so the
// chart being explained stays in view. Opened from the header, with "?", or
// from a small "?" next to a chart (GuideLink), which scrolls to its entry.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isTextField } from '../lib/format'
import { has, t, type MessageKey } from '../i18n/it'
import { GUIDE_SECTIONS, type GuideSection, type GuideTarget } from './content'

type GuideApi = { open: (target?: GuideTarget) => void; close: () => void; toggle: (target?: GuideTarget) => void; isOpen: boolean }

const GuideContext = createContext<GuideApi>({ open: () => undefined, close: () => undefined, toggle: () => undefined, isOpen: false })

export function useGuide(): GuideApi {
  return useContext(GuideContext)
}

const SECTIONS = Object.keys(GUIDE_SECTIONS) as GuideSection[]

export function GuideProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<GuideTarget | null>(null)
  const open = useCallback((next: GuideTarget = { section: 'symbols' }) => setTarget(next), [])
  const close = useCallback(() => setTarget(null), [])
  const toggle = useCallback((next: GuideTarget = { section: 'shortcuts' }) => setTarget((cur) => (cur ? null : next)), [])

  // "?" opens the shortcuts (SPEC §12.2), Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && target) {
        setTarget(null)
        return
      }
      if (event.key !== '?' || isTextField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      setTarget((cur) => (cur ? null : { section: 'shortcuts' }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target])

  const api = useMemo(() => ({ open, close, toggle, isOpen: target !== null }), [open, close, toggle, target])
  return (
    <GuideContext.Provider value={api}>
      {children}
      {target ? <GuideDrawer target={target} onClose={close} onPick={(section) => setTarget({ section })} /> : null}
    </GuideContext.Provider>
  )
}

/** A small "?" that opens the guide at one entry. */
export function GuideLink({ section, entry, className = '' }: GuideTarget & { className?: string }) {
  const guide = useGuide()
  return (
    <button
      type="button"
      className={`inline-grid h-4 w-4 place-items-center rounded-full border border-ink-400 text-[10px] leading-none text-ink-300 hover:border-accent hover:text-accent print:hidden ${className}`}
      aria-label={t('guide.open')}
      title={t('guide.open')}
      data-testid={`guide-link-${section}${entry ? `-${entry}` : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        guide.open({ section, entry })
      }}
    >
      ?
    </button>
  )
}

function Entry({ section, id, highlight }: { section: GuideSection; id: string; highlight: boolean }) {
  const base = `guide.${section}.${id}`
  const formula = `${base}.formula`
  const unit = `${base}.unit`
  return (
    <div
      id={`guide-${section}-${id}`}
      className={`scroll-mt-4 rounded-md border px-3 py-2 ${highlight ? 'border-accent bg-accent/10' : 'border-ink-700 bg-ink-900'}`}
      data-testid={`guide-entry-${section}-${id}`}
    >
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-ink-50">{t(`${base}.term` as MessageKey)}</span>
        {has(unit) ? <span className="text-xs text-ink-300">[{t(unit)}]</span> : null}
      </p>
      {has(formula) ? <p className="my-1 font-serif text-base text-accent italic">{t(formula)}</p> : null}
      <p className="text-sm leading-relaxed text-ink-200">{t(`${base}.text` as MessageKey)}</p>
    </div>
  )
}

function GuideDrawer({ target, onClose, onPick }: { target: GuideTarget; onClose: () => void; onPick: (s: GuideSection) => void }) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = target.entry ? `guide-${target.section}-${target.entry}` : `guide-${target.section}`
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [target])

  return (
    <aside
      role="dialog"
      aria-label={t('guide.title')}
      style={{ top: 'var(--shell-top, 0px)' }}
      className="fixed right-0 bottom-0 z-900 flex w-[min(46rem,100vw)] flex-col border-l border-ink-600 bg-ink-850 shadow-2xl print:hidden"
      data-testid="guide"
    >
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
        <h2 className="text-base font-semibold text-ink-50">{t('guide.title')}</h2>
        <button className="rounded-md px-2 py-1 text-ink-200 hover:bg-ink-700" onClick={onClose} aria-label={t('guide.close')} title={t('guide.close')}>
          ✕
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-ink-700 p-2 text-sm">
          {SECTIONS.map((s) => (
            <button
              key={s}
              className={`block w-full rounded px-2 py-1 text-left ${target.section === s ? 'bg-ink-600 text-ink-50' : 'text-ink-200 hover:bg-ink-700'}`}
              onClick={() => onPick(s)}
            >
              {t(`guide.section.${s}` as MessageKey)}
            </button>
          ))}
        </nav>
        <div ref={body} className="min-w-0 flex-1 space-y-6 overflow-y-auto p-4 select-text">
          <p className="text-sm text-ink-300">{t('guide.intro')}</p>
          {SECTIONS.map((s) => (
            <section key={s} id={`guide-${s}`} className="scroll-mt-4 space-y-2">
              <h3 className="text-sm font-semibold tracking-wide text-ink-100 uppercase">{t(`guide.section.${s}` as MessageKey)}</h3>
              {GUIDE_SECTIONS[s].map((id) => (
                <Entry key={id} section={s} id={id} highlight={target.section === s && target.entry === id} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </aside>
  )
}
