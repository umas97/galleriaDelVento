// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Messages between the 3D tunnel and its geometry thread (voxel.worker.ts),
// and the page's side: one promise per request, answered in order.
import type { Box3, Grid3, Vec3, WallLinks } from './voxelize'

export type ToVoxelWorker =
  | { type: 'load'; id: number; buffer: ArrayBuffer }
  | { type: 'body'; id: number; yaw: number; pitch: number }
  | { type: 'voxels'; id: number; yaw: number; pitch: number; grid: Grid3; closed: boolean }

export type FromVoxelWorker =
  | { type: 'loaded'; id: number; pivot: Vec3; size: Vec3; triangles: number }
  | { type: 'body'; id: number; box: Box3; area: number }
  | { type: 'voxels'; id: number; voxels: Uint8Array<ArrayBuffer>; walls: WallLinks; frontalCells: number }
  | { type: 'error'; id: number; message: string }

export type WorkerLike = {
  postMessage(message: ToVoxelWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<FromVoxelWorker>) => void) | null
  terminate?: () => void
}

type Answer<T extends FromVoxelWorker['type']> = Extract<FromVoxelWorker, { type: T }>

export class VoxelClient {
  private next = 0
  private waiting = new Map<number, { resolve: (m: FromVoxelWorker) => void; reject: (e: Error) => void }>()

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => {
      const m = event.data
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.type === 'error') w.reject(new Error(m.message))
      else w.resolve(m)
    }
  }

  private ask<T extends FromVoxelWorker['type']>(message: ToVoxelWorker, transfer: Transferable[] = []): Promise<Answer<T>> {
    return new Promise((resolve, reject) => {
      this.waiting.set(message.id, { resolve: resolve as (m: FromVoxelWorker) => void, reject })
      this.worker.postMessage(message, transfer)
    })
  }

  /** Hand over the full mesh (the buffer is transferred). */
  load(buffer: ArrayBuffer): Promise<Answer<'loaded'>> {
    return this.ask({ type: 'load', id: this.next++, buffer }, [buffer])
  }

  /** The body turned by the case's rotations: its box about the pivot (m) and frontal area (m²). */
  body(yaw: number, pitch: number): Promise<Answer<'body'>> {
    return this.ask({ type: 'body', id: this.next++, yaw, pitch })
  }

  voxels(yaw: number, pitch: number, grid: Grid3, closed: boolean): Promise<Answer<'voxels'>> {
    return this.ask({ type: 'voxels', id: this.next++, yaw, pitch, grid, closed })
  }

  dispose(): void {
    this.worker.terminate?.()
    for (const w of this.waiting.values()) w.reject(new Error('geometria chiusa'))
    this.waiting.clear()
  }
}
