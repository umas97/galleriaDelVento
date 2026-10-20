// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 3D tunnel's geometry thread (SPEC §24.3): it owns the full mesh
// (mesh.bin, received once as a transferred buffer) and answers, for the
// case's rotations, what the planner sizes the chamber on -- the turned body's
// box about the pivot and its frontal area -- and then the voxels on the
// plan's grid. The turned body of the last rotations is kept: the voxels of a
// plan come right after its body.
import { parseMesh } from '../lib/meshBinary'
import { boxOf, frontalArea, turnBody, voxelFrontalArea, voxelize, type Vec3 } from './voxelize'
import type { FromVoxelWorker, ToVoxelWorker } from './voxelProtocol'

let positions: Float32Array | null = null
let indices: Uint32Array | null = null
let pivot: Vec3 = [0, 0, 0]
let turned: { yaw: number; pitch: number; body: Float64Array } | null = null

const post = (message: FromVoxelWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

function bodyAt(yaw: number, pitch: number): Float64Array {
  if (!positions) throw new Error('mesh non caricata')
  if (!turned || turned.yaw !== yaw || turned.pitch !== pitch) turned = { yaw, pitch, body: turnBody(positions, pivot, yaw, pitch) }
  return turned.body
}

function handle(message: ToVoxelWorker): void {
  switch (message.type) {
    case 'load': {
      const mesh = parseMesh(message.buffer)
      positions = mesh.positions
      indices = mesh.indices
      turned = null
      const [x0, y0, z0] = mesh.header.bbox_min
      const [x1, y1, z1] = mesh.header.bbox_max
      pivot = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
      post({ type: 'loaded', id: message.id, pivot, size: [x1 - x0, y1 - y0, z1 - z0], triangles: mesh.header.triangles })
      return
    }
    case 'body': {
      const body = bodyAt(message.yaw, message.pitch)
      post({ type: 'body', id: message.id, box: boxOf(body), area: frontalArea(body, indices!) })
      return
    }
    case 'voxels': {
      const body = bodyAt(message.yaw, message.pitch)
      const g = message.grid
      const voxels = voxelize(body, indices!, g, message.closed)
      post({ type: 'voxels', id: message.id, voxels, frontalCells: voxelFrontalArea(voxels, g.nx, g.ny, g.nz) }, [voxels.buffer])
      return
    }
  }
}

self.onmessage = (event: MessageEvent<ToVoxelWorker>) => {
  try {
    handle(event.data)
  } catch (error) {
    post({ type: 'error', id: event.data.id, message: error instanceof Error ? error.message : String(error) })
  }
}
