// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The routes. Readable and stable, because they help in debugging -- but the
// window has no address bar, so nothing may be reachable *only* by typing one.
// An unknown path lands on the home screen: in a program where nobody types
// URLs, it can only be a stale link.
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { ImportProvider } from './components/ImportProvider'
import { LibraryPage } from './pages/Library'
import { ModelSetupPage } from './pages/ModelSetup'
import { ProfileEditorPage } from './pages/ProfileEditor'
import { SectionPage } from './pages/Section'

export function App() {
  return (
    <ImportProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/modelli/:id" element={<ModelSetupPage />} />
          <Route path="/modelli/:id/sezioni" element={<SectionPage />} />
          <Route path="/profili/nuovo" element={<ProfileEditorPage />} />
          <Route path="/profili/:id" element={<ProfileEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </ImportProvider>
  )
}
