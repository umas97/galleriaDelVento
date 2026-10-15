// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The slicer's thread (SPEC §7.2): it owns the full mesh, received once as a
// transferred buffer, and the index for the current rotations. Messages are
// handled in order, so a cut sent after an index request uses the new index.
import { parseMesh } from '../lib/meshBinary'
import type { Vec3 } from './frame'
import type { FromWorker, ToWorker } from './protocol'
import { PREVIEW_TRIANGLES, SliceIndex } from './slicer'

let positions: Float32Array | null = null
let indices: Uint32Array | null = null
let centre: Vec3 = [0, 0, 0]
let index: SliceIndex | null = null
let indexId = -1

const post = (message: FromWorker) => (self as unknown as Worker).postMessage(message)

function handle(message: ToWorker): void {
  switch (message.type) {
    case 'load': {
      const mesh = parseMesh(message.buffer)
      positions = mesh.positions
      indices = mesh.indices
      const [x0, y0, z0] = mesh.header.bbox_min
      const [x1, y1, z1] = mesh.header.bbox_max
      centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
      index = null
      post({
        type: 'loaded',
        triangles: mesh.header.triangles,
        bbox: { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 },
      })
      return
    }
    case 'index': {
      if (!positions || !indices) throw new Error('mesh non caricata')
      const limit = message.preview ? PREVIEW_TRIANGLES : Infinity
      index = new SliceIndex(positions, indices, centre, message.attitude, limit)
      indexId = message.id
      post({ type: 'indexed', id: message.id, info: index.info })
      return
    }
    case 'cut': {
      if (!index) throw new Error('indice non pronto')
      const result = index.cut(message.depth, message.cellSize)
      post({ type: 'cut', seq: message.seq, index: indexId, depth: message.depth, result })
      return
    }
    case 'snapshot': {
      if (!index) throw new Error('indice non pronto')
      post({ type: 'snapshot', id: message.id, result: index.cut(message.depth, message.cellSize) })
      return
    }
    case 'bench': {
      if (!positions || !indices) throw new Error('mesh non caricata')
      const built = new SliceIndex(positions, indices, centre, message.attitude)
      const { depthMin, depthMax } = built.info
      const times: number[] = []
      for (let k = 0; k < message.cuts; k++) {
        const depth = depthMin + ((k + 0.5) / message.cuts) * (depthMax - depthMin)
        const start = performance.now()
        built.cut(depth, message.cellSize)
        times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      post({
        type: 'bench',
        stats: {
          triangles: built.info.triangles,
          indexMs: built.info.ms,
          cuts: times.length,
          cutMeanMs: times.reduce((a, b) => a + b, 0) / times.length,
          cutP95Ms: times[Math.floor(times.length * 0.95)],
          cutMaxMs: times[times.length - 1],
        },
      })
      return
    }
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    handle(event.data)
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  }
}
