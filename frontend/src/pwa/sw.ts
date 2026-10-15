// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The service worker caches the application shell and nothing else. Written by
// hand because what matters is what it does *not* do:
//
//   * /api and /ws are never intercepted. The state lives on the server, and a
//     stale answer would show the user a reality that is not there;
//   * only same-origin GETs of the shell go through the cache.
//
// When the server is down, a navigation gets the offline page instead of the
// browser's network error -- the one moment where answering from the cache
// tells the truth: the program is not running.
/// <reference lib="webworker" />
import offlineDocument from './offline.html?raw'

// Replaced at build time with the list of shell files. The literal spelling
// matters: workbox finds the injection point by searching for it.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

const SHELL_CACHE = 'shell-v1'
const SHELL_FILES = self.__WB_MANIFEST

function isLiveData(url: URL): boolean {
  return url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      await cache.addAll(SHELL_FILES.map((entry) => entry.url))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== SHELL_CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isLiveData(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request)
        } catch {
          return new Response(offlineDocument, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      })(),
    )
    return
  }

  // Shell assets are content-hashed: a cache hit is always the right bytes.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      return cached ?? fetch(request)
    })(),
  )
})
