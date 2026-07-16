// Byte-budgeted LRU registry for per-tile GPU textures.
//
// NVSlide's ImageBitmap cache is LRU-bounded, but the slide renderers used to
// keep one GPU texture per tile key forever (until destroy) — so a deep-zoom
// pan across a gigapixel slide ratcheted GPU memory up monotonically until the
// browser's GPU process died (observed as a Chrome GpuWatchdog kill that took
// macOS WindowServer down with it during IOSurface teardown). Every renderer
// now registers its tile textures here and evicts back to a byte budget once
// per frame.
//
// Eviction discipline: entries touched since the last `beginFrame()` are never
// evicted, and callers run `evictToBudget()` BEFORE `beginFrame()` — so the
// previous frame's working set is exempt and a texture referenced by an
// in-flight (not yet submitted) WebGPU command encoder can never be destroyed
// under it.

/** Default per-renderer budget for resident tile textures (RGBA bytes). */
export const DEFAULT_TILE_TEXTURE_BYTES = 128 * 1024 * 1024

interface TileTextureEntry<T> {
  value: T
  bytes: number
  frame: number
}

export class TileTextureCache<T> {
  private readonly _entries = new Map<string, TileTextureEntry<T>>()
  private _frame = 0
  bytes = 0

  constructor(
    private readonly _maxBytes: number,
    private readonly _destroyEntry: (value: T) => void,
  ) {}

  get size(): number {
    return this._entries.size
  }

  /** Start a new draw pass; entries touched from here on are eviction-exempt. */
  beginFrame(): void {
    this._frame++
  }

  /** Look up a texture, marking it used this frame (refreshes LRU order). */
  get(key: string): T | undefined {
    const entry = this._entries.get(key)
    if (!entry) return undefined
    this._entries.delete(key)
    entry.frame = this._frame
    this._entries.set(key, entry)
    return entry.value
  }

  /** Register a texture (destroying any previous entry under the same key). */
  set(key: string, value: T, bytes: number): void {
    this.delete(key)
    this._entries.set(key, { value, bytes, frame: this._frame })
    this.bytes += bytes
  }

  /** Destroy and remove one entry (no-op when absent). */
  delete(key: string): void {
    const entry = this._entries.get(key)
    if (!entry) return
    this._destroyEntry(entry.value)
    this._entries.delete(key)
    this.bytes -= entry.bytes
  }

  /**
   * Destroy least-recently-used entries until within budget. Entries touched
   * in the current frame are never evicted, so call this BEFORE `beginFrame()`
   * (protecting the just-drawn working set) rather than after.
   */
  evictToBudget(): void {
    if (this.bytes <= this._maxBytes) return
    for (const [key, entry] of this._entries) {
      if (this.bytes <= this._maxBytes) return
      if (entry.frame === this._frame) continue
      this._destroyEntry(entry.value)
      this._entries.delete(key)
      this.bytes -= entry.bytes
    }
  }

  /** Destroy every entry. */
  clear(): void {
    for (const entry of this._entries.values()) {
      this._destroyEntry(entry.value)
    }
    this._entries.clear()
    this.bytes = 0
  }
}
