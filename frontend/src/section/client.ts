// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The page's side of the slicer (SPEC §7.2 #7). Fast scrolling must not queue
// work: at most one cut and one index build are in flight, and a newer request
// replaces the pending one. Every cut carries a sequence number and the index it
// was made with; a result older than one already shown is dropped.
import type { SliceAttitude } from './frame'
import type { FromWorker, ToWorker } from './protocol'
import type { CutResult, IndexInfo } from './slicer'

export type WorkerLike = {
  postMessage(message: ToWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null
  terminate?: () => void
}

export type Loaded = Extract<FromWorker, { type: 'loaded' }>

export type CutDelivery = { seq: number; depth: number; result: CutResult }

export class SlicerClient {
  onCut: (cut: CutDelivery) => void = () => undefined
  onIndex: (info: IndexInfo, preview: boolean) => void = () => undefined
  onError: (message: string) => void = () => undefined
  onBench: (stats: Extract<FromWorker, { type: 'bench' }>['stats']) => void = () => undefined

  private seq = 0
  private shownSeq = -1
  private shownIndex = -1
  private cutBusy = false
  private pendingCut: { depth: number; cellSize: number } | null = null
  private lastCut: { depth: number; cellSize: number } | null = null
  /** Index id that the last cut sent will run on. */
  private cutIndex = -1

  private indexId = 0
  private requestedIndex = -1
  private indexBusy = false
  private pendingIndex: { attitude: SliceAttitude; preview: boolean } | null = null
  private previewOf = new Map<number, boolean>()
  private loadWaiter: ((loaded: Loaded) => void) | null = null
  private snapshots = new Map<number, (result: CutResult) => void>()
  private snapshotId = 0

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => this.receive(event.data)
  }

  load(buffer: ArrayBuffer): Promise<Loaded> {
    return new Promise((resolve) => {
      this.loadWaiter = resolve
      this.worker.postMessage({ type: 'load', buffer }, [buffer])
    })
  }

  setAttitude(attitude: SliceAttitude, preview: boolean): void {
    if (this.indexBusy) {
      this.pendingIndex = { attitude, preview }
      return
    }
    this.sendIndex(attitude, preview)
  }

  cut(depth: number, cellSize: number): void {
    this.lastCut = { depth, cellSize }
    if (this.cutBusy) {
      this.pendingCut = { depth, cellSize }
      return
    }
    this.sendCut(depth, cellSize)
  }

  /** One cut outside the live sequence (a finer one, to save), on the current index. */
  snapshot(depth: number, cellSize: number): Promise<CutResult> {
    const id = ++this.snapshotId
    return new Promise((resolve) => {
      this.snapshots.set(id, resolve)
      this.worker.postMessage({ type: 'snapshot', id, depth, cellSize })
    })
  }

  bench(attitude: SliceAttitude, cuts: number, cellSize: number): void {
    this.worker.postMessage({ type: 'bench', attitude, cuts, cellSize })
  }

  dispose(): void {
    this.worker.terminate?.()
  }

  private sendIndex(attitude: SliceAttitude, preview: boolean): void {
    const id = ++this.indexId
    this.requestedIndex = id
    this.indexBusy = true
    this.previewOf.set(id, preview)
    this.worker.postMessage({ type: 'index', id, attitude, preview })
  }

  private sendCut(depth: number, cellSize: number): void {
    this.cutBusy = true
    this.cutIndex = this.requestedIndex
    this.worker.postMessage({ type: 'cut', seq: ++this.seq, index: this.requestedIndex, depth, cellSize })
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'loaded':
        this.loadWaiter?.(message)
        this.loadWaiter = null
        return
      case 'indexed': {
        this.indexBusy = false
        const preview = this.previewOf.get(message.id) ?? false
        this.previewOf.delete(message.id)
        this.onIndex(message.info, preview)
        if (this.pendingIndex) {
          const { attitude, preview: p } = this.pendingIndex
          this.pendingIndex = null
          this.sendIndex(attitude, p)
        } else if (this.lastCut && this.cutIndex < message.id && !this.cutBusy) {
          // The section changed with the index: cut again where we are.
          this.sendCut(this.lastCut.depth, this.lastCut.cellSize)
        }
        return
      }
      case 'cut': {
        this.cutBusy = false
        if (message.seq > this.shownSeq && message.index >= this.shownIndex) {
          this.shownSeq = message.seq
          this.shownIndex = message.index
          this.onCut({ seq: message.seq, depth: message.depth, result: message.result })
        }
        const next = this.pendingCut ?? (this.lastCut && this.cutIndex < this.requestedIndex && !this.indexBusy ? this.lastCut : null)
        this.pendingCut = null
        if (next) this.sendCut(next.depth, next.cellSize)
        return
      }
      case 'snapshot':
        this.snapshots.get(message.id)?.(message.result)
        this.snapshots.delete(message.id)
        return
      case 'bench':
        this.onBench(message.stats)
        return
      case 'error':
        this.cutBusy = false
        this.indexBusy = false
        this.onError(message.message)
        return
    }
  }
}

export function createSlicer(): SlicerClient {
  const worker = new Worker(new URL('./slicer.worker.ts', import.meta.url), { type: 'module' })
  return new SlicerClient(worker as unknown as WorkerLike)
}
