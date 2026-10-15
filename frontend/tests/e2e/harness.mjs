// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browser test harness: the real program (server without a window) in a
// throw-away XDG home, driven by the *system* Chrome through playwright-core
// (SPEC §18: no browser is downloaded). Chrome gets the same offline flags as
// the application window, read from gdv.window so the list exists once.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

export const ROOT = resolve(import.meta.dirname, '../../..')

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => ok(port))
    })
    server.on('error', fail)
  })
}

export function offlineFlags() {
  const out = execFileSync(
    'uv',
    ['run', '--project', ROOT, 'python', '-c', 'import json; from gdv.window import CHROME_OFFLINE_FLAGS as f; print(json.dumps(f))'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  return JSON.parse(out)
}

export async function startApp() {
  const home = mkdtempSync(join(tmpdir(), 'gdv-e2e-'))
  const env = { ...process.env }
  for (const [name, sub] of [
    ['XDG_DATA_HOME', 'share'],
    ['XDG_STATE_HOME', 'state'],
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_CACHE_HOME', 'cache'],
    ['XDG_RUNTIME_DIR', 'run'],
  ]) {
    mkdirSync(join(home, sub), { recursive: true })
    env[name] = join(home, sub)
  }
  const port = await freePort()
  const proc = spawn('uv', ['run', '--project', ROOT, 'galleriadelvento', '--no-window', '--port', String(port)], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${port}/`
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url + 'api/health')
      if (r.ok) break
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    url,
    home,
    log: () => log,
    async stop() {
      try {
        await fetch(url + 'api/app/quit', { method: 'POST', headers: { Origin: url.slice(0, -1) } })
      } catch {
        // already gone
      }
      await new Promise((r) => {
        proc.on('exit', r)
        setTimeout(() => {
          proc.kill('SIGTERM')
          r()
        }, 5000)
      })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export async function launchChrome({ headless = true, extraArgs = [] } = {}) {
  return chromium.launch({
    channel: 'chrome',
    headless,
    args: [...offlineFlags(), '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs],
  })
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}
