// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The streamline thread (SPEC §10.6 #6): a field in, polylines out. A field
// arriving while one is traced simply waits its turn; the page sends at most
// one every half second.
import { streamlines, type Field } from './streamlines'

type Request = { id: number; field: Field; seeds: [number, number][] }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, field, seeds } = event.data
  const lines = streamlines(field, seeds).map((l) => Float32Array.from(l))
  ;(self as unknown as Worker).postMessage({ id, lines }, lines.map((l) => l.buffer))
}
