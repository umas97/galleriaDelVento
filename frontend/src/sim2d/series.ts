// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// From the coefficient samples to the numbers shown (SPEC §9.5): averages,
// standard deviations, convergence and the Strouhal number. Times are counted
// in steps; T_c (the convective time L_ref / V) comes from the plan.
//
// Averaging starts after the transient (end of the ramp + 3 T_c) and again
// 1 T_c after every change of section, incidence or position: the change sends
// a disturbance through the flow, and averaging it in would only slow
// convergence. A case is converged when the mean Cd changes by less than 0.5%
// between two consecutive windows of 1 T_c (steady flow) or between two groups
// of 5 shedding periods (periodic flow, recognised by a Cl that oscillates
// visibly, with a spectral peak 10 times above its noise). Until then the
// numbers are provisional.

export type CoefSample = { step: number; cd: number; cl: number; cm: number }

export type Stat = { mean: number; std: number }

export type SeriesStats = {
  status: 'transient' | 'provisional' | 'converged'
  regime: 'steady' | 'periodic' | null
  cd: Stat | null
  cl: Stat | null
  cm: Stat | null
  clcd: number | null
  strouhal: number | null
  /** Relative change of the mean Cd between the last two windows or groups. */
  change: number | null
  /** Steps since averaging started (negative while waiting). */
  averagedSteps: number
}

export type SeriesOptions = {
  tcSteps: number
  transientSteps: number
  /** Reference length in cells and lattice velocity, for the Strouhal number. */
  lLat: number
  uLat: number
}

export const CONVERGED_CHANGE = 0.005
export const PEAK_OVER_NOISE = 10
/** Below this standard deviation of Cl the flow is steady whatever its spectrum says. */
export const MIN_OSCILLATION = 1e-3
/**
 * Strouhal numbers of vortex shedding: the peak is looked for in this band
 * (bluff bodies 0.1-0.3, plates and stalled wings down to about 0.1 on the
 * frontal height). Outside it, peaks are acoustic waves of the start-up.
 */
export const STROUHAL_BAND: [number, number] = [0.05, 1.0]
/** The chart keeps this many steps (SPEC §10.7). */
export const CHART_STEPS = 20_000

function stat(values: number[]): Stat {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { mean, std: Math.sqrt(variance) }
}

/** Magnitudes of the FFT of a real signal (length padded to a power of two). */
export function spectrum(signal: readonly number[]): Float64Array {
  let n = 1
  while (n < signal.length) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length
  // Hann window: a peak between two bins leaks less.
  signal.forEach((v, i) => {
    re[i] = (v - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, signal.length - 1)))
  })
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const ar = re[i + k + len / 2]
        const ai = im[i + k + len / 2]
        const tr = ar * wr - ai * wi
        const ti = ar * wi + ai * wr
        re[i + k + len / 2] = re[i + k] - tr
        im[i + k + len / 2] = im[i + k] - ti
        re[i + k] += tr
        im[i + k] += ti
      }
  }
  const out = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k], im[k])
  return out
}

/**
 * The dominant frequency (cycles per step) of evenly spaced samples, if it
 * stands out; optionally only within [lo, hi] cycles per step.
 */
export function dominantFrequency(
  values: readonly number[],
  every: number,
  band: [number, number] = [0, Infinity],
): { frequency: number; ratio: number } | null {
  if (values.length < 16) return null
  const s = spectrum(values)
  let n = 1
  while (n < values.length) n *= 2
  let best = -1
  for (let k = 1; k < s.length; k++) {
    const f = k / (n * every)
    if (f < band[0] || f > band[1]) continue
    if (best < 0 || s[k] > s[best]) best = k
  }
  if (best < 0) return null
  const sorted = Array.from(s.subarray(1)).sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length / 2)] || 1e-30
  return { frequency: best / (n * every), ratio: s[best] / noise }
}

/** Samples resampled every `every` steps by linear interpolation (gaps are possible). */
function even(samples: readonly CoefSample[], every: number, key: 'cd' | 'cl'): number[] {
  const out: number[] = []
  if (samples.length < 2) return out
  let j = 0
  for (let t = samples[0].step; t <= samples[samples.length - 1].step; t += every) {
    while (samples[j + 1].step < t) j++
    const a = samples[j]
    const b = samples[j + 1]
    const w = b.step === a.step ? 0 : (t - a.step) / (b.step - a.step)
    out.push(a[key] + w * (b[key] - a[key]))
  }
  return out
}

export class CoefficientSeries {
  private samples: CoefSample[] = []
  private averageFrom: number

  constructor(private options: SeriesOptions) {
    this.averageFrom = options.transientSteps
  }

  /** New normalisation or timing (a new plan that kept the flow): averages restart. */
  setOptions(options: SeriesOptions, step: number): void {
    this.options = options
    this.resetAverages(step)
  }

  add(sample: CoefSample): void {
    this.samples.push(sample)
    const keep = Math.max(CHART_STEPS, 60 * this.options.tcSteps)
    const first = sample.step - keep
    let drop = 0
    while (drop < this.samples.length && this.samples[drop].step < first) drop++
    if (drop > 256) this.samples.splice(0, drop)
  }

  /** A change of section, incidence or position: averages restart 1 T_c later. */
  resetAverages(step: number): void {
    this.averageFrom = Math.max(this.options.transientSteps, Math.ceil(step + this.options.tcSteps))
  }

  /** Everything again from step 0 (a new flow). */
  clear(): void {
    this.samples = []
    this.averageFrom = this.options.transientSteps
  }

  /** First step of the averaging window. */
  get averagingFrom(): number {
    return this.averageFrom
  }

  /** Every sample kept (the history a study saves). */
  all(): CoefSample[] {
    return this.samples.slice()
  }

  /** The samples of the last CHART_STEPS steps, for the chart. */
  chart(): CoefSample[] {
    const last = this.samples.length ? this.samples[this.samples.length - 1].step : 0
    return this.samples.filter((s) => s.step >= last - CHART_STEPS)
  }

  stats(): SeriesStats {
    const last = this.samples.length ? this.samples[this.samples.length - 1].step : 0
    const used = this.samples.filter((s) => s.step >= this.averageFrom)
    const empty: SeriesStats = {
      status: 'transient',
      regime: null,
      cd: null,
      cl: null,
      cm: null,
      clcd: null,
      strouhal: null,
      change: null,
      averagedSteps: last - this.averageFrom,
    }
    if (used.length < 4) return empty
    const cd = stat(used.map((s) => s.cd))
    const cl = stat(used.map((s) => s.cl))
    const cm = stat(used.map((s) => s.cm))
    const every = Math.max(1, Math.round((used[used.length - 1].step - used[0].step) / (used.length - 1)))
    const tc = this.options.tcSteps
    const span = used[used.length - 1].step - used[0].step

    let regime: SeriesStats['regime'] = null
    let strouhal: number | null = null
    let change: number | null = null
    const oscillates = cl.std > MIN_OSCILLATION
    const toSteps = this.options.uLat / this.options.lLat
    const band: [number, number] = [STROUHAL_BAND[0] * toSteps, STROUHAL_BAND[1] * toSteps]
    const peak = oscillates && span >= 2 * tc ? dominantFrequency(even(used, every, 'cl'), every, band) : null
    if (peak && peak.ratio > PEAK_OVER_NOISE && peak.frequency > 0) {
      regime = 'periodic'
      strouhal = (peak.frequency * this.options.lLat) / this.options.uLat
      const group = 5 / peak.frequency
      if (span >= 2 * group) {
        const end = used[used.length - 1].step
        const meanOf = (from: number, to: number) => stat(used.filter((s) => s.step >= from && s.step < to).map((s) => s.cd)).mean
        const a = meanOf(end - 2 * group, end - group)
        const b = meanOf(end - group, end + 1)
        change = Math.abs(b - a) / Math.max(Math.abs(b), 1e-12)
      }
    } else if (span >= 2 * tc) {
      regime = 'steady'
      const windows = Math.floor(span / tc)
      const meanOf = (k: number) => {
        const from = used[0].step + k * tc
        return stat(used.filter((s) => s.step >= from && s.step < from + tc).map((s) => s.cd)).mean
      }
      const a = meanOf(windows - 2)
      const b = meanOf(windows - 1)
      change = Math.abs(b - a) / Math.max(Math.abs(b), 1e-12)
    }
    return {
      status: change !== null && change < CONVERGED_CHANGE ? 'converged' : 'provisional',
      regime,
      cd,
      cl,
      cm,
      clcd: Math.abs(cd.mean) > 1e-12 ? cl.mean / cd.mean : null,
      strouhal,
      change,
      averagedSteps: last - this.averageFrom,
    }
  }
}
