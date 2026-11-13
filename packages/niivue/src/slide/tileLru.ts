import type { NVSlideCachedTile, NVSlideTileSamples } from './NVSlide'

// id: a load serial, so a memo can tell entries apart without holding them.
// mask: the held channels below 32 as bits (sample tiles of a samples source).
export type TileBitmap = NVSlideCachedTile & {
  bytes: number
  id: number
  mask?: number
}
export type SampleTile = TileBitmap & { samples: NVSlideTileSamples }

export class NVSlideTileCache {
  private readonly entries = new Map<string, TileBitmap>()
  bytes = 0
  /** Bumped whenever an entry arrives or leaves: memo key of residency. */
  version = 0

  constructor(readonly maxBytes: number) {}

  get(key: string): TileBitmap | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: TileBitmap): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.bitmap?.close()
      this.bytes -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    this.version++
    this.evict()
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.bitmap?.close()
    this.bytes -= entry.bytes
    this.entries.delete(key)
    this.version++
  }

  /** Like get, without refreshing LRU order. */
  peek(key: string): TileBitmap | undefined {
    return this.entries.get(key)
  }

  *sampleEntries(): Generator<[string, SampleTile]> {
    for (const pair of this.entries)
      if (pair[1].samples) yield pair as [string, SampleTile]
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap?.close()
    this.entries.clear()
    this.bytes = 0
    this.version++
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey !== 'string') return
      const entry = this.entries.get(firstKey)
      if (!entry) return
      entry.bitmap?.close()
      this.entries.delete(firstKey)
      this.bytes -= entry.bytes
      this.version++
    }
  }
}
