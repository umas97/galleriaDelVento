// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What makes the window installable: icons at 192 and 512, `display:
// standalone`, a `start_url` inside `scope`. `id` is fixed on purpose: it is
// what the browser uses to tell whether an install is *this* app.
import type { ManifestOptions } from 'vite-plugin-pwa'

export const manifest: Partial<ManifestOptions> = {
  id: '/?app=galleriadelvento',
  name: 'galleriaDelVento',
  short_name: 'galleriaDelVento',
  description: 'Galleria del vento 2D in tempo reale per sezioni, schizzi e profili',
  lang: 'it',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#111111',
  background_color: '#111111',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
}
