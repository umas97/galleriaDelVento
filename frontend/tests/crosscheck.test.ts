// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The TypeScript half of the cross-language tests. pytest writes the cases to
// GDV_CROSS_IN, runs this file, and checks what it writes to GDV_CROSS_OUT
// against the Python implementation (tests/crosscheck.py). Run alone, without
// those variables, it is skipped.
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Pt } from '../src/profile/geometry'
import { repairLoops } from '../src/profile/repair'
import { validateLoops } from '../src/profile/validate'

const input = process.env.GDV_CROSS_IN
const output = process.env.GDV_CROSS_OUT

type ProfileCase = { name: string; loops: Pt[][]; min_area: number }

const tasks: Record<string, (payload: unknown) => unknown> = {
  profiles: (payload) =>
    (payload as ProfileCase[]).map((c) => {
      const report = validateLoops(c.loops)
      const repaired = report.valid ? null : repairLoops(c.loops, c.min_area).loops
      return { name: c.name, report, repaired }
    }),
}

describe.skipIf(!input || !output)('cross-check with the backend', () => {
  it('computes the TypeScript side', () => {
    const { task, payload } = JSON.parse(readFileSync(input!, 'utf8')) as { task: string; payload: unknown }
    expect(tasks[task]).toBeDefined()
    writeFileSync(output!, JSON.stringify(tasks[task](payload)))
  })
})
