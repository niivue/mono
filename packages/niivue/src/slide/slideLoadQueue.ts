import type {
  NVSlideLevelManifest,
  NVSlideRequestClass,
  NVSlideTileManifest,
} from './NVSlide'

/** Rank of each request class: lower is served first. */
export const REQUEST_RANK: Record<NVSlideRequestClass, number> = {
  readout: 0,
  view: 1,
  plane3d: 1,
  thumbnail: 2,
  prefetch: 3,
}

/** One tile load shared by every owner that wants it. */
export interface TileLoad {
  key: string
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  /** Owners wanting it; the load is cancelled when this empties. */
  owners: Set<object>
  /** Best owner rank and its focus distance squared (Infinity: no focus). */
  rank: number
  dist: number
  /** Enqueue order: ties and fairness. */
  seq: number
  /** True when only view owners want it (fairness skips these). */
  viewOnly: boolean
  /** Set while in flight. */
  controller?: AbortController
  /** Index in the queue while queued, else -1. */
  qi: number
}

// Every FAIR_EVERY-th dequeue serves the oldest non-view load, so the view's
// backlog cannot starve thumbnails, prefetch or the 3D plane forever.
const FAIR_EVERY = 4

/**
 * Queued tile loads, dequeued by (rank, distance to focus, age), with every
 * 4th dequeue taking the oldest load a non-view owner wants.
 */
export class TileLoadQueue {
  // ponytail: linear scans; the queue is bounded by tile capacity (a few
  // hundred), so a heap only pays off past thousands of queued loads.
  readonly items: TileLoad[] = []
  private _seq = 0
  private _dequeues = 0

  get length(): number {
    return this.items.length
  }

  push(load: TileLoad): void {
    load.seq = this._seq++
    load.qi = this.items.length
    this.items.push(load)
  }

  remove(load: TileLoad): void {
    const i = load.qi
    if (i < 0) return
    const last = this.items.pop() as TileLoad
    if (last !== load) {
      this.items[i] = last
      last.qi = i
    }
    load.qi = -1
  }

  next(): TileLoad | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    let best: TileLoad | undefined
    if (++this._dequeues % FAIR_EVERY === 0)
      for (const l of items)
        if (!l.viewOnly && (!best || l.seq < best.seq)) best = l
    if (!best) {
      best = items[0] as TileLoad
      for (const l of items)
        if (
          l.rank < best.rank ||
          (l.rank === best.rank &&
            (l.dist < best.dist || (l.dist === best.dist && l.seq < best.seq)))
        )
          best = l
    }
    this.remove(best)
    return best
  }

  clear(): void {
    for (const l of this.items) l.qi = -1
    this.items.length = 0
  }
}
