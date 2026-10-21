// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the guide holds, in order: the ids of each section's entries. The texts
// are in i18n/it.guide.ts as guide.<section>.<id>.term|formula|unit|text.
export const GUIDE_SECTIONS = {
  symbols: ['v', 'lref', 'c', 'alpha', 'rho', 'nu', 'q', 'pinf', 're', 'resim', 'ma', 'tc', 'blockage', 'dx', 'dt', 'ulat', 'tau', 'omega', 'f', 'perm'],
  coefficients: ['cd', 'cl', 'cm', 'clcd', 'cp', 'st', 'forces', 'mean', 'convergence', 'similarity'],
  charts: ['history', 'cp', 'probes', 'polar', 'speed', 'depth', 'hollow'],
  views: ['speed', 'pressure', 'vorticity', 'smoke', 'particles', 'streamlines', 'legend', 'outline', 'floor'],
  status: ['ramp', 'transient', 'provisional', 'converged', 'unstable', 'partial', 'section2d', 'repaired', 'mach'],
  tunnel3d: ['what', 'camera', 'plane', 'surface', 'smoke', 'particles', 'voxels', 'numbers', 'blockage', 'studies', 'similarity', 'rotations', 'restart'],
  shortcuts: ['general', 'tunnel', 'view', 'tools', 'model', 'tunnel3d', 'editor'],
} as const

export type GuideSection = keyof typeof GUIDE_SECTIONS

/** A place in the guide: a section, and optionally one entry of it. */
export type GuideTarget = { section: GuideSection; entry?: string }
