// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { reportError } from './lib/api'
import './index.css'

// Everything is on loopback: a refetch costs a millisecond, and showing stale
// state costs trust. Refetch freely.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true } },
})

// Errors outside React's tree reach the server log too (SPEC §15).
window.addEventListener('error', (event) => {
  reportError(`window.onerror: ${event.message}`, `${event.filename}:${event.lineno}:${event.colno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as unknown
  reportError('unhandledrejection', reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}` : String(reason))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
