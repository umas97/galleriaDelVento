// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings (SPEC §12.1 #9, §14.3): each control writes its key at once; the
// server validates it and answers with every value. Below, the space the
// library takes on disk, folder by folder.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ErrorNotice } from '../components/ErrorNotice'
import { Tip } from '../components/Tip'
import { api } from '../lib/api'
import { bytes } from '../lib/format'
import { useSetSetting, useSettings } from '../lib/settings'
import type { AppSettings } from '../lib/types'
import { colorAt, type ColorMap } from '../sim2d/colormaps'
import { NumberField } from '../tunnel/parts'
import { t, type MessageKey } from '../i18n/it'

type Choice<K extends keyof AppSettings> = { key: K; options: AppSettings[K][]; tip?: MessageKey }

const CHOICES: Choice<keyof AppSettings>[] = [
  { key: 'unita_velocita', options: ['m/s', 'km/h'] },
  { key: 'fluido_predefinito', options: ['aria', 'acqua'] },
  { key: 'risoluzione', options: ['bozza', 'normale', 'fine'], tip: 'settings.risoluzione.tip' },
  { key: 'riferimento_in_profondita', options: ['fissa', 'sezione'], tip: 'settings.riferimento_in_profondita.tip' },
  { key: 'csv_separatore', options: [';', ','] },
] as Choice<keyof AppSettings>[]

const MAPS: Choice<'mappa_sequenziale' | 'mappa_divergente'>[] = [
  { key: 'mappa_sequenziale', options: ['viridis', 'inferno', 'cividis'], tip: 'settings.mappa_sequenziale.tip' },
  { key: 'mappa_divergente', options: ['coolwarm', 'RdBu'], tip: 'settings.mappa_divergente.tip' },
]

const TEMPERATURES = { aria: [-20, 50], acqua: [5, 40] } as const

function Swatch({ map }: { map: ColorMap }) {
  const stops = Array.from({ length: 11 }, (_, k) => `${colorAt(map, k / 10)} ${k * 10}%`).join(', ')
  return <span className="inline-block h-3 w-20 rounded-sm align-middle" style={{ background: `linear-gradient(to right, ${stops})` }} aria-hidden />
}

function Label({ name, tip }: { name: keyof AppSettings; tip?: MessageKey }) {
  const text = t(`settings.${name}` as MessageKey)
  return tip ? (
    <Tip text={t(tip)}>
      <span className="cursor-help">{text} ⓘ</span>
    </Tip>
  ) : (
    <span>{text}</span>
  )
}

export function SettingsPage() {
  const { values } = useSettings()
  const set = useSetSetting()
  const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage })
  const write = (key: keyof AppSettings, value: unknown) => set.mutate({ key, value })
  const select = 'rounded border border-ink-500 bg-ink-900 px-2 py-1 text-ink-50'
  const [lo, hi] = TEMPERATURES[values.fluido_predefinito]

  return (
    <div className="mx-auto h-full max-w-3xl space-y-6 overflow-y-auto p-6" data-testid="settings-page">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-sm text-accent hover:underline">
          {t('settings.back')}
        </Link>
        <h2 className="text-lg font-semibold text-ink-50">{t('settings.title')}</h2>
      </div>

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-850 p-4 text-sm">
        <h3 className="font-semibold text-ink-50">{t('settings.defaults')}</h3>
        {CHOICES.map(({ key, options, tip }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <Label name={key} tip={tip} />
            <select className={select} value={String(values[key])} data-testid={`setting-${key}`} onChange={(e) => write(key, e.target.value)}>
              {options.map((o) => (
                <option key={String(o)} value={String(o)}>
                  {t(`settings.${key}.${String(o)}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="flex items-center justify-between gap-3">
          <Label name="temperatura_predefinita_c" />
          <NumberField
            value={values.temperatura_predefinita_c}
            min={lo}
            max={hi}
            digits={1}
            label={t('settings.temperatura_predefinita_c')}
            testId="setting-temperatura_predefinita_c"
            onCommit={(v) => write('temperatura_predefinita_c', v)}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <Label name="passi_per_frame" tip="settings.passi_per_frame.tip" />
          <span className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={values.passi_per_frame === 'auto'}
                data-testid="setting-passi-auto"
                onChange={(e) => write('passi_per_frame', e.target.checked ? 'auto' : 40)}
              />
              {t('settings.passi_per_frame.auto')}
            </label>
            {values.passi_per_frame === 'auto' ? null : (
              <NumberField
                value={values.passi_per_frame}
                min={1}
                max={200}
                digits={0}
                label={t('settings.passi_per_frame')}
                testId="setting-passi_per_frame"
                onCommit={(v) => write('passi_per_frame', Math.round(v))}
              />
            )}
          </span>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-ink-700 bg-ink-850 p-4 text-sm">
        <h3 className="font-semibold text-ink-50">{t('settings.maps')}</h3>
        {MAPS.map(({ key, options, tip }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <Label name={key} tip={tip} />
            <span className="flex flex-wrap justify-end gap-3">
              {options.map((o) => (
                <label key={o} className="flex items-center gap-1.5">
                  <input type="radio" name={key} checked={values[key] === o} onChange={() => write(key, o)} />
                  <Swatch map={o} />
                  {o}
                </label>
              ))}
            </span>
          </div>
        ))}
      </section>
      {set.error ? <ErrorNotice error={set.error} /> : null}

      <section className="space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-4 text-sm" data-testid="settings-storage">
        <h3 className="font-semibold text-ink-50">{t('settings.storage')}</h3>
        {storage.error ? <ErrorNotice error={storage.error} /> : null}
        {storage.data ? (
          <>
            <p className="text-xs break-all text-ink-300">{storage.data.path}</p>
            <table className="w-full text-left">
              <tbody>
                {storage.data.parts.map((p) => (
                  <tr key={p.folder} className="border-t border-ink-700">
                    <td className="py-1">{t(`settings.storage.${p.folder}` as MessageKey)}</td>
                    <td className="py-1 text-right text-ink-300">{t('settings.storage.files', { count: p.files })}</td>
                    <td className="py-1 text-right font-mono">{bytes(p.bytes)}</td>
                  </tr>
                ))}
                <tr className="border-t border-ink-600 font-semibold">
                  <td className="py-1">{t('settings.storage.total')}</td>
                  <td />
                  <td className="py-1 text-right font-mono" data-testid="storage-total">
                    {bytes(storage.data.total_bytes)}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        ) : (
          <p className="text-ink-300">{t('common.loading')}</p>
        )}
      </section>
    </div>
  )
}
