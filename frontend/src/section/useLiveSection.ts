// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A model's live section (SPEC §7.2) for a screen: the slicer worker with the
// full mesh, the index for the current rotations (on a sample while a rotation
// slider is held, `drag()` … `release()`), and the cut at the current depth.
// Used by the section screen and by the tunnel's «Modello 3D» panel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, requestBuffer } from '../lib/api'
import type { ModelRecord } from '../lib/types'
import { createSlicer, type CutDelivery, type SlicerClient } from './client'
import type { Plane, SliceAttitude } from './frame'
import type { BenchStats } from './protocol'
import type { CutResult, IndexInfo } from './slicer'

export type LiveSectionInput = {
  plane: Plane
  /** Depth as a fraction of the model's extent along the plane normal. */
  fraction: number
  roll: number
  tilt: number
  /** Grid cell (m): the cut is simplified to half of it. Null: no cut yet. */
  cell: number | null
}

export type LiveSection = {
  loaded: boolean
  index: { info: IndexInfo; preview: boolean } | null
  cut: CutDelivery | null
  depth: number
  workerError: string | null
  loadError: unknown
  bench: BenchStats | null
  /** A rotation slider is being dragged: index a sample of the mesh. */
  drag: () => void
  /** …and released: index the full mesh again. */
  release: () => void
  /** One cut outside the live sequence, at a finer cell (to save or export). */
  snapshot: (cell: number) => Promise<CutResult | null>
  /** One cut outside the live sequence at another depth (metres along the normal). */
  cutAt: (depth: number, cell: number) => Promise<CutResult | null>
  runBench: (cuts: number, cell: number) => void
}

export function useLiveSection(model: ModelRecord, input: LiveSectionInput): LiveSection {
  const { plane, fraction, roll, tilt, cell } = input
  const [loaded, setLoaded] = useState(false)
  const [index, setIndex] = useState<{ info: IndexInfo; preview: boolean } | null>(null)
  const [cut, setCut] = useState<CutDelivery | null>(null)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [bench, setBench] = useState<BenchStats | null>(null)
  const client = useRef<SlicerClient | null>(null)
  const dragging = useRef(false)
  const attitude = useMemo<SliceAttitude>(() => ({ plane, roll, tilt }), [plane, roll, tilt])
  const meshKey = `${model.id}:${JSON.stringify(model.placement)}:${JSON.stringify(model.repairs)}`

  // The worker and the full mesh: once per model (and per placement or repair).
  useEffect(() => {
    const slicer = createSlicer()
    client.current = slicer
    let alive = true
    slicer.onIndex = (info, preview) => alive && setIndex({ info, preview })
    slicer.onCut = (delivery) => alive && setCut(delivery)
    slicer.onError = (message) => alive && setWorkerError(message)
    slicer.onBench = (stats) => alive && setBench(stats)
    setLoaded(false)
    setIndex(null)
    setCut(null)
    requestBuffer(api.meshUrl(model.id, false))
      .then((buffer) => slicer.load(buffer))
      .then(() => alive && setLoaded(true))
      .catch((error: unknown) => alive && setLoadError(error))
    return () => {
      alive = false
      slicer.dispose()
      client.current = null
    }
  }, [meshKey, model.id])

  // A new rotation or plane: a new index (on a sample while a slider is held).
  useEffect(() => {
    if (loaded) client.current?.setAttitude(attitude, dragging.current)
  }, [loaded, attitude])

  const drag = useCallback(() => {
    dragging.current = true
  }, [])

  const release = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    client.current?.setAttitude(attitude, false)
  }, [attitude])

  const info = index?.info ?? null
  const depth = info ? info.depthMin + fraction * (info.depthMax - info.depthMin) : 0

  useEffect(() => {
    if (info && cell) client.current?.cut(depth, cell)
  }, [info, depth, cell])

  const snapshot = useCallback(
    async (fine: number) => (client.current ? client.current.snapshot(depth, fine) : null),
    [depth],
  )
  const cutAt = useCallback(
    async (at: number, fine: number) => (client.current ? client.current.snapshot(at, fine) : null),
    [],
  )
  const runBench = useCallback((cuts: number, c: number) => client.current?.bench(attitude, cuts, c), [attitude])

  return { loaded, index, cut, depth, workerError, loadError, bench, drag, release, snapshot, cutAt, runBench }
}

export type { CutResult }
