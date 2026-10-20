// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The persistent settings (SPEC §14.3), read once and shared through TanStack
// Query. Until the first answer arrives -- or if the server cannot give one --
// screens use the defaults: a setting never blocks a screen from opening.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { AppSettings, SettingsEnvelope } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  unita_velocita: 'm/s',
  fluido_predefinito: 'aria',
  temperatura_predefinita_c: 20,
  risoluzione: 'normale',
  mappa_sequenziale: 'viridis',
  mappa_divergente: 'coolwarm',
  csv_separatore: ';',
  passi_per_frame: 'auto',
  riferimento_in_profondita: 'fissa',
}

const KEY = ['settings']

export function useSettings(): { values: AppSettings; loaded: boolean } {
  const query = useQuery({ queryKey: KEY, queryFn: api.settings, staleTime: Infinity })
  return { values: query.data?.values ?? DEFAULT_SETTINGS, loaded: query.isSuccess || query.isError }
}

/** Write one key; the shared copy updates with the server's answer. */
export function useSetSetting() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: keyof AppSettings; value: unknown }) => api.setSetting(key, value),
    onSuccess: (envelope: SettingsEnvelope) => client.setQueryData(KEY, envelope),
  })
}
