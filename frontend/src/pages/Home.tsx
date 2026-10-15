// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { t } from '../i18n/it'

export function HomePage() {
  return (
    <section className="mx-auto mt-[10vh] max-w-xl text-center">
      <h2 className="text-xl font-semibold text-ink-50">{t('home.title')}</h2>
      <p className="mt-2 text-ink-300">{t('home.body')}</p>
    </section>
  )
}
