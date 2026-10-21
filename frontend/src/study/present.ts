// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// How a saved result reads (SPEC §2.3): its conditions as label/value rows,
// the warnings that go with its numbers, the value of a series point. Shared
// by the study page, the comparison and the report.
import { metres, num } from '../lib/format'
import { is3d, type EditorSource, type ProfileSource, type Section3DSource, type SeriesParameter, type SimulationResult, type SimulationResult3D, type Study, type StudyPoint } from '../lib/types'
import { t, type MessageKey } from '../i18n/it'

export function sectionOf(source: ProfileSource): Section3DSource | null {
  const s = source.kind === 'editor' ? (source as EditorSource).origin : source
  return s && s.kind === 'section3d' ? s : null
}

export function sectionText(result: SimulationResult): string | null {
  const s = sectionOf(result.case.profile.source)
  if (!s) return null
  return t('tunnel.snapshot.section', {
    plane: t(s.plane === 'vertical' ? 'section.plane.name.vertical' : 'section.plane.name.horizontal'),
    depth: metres(s.depth_m),
    percent: num(s.depth_fraction * 100, 1),
    roll: num(s.roll_deg, 1),
    tilt: num(s.tilt_deg, 1),
  })
}

export function conditionRows(result: SimulationResult, steps: number): [string, string][] {
  const { case: c, plan: p } = result
  const rows: [string, string][] = [
    [t('study.cond.profile'), c.profile.name],
    [t('study.cond.fluid'), t('study.cond.fluidValue', { fluid: t(`tunnel.fluid.${c.fluid}` as MessageKey), temperature: num(c.temperature_c, 1) })],
    [t('study.cond.speed'), `${num(c.speed, 2)} m/s`],
    [t('study.cond.angle'), `${num(c.angle_deg, 1)}°`],
    [t('study.cond.ground'), `${t(`studyType.ground.${c.ground}` as MessageKey)} · ${t(`studyType.inlet.${c.inlet_profile}` as MessageKey)}`],
    [t('study.cond.reynolds'), p.texts.reynolds],
    [t('study.cond.mach'), p.texts.mach],
    [t('study.cond.reference'), `${t(`studyType.reference.${p.reference_kind === 'custom' ? 'chord' : p.reference_kind}` as MessageKey)} ${metres(p.reference_length)}`],
    [t('study.cond.grid'), `${p.texts.grid} · τ ${num(p.tau, 4)}`],
    [t('study.cond.chamber'), t('tunnel.chamber.size', { w: metres(p.width_m), h: metres(p.height_m) })],
    [t('study.cond.steps'), t('study.cond.stepsValue', { steps: num(steps, 0), time: num(steps * p.dt, 3) })],
  ]
  const section = sectionText(result)
  if (section) rows.splice(1, 0, [t('study.cond.section'), section])
  return rows
}

export type Warning = { key: string; text: string; tone: 'warn' | 'info' | 'danger' }

export function warningsOf(result: SimulationResult): Warning[] {
  const out: Warning[] = []
  if (result.status === 'unstable') out.push({ key: 'unstable', text: t('study.warn.unstable'), tone: 'danger' })
  if (result.status === 'provisional') out.push({ key: 'provisional', text: t('study.warn.provisional'), tone: 'warn' })
  if (result.plan.partial_similarity) out.push({ key: 'partial', text: t('tunnel.badge.partial.tip'), tone: 'warn' })
  if (sectionOf(result.case.profile.source)) out.push({ key: 'section', text: t('section.badge2d.tip'), tone: 'info' })
  if (result.plan.mach_warning) out.push({ key: 'mach', text: t('tunnel.warn.mach'), tone: 'warn' })
  return out
}

/** A length with a sensible unit for a cell (mm under a centimetre). */
export function cellText(dx: number): string {
  return dx < 0.01 ? `${num(dx * 1000, 1)} mm` : metres(dx)
}

/** The conditions of a 3D result (SPEC §2.3, §24.6). */
export function conditionRows3d(result: SimulationResult3D, steps: number): [string, string][] {
  const { case: c, plan: p } = result
  return [
    [t('study.cond.model'), c.name],
    [t('study.cond.rotations'), t('study.cond.rotationsValue', { yaw: num(c.yaw_deg, 1), pitch: num(c.pitch_deg, 1) })],
    [t('study.cond.fluid'), t('study.cond.fluidValue', { fluid: t(`tunnel.fluid.${c.fluid}` as MessageKey), temperature: num(c.temperature_c, 1) })],
    [t('study.cond.speed'), `${num(c.speed, 2)} m/s`],
    [t('study.cond.ground'), `${t(`studyType.ground.${c.ground}` as MessageKey)} · ${t(`studyType.inlet.${c.inlet_profile}` as MessageKey)}`],
    [t('study.cond.reynolds'), p.texts.reynolds],
    [t('study.cond.mach'), p.texts.mach],
    [t('study.cond.reference'), `${t(`studyType.reference.${p.reference_kind === 'custom' ? 'length_x' : p.reference_kind}` as MessageKey)} ${metres(p.reference_length)}`],
    [t('study.cond.area'), `${num(p.reference_area, 4)} m²`],
    [t('study.cond.blockage'), t('study.cond.blockageValue', { blockage: num(p.blockage * 100, 1), factor: num(p.blockage_correction, 3) })],
    [t('study.cond.grid'), `${p.texts.grid} · τ ${num(p.tau, 4)}`],
    [t('study.cond.chamber'), t('tunnel3d.chamber', { l: metres(p.length_m), w: metres(p.width_m), h: metres(p.height_m) })],
    [t('study.cond.steps'), t('study.cond.stepsValue', { steps: num(steps, 0), time: num(steps * p.dt, 3) })],
  ]
}

export function warningsOf3d(result: SimulationResult3D): Warning[] {
  const out: Warning[] = []
  if (result.status === 'unstable') out.push({ key: 'unstable', text: t('study.warn.unstable'), tone: 'danger' })
  if (result.status === 'provisional') out.push({ key: 'provisional', text: t('study.warn.provisional'), tone: 'warn' })
  if (result.plan.partial_similarity)
    out.push({ key: 'partial', text: t('tunnel3d.badge.partial.tip', { sim: num(result.plan.re_sim, 0), real: num(result.plan.re_real, 0) }), tone: 'warn' })
  out.push({ key: 'coarse', text: t('tunnel3d.badge.coarse.tip', { cell: cellText(result.plan.dx) }), tone: 'info' })
  out.push({ key: 'blockage', text: t('study.warn.blockage', { blockage: num(result.plan.blockage * 100, 1), factor: num(result.plan.blockage_correction, 3) }), tone: 'info' })
  if (result.plan.mach_warning) out.push({ key: 'mach', text: t('tunnel.warn.mach'), tone: 'warn' })
  return out
}

export function parameterLabel(parameter: SeriesParameter): string {
  return t(`series.axis.${parameter}` as MessageKey)
}

/** The x of a series point: incidence (°), real Re (speed series), depth (%). */
export function seriesX(parameter: SeriesParameter, point: StudyPoint): number {
  if (parameter === 'speed') return point.result.plan.re_real
  if (parameter === 'depth') return 100 * (point.value ?? 0)
  const r = point.result
  return point.value ?? (is3d(r) ? 0 : r.case.angle_deg)
}

export function studyStatus(study: Study): SimulationResult['status'] | null {
  if (!study.points.length) return null
  if (study.kind === 'single') return study.points[0].result.status
  return study.points.every((p) => p.result.status === 'converged') ? 'converged' : 'provisional'
}
