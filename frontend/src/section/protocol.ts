// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Messages between the page and the slicer worker.
import type { Box } from '../profile/geometry'
import type { SliceAttitude } from './frame'
import type { CutResult, IndexInfo } from './slicer'

export type BenchStats = {
  triangles: number
  indexMs: number
  cuts: number
  cutMeanMs: number
  cutP95Ms: number
  cutMaxMs: number
}

export type ToWorker =
  | { type: 'load'; buffer: ArrayBuffer }
  | { type: 'index'; id: number; attitude: SliceAttitude; preview: boolean }
  | { type: 'cut'; seq: number; index: number; depth: number; cellSize: number }
  | { type: 'bench'; attitude: SliceAttitude; cuts: number; cellSize: number }
  | { type: 'snapshot'; id: number; depth: number; cellSize: number }

export type FromWorker =
  | { type: 'loaded'; triangles: number; bbox: Box & { minZ: number; maxZ: number } }
  | { type: 'indexed'; id: number; info: IndexInfo }
  | { type: 'cut'; seq: number; index: number; depth: number; result: CutResult }
  | { type: 'bench'; stats: BenchStats }
  | { type: 'snapshot'; id: number; result: CutResult }
  | { type: 'error'; message: string }
