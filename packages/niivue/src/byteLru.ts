/** What a {@link ByteLru} has done since it was created. */
export interface ByteLruStats {
  /** `has` calls that found a resident entry. */
  hits: number
  /** `has` calls that did not. */
  misses: number
  /** Values admitted. */
  admitted: number
  /** Values refused because one alone exceeds the whole budget. */
  rejected: number
  /** Entries dropped to stay inside the budget. */
  evicted: number
  /** Bytes dropped by those evictions. */
  evictedBytes: number
  /** Entries resident now. */
  entries: number
  /** Bytes resident now. */
  bytes: number
  /** The budget those bytes are measured against. */
  maxBytes: number
}

const byteLengthOf = (value: unknown): number =>
  (value as { byteLength?: number } | undefined)?.byteLength ?? 0

/**
 * A byte-bounded LRU over a `Map` (iteration order is recency order).
 *
 * `totalBytes <= maxBytes` holds after every operation: a value larger than
 * the whole budget is refused (and disposed), and nothing resident is evicted
 * for it. A budget of 0 holds only zero-byte values; `Infinity` never evicts.
 *
 * A value may be `undefined` (a zero-byte entry, e.g. zarrita's confirmed
 * absence), so membership is `has`, never `get() === undefined`. `has` is the
 * one call that counts a lookup, because zarrita's `withByteCaching` asks it
 * before every read and calls `get` only after a hit; `get` refreshes recency,
 * `peek` does neither. So a cache satisfies zarrita's `ByteCache` as is:
 *
 * ```ts
 * const cache = new ByteLru<string, Uint8Array | undefined>(256 * 2 ** 20)
 * const store = zarr.withByteCaching(new zarr.FetchStore(url), { cache })
 * ```
 *
 * `sizeOf` defaults to `byteLength` (0 for `undefined`). `dispose` runs on
 * every value the cache lets go of: replaced, evicted, refused, cleared or
 * dropped by `remap`.
 *
 * `keepOversize` admits a value larger than the budget as the only entry
 * instead (the slide tile cache: a refused tile would be re-fetched on every
 * request), so `totalBytes` may then exceed `maxBytes`.
 */
export class ByteLru<K, V> {
  private map = new Map<K, V>()
  private total = 0
  private budget: number
  private hits = 0
  private misses = 0
  private admitted = 0
  private rejected = 0
  private evicted = 0
  private evictedBytes = 0
  /** Bumped whenever an entry arrives or leaves: a memo key of residency. */
  version = 0

  constructor(
    maxBytes: number,
    private readonly sizeOf: (value: V) => number = byteLengthOf,
    private readonly dispose?: (value: V) => void,
    private readonly keepOversize = false,
  ) {
    this.budget = ByteLru.checked(maxBytes)
  }

  private static checked(maxBytes: number): number {
    // Rejects NaN and negatives in one comparison; 0 and Infinity are valid.
    if (!(maxBytes >= 0))
      throw new Error(
        `ByteLru: maxBytes must be a non-negative number, got ${maxBytes}`,
      )
    return maxBytes
  }

  get maxBytes(): number {
    return this.budget
  }

  /** Bytes resident now. */
  get totalBytes(): number {
    return this.total
  }

  get size(): number {
    return this.map.size
  }

  /** A snapshot of {@link ByteLruStats}. Cheap; take it every frame. */
  get stats(): ByteLruStats {
    return {
      hits: this.hits,
      misses: this.misses,
      admitted: this.admitted,
      rejected: this.rejected,
      evicted: this.evicted,
      evictedBytes: this.evictedBytes,
      entries: this.map.size,
      bytes: this.total,
      maxBytes: this.budget,
    }
  }

  /** Change the budget, evicting oldest first to fit a smaller one. */
  resize(maxBytes: number): void {
    this.budget = ByteLru.checked(maxBytes)
    this.evictToFit()
  }

  /** Whether `key` is resident. Counts a hit or a miss; recency unchanged. */
  has(key: K): boolean {
    const hit = this.map.has(key)
    if (hit) this.hits++
    else this.misses++
    return hit
  }

  /** The value for `key`, marked most recently used. Not counted. */
  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined && !this.map.has(key)) return undefined
    this.map.delete(key)
    this.map.set(key, value as V)
    return value
  }

  /** The value for `key`, without counting or touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  /** Hold `value` under `key`; it is handed back verbatim, so do not mutate it. */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      const old = this.map.get(key) as V
      this.map.delete(key)
      this.total -= this.sizeOf(old)
      this.dispose?.(old)
    }
    this.version++
    const bytes = this.sizeOf(value)
    if (bytes > this.budget && !this.keepOversize) {
      // Holding it would evict everything and still not fit.
      this.rejected++
      this.dispose?.(value)
      return
    }
    this.map.set(key, value)
    this.total += bytes
    this.admitted++
    this.evictToFit()
  }

  /**
   * Re-key through `oldToNew`, keeping recency order and dropping entries it
   * does not map. Counters are untouched.
   */
  remap(oldToNew: ReadonlyMap<K, K>): void {
    const next = new Map<K, V>()
    let total = 0
    for (const [key, value] of this.map) {
      const mapped = oldToNew.get(key)
      if (mapped === undefined) {
        this.dispose?.(value)
        continue
      }
      // Two keys mapped to one: the later (more recent) wins, the other is dropped.
      const displaced = next.get(mapped)
      if (displaced !== undefined) {
        next.delete(mapped)
        total -= this.sizeOf(displaced)
        this.dispose?.(displaced)
      }
      next.set(mapped, value)
      total += this.sizeOf(value)
    }
    this.map = next
    this.total = total
    this.version++
  }

  /** Drop every entry, keeping the counters. */
  clear(): void {
    if (this.dispose) for (const value of this.map.values()) this.dispose(value)
    this.map.clear()
    this.total = 0
    this.version++
  }

  // Every resident entry fits the budget alone (unless keepOversize, which
  // stops at one), so this ends within budget.
  private evictToFit(): void {
    for (const [key, value] of this.map) {
      if (
        this.total <= this.budget ||
        (this.keepOversize && this.map.size === 1)
      )
        return
      const bytes = this.sizeOf(value)
      this.map.delete(key)
      this.total -= bytes
      this.evicted++
      this.evictedBytes += bytes
      this.version++
      this.dispose?.(value)
    }
  }
}
