// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Previews of the sketch wizard (SPEC §8.6): every slider and handle asks the
// server for the step on screen. At most one request is in flight; changes
// made meanwhile are merged into the next one, so a fast drag never queues
// work and superseded settings are simply never sent. A late answer older
// than the one shown is dropped.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { SketchParams, SketchPreview, SketchStage } from '../lib/types'

type Wanted = { params: SketchParams; stage: SketchStage; name: string; key: string }

export function useSketchPreview(id: string, params: SketchParams, stage: SketchStage, name: string) {
  const [preview, setPreview] = useState<SketchPreview | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const wanted = useRef<Wanted | null>(null)
  const sent = useRef<string | null>(null)
  const flying = useRef(false)
  const alive = useRef(true)

  const kick = useRef(() => {})
  kick.current = () => {
    const next = wanted.current
    if (flying.current || !next || next.key === sent.current) return
    flying.current = true
    sent.current = next.key
    setBusy(true)
    api
      .sketchPreview(id, next.params, next.stage, next.name)
      .then((result) => {
        if (!alive.current) return
        setPreview(result)
        setError(null)
      })
      .catch((err) => {
        if (alive.current) setError(err)
      })
      .finally(() => {
        flying.current = false
        if (!alive.current) return
        if (wanted.current && wanted.current.key !== sent.current) kick.current()
        else setBusy(false)
      })
  }

  const key = JSON.stringify([params, stage, name])
  useEffect(() => {
    wanted.current = { params, stage, name, key }
    kick.current()
  }, [key]) // `key` stands for the three values

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  return { preview, error, busy }
}
