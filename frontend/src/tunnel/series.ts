// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A series (SPEC §11.3): the same case at several values of one parameter --
// incidence, speed, or the depth of a model's section -- run one after the
// other on the GPU. Each point starts from rest with the start-up ramp and
// runs until it converges or reaches its ceiling, the plan's ramp + 20 T_c;
// an unstable point is kept as such and the series goes on. Each finished
// point is saved at once, so stopping (or a crash) keeps the points done.
//
// The runner only sequences; the tunnel (the host) knows how to set a value,
// what the current case is, and how to save a point.
import type { ResultStatus, SeriesParameter } from '../lib/types'
import type { TunnelEngine } from '../sim2d/engine'

export type SeriesProgress = {
  /** Index of the point running (0-based), or the number of points at the end. */
  index: number
  total: number
  value: number | null
  /** Steps of the current point and its ceiling. */
  step: number
  cap: number
  /** Seconds each finished point took. */
  durations: number[]
  statuses: (ResultStatus | 'skipped')[]
  state: 'running' | 'stopping' | 'done' | 'stopped' | 'error'
  error: unknown
}

export type SeriesHost = {
  engine: () => TunnelEngine | null
  /** Set the parameter to `value` and have the plan and body ready; false: skip the point. */
  apply: (parameter: SeriesParameter, value: number) => Promise<boolean>
  /** The ceiling of the current point, in steps from rest. */
  cap: () => number
  /** Save the finished point; resolves with its status. */
  save: (value: number, first: boolean, elapsedSeconds: number) => Promise<ResultStatus>
}

const POLL_MS = 200

/** The values of a series from its range (inclusive, a step that may not divide it). */
export function rangeValues(from: number, to: number, step: number, limit = 200): number[] {
  if (!(step > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return []
  const direction = to >= from ? 1 : -1
  const out: number[] = []
  for (let k = 0; out.length < limit; k++) {
    const v = from + direction * k * step
    if (direction * (v - to) > 1e-9) break
    out.push(Math.round(v * 1e6) / 1e6)
  }
  return out
}

/** `count` values evenly from `from` to `to` (depth series). */
export function evenValues(from: number, to: number, count: number): number[] {
  const n = Math.max(1, Math.min(200, Math.round(count)))
  if (n === 1) return [from]
  return Array.from({ length: n }, (_, k) => Math.round((from + ((to - from) * k) / (n - 1)) * 1e6) / 1e6)
}

/** Seconds left: the mean of the points done times the points to go (null before the first). */
export function remainingSeconds(progress: SeriesProgress): number | null {
  if (!progress.durations.length) return null
  const mean = progress.durations.reduce((a, b) => a + b, 0) / progress.durations.length
  return mean * Math.max(0, progress.total - progress.index)
}

export class SeriesRunner {
  private stopping = false
  progress: SeriesProgress

  constructor(
    private readonly host: SeriesHost,
    readonly parameter: SeriesParameter,
    readonly values: number[],
    private readonly onProgress: (p: SeriesProgress) => void,
  ) {
    this.progress = { index: 0, total: values.length, value: values[0] ?? null, step: 0, cap: 0, durations: [], statuses: [], state: 'running', error: null }
  }

  stop(): void {
    if (this.progress.state !== 'running') return
    this.stopping = true
    this.update({ state: 'stopping' })
  }

  private update(change: Partial<SeriesProgress>): void {
    this.progress = { ...this.progress, ...change }
    this.onProgress(this.progress)
  }

  /** Run every point; resolves with how the series ended. */
  async run(): Promise<'done' | 'stopped' | 'error'> {
    let saved = 0
    try {
      for (let k = 0; k < this.values.length; k++) {
        if (this.stopping) break
        const value = this.values[k]
        this.update({ index: k, value, step: 0 })
        const started = performance.now()
        if (!(await this.host.apply(this.parameter, value))) {
          this.update({ statuses: [...this.progress.statuses, 'skipped'] })
          continue
        }
        const engine = this.host.engine()
        if (!engine) throw new Error('engine gone')
        engine.restart()
        engine.play()
        const cap = this.host.cap()
        this.update({ cap })
        while (!this.stopping) {
          await new Promise((r) => setTimeout(r, POLL_MS))
          const e = this.host.engine()
          if (!e) throw new Error('engine gone')
          const snap = e.snapshot()
          this.update({ step: snap.step })
          if (snap.unstable || snap.stats.status === 'converged' || snap.step >= cap) break
          if (!e.isRunning && !snap.unstable) e.play()
        }
        if (this.stopping) break
        const status = await this.host.save(value, saved === 0, (performance.now() - started) / 1000)
        saved++
        this.update({ durations: [...this.progress.durations, (performance.now() - started) / 1000], statuses: [...this.progress.statuses, status] })
      }
    } catch (error) {
      this.update({ state: 'error', error })
      return 'error'
    }
    const end = this.stopping ? 'stopped' : 'done'
    this.update({ state: end, index: this.values.length })
    return end
  }
}
