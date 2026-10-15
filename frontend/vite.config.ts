// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The build writes straight into the Python package: in production there is no
// second process, the server serves these files from the port that answers
// /api. In development `npm run dev` proxies /api and /ws to a server started
// with `GDV_PORT=8853 uv run galleriadelvento --no-window`, so the two setups
// differ in who serves the HTML and in nothing else.
//
// The service worker is written by hand (src/pwa/sw.ts, `injectManifest`): what
// matters is what it must *not* do -- touch /api or /ws -- and that is easier to
// write, and to read, than to configure.
import { writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { manifest } from './src/pwa/manifest'

const apiPort = process.env.GDV_PORT ?? '8853'

// The build directory is a package directory that git keeps empty; emptying it
// on every build would delete the placeholder that keeps it in the tree.
const keepDirectory = {
  name: 'keep-static-dir',
  closeBundle() {
    writeFileSync(fileURLToPath(new URL('../backend/gdv/static/.gitkeep', import.meta.url)), '')
  },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      manifest,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
    keepDirectory,
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
  build: {
    outDir: '../backend/gdv/static',
    emptyOutDir: true,
    sourcemap: false,
  },
})
