/**
 * Stream an OME-Zarr pyramid as a {@link ChunkedVolumeSource}.
 *
 * This is the whole-store streaming path: `nv.loadChunkedVolume` plans a
 * multi-LOD brick set, and this adapter reads each brick's voxel region from
 * one pyramid level with zarrita. The core owns plan-building, per-level
 * dispatch, concurrency, retry, dedup and GPU residency; this module only
 * moves bytes. (For whole-level, per-channel loading of modest stores, use
 * `omeZarrLoader.ts` instead.)
 *
 * ```ts
 * const source = await fetchOmeZarr(url)
 * await nv.loadChunkedVolume(omeZarrChunkedSource(source, { channel: 1 }))
 * ```
 *
 * The time and channel axes are pinned per source (one channel streams per
 * chunked volume), and the declared spatial axis order is honoured: bricks
 * from an `x y z`-ordered store (the Human Organ Atlas) are transposed to the
 * x-fastest layout the contract requires, so the anatomy presents identically
 * to a conventional `z y x` store. See `docs/ome-zarr-format.md`.
 */

import * as zarr from 'zarrita'
import type { TypedVoxelArray } from '@/NVTypes'
import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
} from './ChunkedVolumeSource'
import {
  recordChunkPhase,
  timeChunkNetAsync,
  timeChunkPhaseAsync,
} from './chunkTiming'
import { allocTypedArrayLike } from './omeZarr'
import {
  type OmeZarrLoadOptions,
  type OmeZarrSource,
  type OpenOmeZarrOptions,
  omeZarrNiftiDatatype,
  openOmeZarr,
} from './omeZarrLoader'
import {
  OME_ZARR_PERSIST_BYTES,
  openPersistentByteCache,
  type PersistentByteCache,
  type PersistentCacheOptions,
  type PersistentCacheStats,
  withPersistentBytes,
} from './persistentByteCache'
import { getBitsPerVoxel } from './utils'

/** What a {@link ByteLruCache} has done since it was created or reset. */
export interface ByteCacheStats {
  /** Lookups that found a resident entry. */
  hits: number
  /** Lookups that did not, each of which became a store read. */
  misses: number
  /** Values admitted, absences included. */
  admitted: number
  /** Values refused because one alone exceeds the whole budget. */
  rejected: number
  /** Entries dropped to stay inside the budget. */
  evicted: number
  /** Bytes dropped by those evictions. */
  evictedBytes: number
  /** Entries resident now. */
  entries: number
  /** Bytes resident now (absences count 0). */
  bytes: number
  /** The budget those bytes are measured against. */
  maxBytes: number
}

/**
 * A byte-bounded LRU cache for zarrita's `withByteCaching` store wrapper.
 *
 * Values are raw store responses; an entry holding `undefined` is a CONFIRMED
 * ABSENCE (zarr's missing-chunk-means-fill-value convention), remembered so a
 * sparse store's absent chunks are not re-requested on every plan rebuild —
 * a store is immutable for the life of a load, so an absence is permanent.
 * Absences cost 0 bytes and are evicted like any other entry.
 *
 * `totalBytes <= maxBytes` holds after every operation: a value larger than
 * the whole budget is never admitted (its key is simply left uncached, and no
 * resident entries are evicted for it). A budget of 0 therefore caches only
 * zero-byte absence entries; `Infinity` never evicts.
 *
 * {@link stats} answers the question a byte budget always raises: is the
 * budget too small, or is there simply no reuse in this access pattern? The
 * two look identical from outside (both are all misses) and want opposite
 * fixes, so the counters distinguish them — a run with many evictions and few
 * hits is thrash, a run with few evictions and few hits has nothing to reuse.
 * `has` is the gate `withByteCaching` consults before every read, so it is the
 * one place a lookup is counted; `get` only runs after a hit.
 *
 * ```ts
 * const cache = new ByteLruCache(256 * 2 ** 20)
 * const store = zarr.withByteCaching(new zarr.FetchStore(url), { cache })
 * // ... stream ...
 * const { hits, misses, evicted } = cache.stats
 * ```
 */
export class ByteLruCache {
  private entries = new Map<
    string,
    { value: Uint8Array | undefined; bytes: number }
  >()
  private total = 0
  private hits = 0
  private misses = 0
  private admitted = 0
  private rejected = 0
  private evicted = 0
  private evictedBytes = 0

  constructor(readonly maxBytes: number) {
    // Rejects NaN and negatives in one comparison; 0 and Infinity are valid.
    if (!(maxBytes >= 0)) {
      throw new Error(
        `ByteLruCache: maxBytes must be a non-negative number, got ${maxBytes}`,
      )
    }
  }

  /** Bytes currently held (absence entries count 0). */
  get totalBytes(): number {
    return this.total
  }

  /** A snapshot of {@link ByteCacheStats}. Cheap; take it every frame. */
  get stats(): ByteCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      admitted: this.admitted,
      rejected: this.rejected,
      evicted: this.evicted,
      evictedBytes: this.evictedBytes,
      entries: this.entries.size,
      bytes: this.total,
      maxBytes: this.maxBytes,
    }
  }

  /** Zero the counters, keeping the resident entries. Starts a window. */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.admitted = 0
    this.rejected = 0
    this.evicted = 0
    this.evictedBytes = 0
  }

  has(key: string): boolean {
    const hit = this.entries.has(key)
    if (hit) {
      this.hits++
    } else {
      this.misses++
    }
    return hit
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    // Re-insert so iteration order stays least-recently-used first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Uint8Array | undefined): void {
    const existing = this.entries.get(key)
    if (existing) {
      this.total -= existing.bytes
      this.entries.delete(key)
    }
    const bytes = value?.byteLength ?? 0
    // A value larger than the whole budget can never be held within it. Do
    // not admit it, and do not evict resident entries to make room that will
    // not suffice. (The stale same-key entry was already dropped above.)
    if (bytes > this.maxBytes) {
      this.rejected++
      return
    }
    this.entries.set(key, { value, bytes })
    this.total += bytes
    this.admitted++
    // Every admitted entry fits the budget on its own, so evicting oldest
    // first always reaches totalBytes <= maxBytes by the time one entry is
    // left.
    while (this.total > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.entries().next().value
      if (!oldest) {
        return
      }
      this.entries.delete(oldest[0])
      this.total -= oldest[1].bytes
      this.evicted++
      this.evictedBytes += oldest[1].bytes
    }
  }
}

/** Options for {@link omeZarrChunkedSource}. */
export interface OmeZarrChunkedSourceOptions {
  /** Channel to stream. Defaults to the first. */
  channel?: number
  /** Timepoint to stream. Defaults to the first. */
  timepoint?: number
}

/** A {@link ChunkedVolumeSource} that keeps its opened pyramid reachable. */
export interface OmeZarrChunkedSource extends ChunkedVolumeSource {
  /** The opened store behind the adapter (levels, omero channels, axes). */
  readonly zarr: OmeZarrSource
  /**
   * The store-level byte cache, when one was built for this source. Present
   * on {@link fetchOmeZarrChunkedSource} results with a non-zero budget, so a
   * host can read {@link ByteLruCache.stats} to see whether the budget is
   * doing anything; absent when the caller brought its own store.
   */
  readonly byteCache?: ByteLruCache
  /**
   * The byte cache's counters, wherever the cache lives. Prefer this over
   * {@link byteCache} in a host that just wants to report a hit rate: with the
   * chunk worker pool on there is no single `ByteLruCache` on this thread to
   * read, and this returns the pool's caches summed instead.
   */
  readonly byteCacheStats?: () => ByteCacheStats
  /**
   * The persistent tier's counters, when one was opened for this source. Same
   * arrangement as {@link byteCacheStats}: with the chunk worker pool on, the
   * caches live on the workers and this sums them.
   */
  readonly persistStats?: () => PersistentCacheStats
  /**
   * Release what this source holds open. Terminates the chunk worker pool when
   * one is running; a no-op otherwise. Safe to call more than once.
   */
  readonly dispose?: () => void
}

/**
 * Read one brick's voxel region from one pyramid level: clamp the requested
 * display-space region to the level's extent, slice the store over its own
 * declared axes, and lay the block out x-fastest, zero-padded back up to the
 * full `texDims` where the region runs past the array bounds.
 */
async function readLevelRegion(
  source: OmeZarrSource,
  channel: number,
  timepoint: number,
  req: ChunkedVolumeFetch,
): Promise<Uint8Array> {
  const { levelIndex, texOrigin, texDims, bytesPerVoxel } = req
  if (
    !Number.isInteger(levelIndex) ||
    levelIndex < 0 ||
    levelIndex >= source.levels.length
  ) {
    throw new Error(
      `OME-Zarr: level index ${levelIndex} is out of range ` +
        `(source has ${source.levels.length})`,
    )
  }
  const level = source.levels[levelIndex]
  const array = source.arrays[levelIndex]
  const [sx, sy, sz] = texDims
  const [x0, y0, z0] = texOrigin
  const expectedBytes = sx * sy * sz * bytesPerVoxel

  // Clamp to the level's real extent; the remainder zero-pads (out-of-bounds
  // voxels hold the fill value 0, matching zarr's own convention).
  const rx = Math.min(x0 + sx, level.dims[0]) - x0
  const ry = Math.min(y0 + sy, level.dims[1]) - y0
  const rz = Math.min(z0 + sz, level.dims[2]) - z0
  if (rx <= 0 || ry <= 0 || rz <= 0) {
    return new Uint8Array(expectedBytes)
  }

  const { indices, order } = source
  const selection = array.shape.map((_extent, axis) => {
    if (axis === indices.channel) {
      return channel
    }
    if (axis === indices.time) {
      return timepoint
    }
    const position = indices.spatial.indexOf(axis)
    if (position < 0) {
      return 0
    }
    if (position === order.x) {
      return zarr.slice(x0, x0 + rx)
    }
    if (position === order.y) {
      return zarr.slice(y0, y0 + ry)
    }
    return zarr.slice(z0, z0 + rz)
  })

  const block = await zarr.get(array, selection, { signal: req.signal })
  if (typeof block !== 'object' || block === null || !('data' in block)) {
    throw new Error('OME-Zarr: reading a level region returned no block')
  }
  const data = block.data as TypedVoxelArray
  const stride = block.stride
  const strideX = stride[order.x]
  const strideY = stride[order.y]
  const strideZ = order.z < 0 ? 0 : stride[order.z]

  // Fast path: full-coverage read already in x-fastest order.
  if (
    rx === sx &&
    ry === sy &&
    rz === sz &&
    strideX === 1 &&
    strideY === rx &&
    (rz === 1 || strideZ === rx * ry)
  ) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(
        `OME-Zarr: region at ${texOrigin.join(',')} returned ` +
          `${bytes.byteLength}B, expected ${expectedBytes}B`,
      )
    }
    return bytes
  }

  const out = allocTypedArrayLike(data, sx * sy * sz)
  const assembleStart = performance.now()
  for (let z = 0; z < rz; z++) {
    for (let y = 0; y < ry; y++) {
      const src = z * strideZ + y * strideY
      const dst = z * sx * sy + y * sx
      if (strideX === 1) {
        out.set(data.subarray(src, src + rx), dst)
      } else {
        for (let x = 0; x < rx; x++) {
          out[dst + x] = data[src + x * strideX]
        }
      }
    }
  }
  recordChunkPhase('assemble', performance.now() - assembleStart, expectedBytes)
  return new Uint8Array(out.buffer, out.byteOffset, expectedBytes)
}

/**
 * Adapt an opened OME-Zarr pyramid to the core chunk-streaming seam.
 *
 * The returned source's `levels` are finest-first in DISPLAY terms (dims and
 * micrometre spacing in x, y, z), with each level labelled by its dataset
 * index so telemetry matches the store's own pyramid numbering.
 */
export function omeZarrChunkedSource(
  source: OmeZarrSource,
  options: OmeZarrChunkedSourceOptions = {},
): OmeZarrChunkedSource {
  const dtype = source.levels[0].dtype
  for (const level of source.levels) {
    if (level.dtype !== dtype) {
      throw new Error(
        `OME-Zarr: mixed level dtypes ('${dtype}' vs '${level.dtype}')`,
      )
    }
  }
  const datatypeCode = omeZarrNiftiDatatype(dtype)
  const bytesPerVoxel = getBitsPerVoxel(datatypeCode) / 8

  const channel = options.channel ?? 0
  if (
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel >= source.channelCount
  ) {
    throw new Error(
      `OME-Zarr: channel ${channel} is out of range ` +
        `(store has ${source.channelCount})`,
    )
  }
  const timepoint = options.timepoint ?? 0
  if (
    !Number.isInteger(timepoint) ||
    timepoint < 0 ||
    timepoint >= source.timepointCount
  ) {
    throw new Error(
      `OME-Zarr: timepoint ${timepoint} is out of range ` +
        `(store has ${source.timepointCount})`,
    )
  }

  return {
    zarr: source,
    datatypeCode,
    levels: source.levels.map((level) => ({
      level: level.datasetIndex,
      shape: [level.dims[0], level.dims[1], level.dims[2]],
      spacing: [level.spacingUm[0], level.spacingUm[1], level.spacingUm[2]],
    })),
    async fetchChunk(req: ChunkedVolumeFetch): Promise<Uint8Array> {
      if (req.bytesPerVoxel !== bytesPerVoxel) {
        throw new Error(
          `OME-Zarr: fetch asked for ${req.bytesPerVoxel} bytes/voxel, ` +
            `the store holds ${bytesPerVoxel}`,
        )
      }
      const expected =
        req.texDims[0] * req.texDims[1] * req.texDims[2] * req.bytesPerVoxel
      return timeChunkPhaseAsync(
        'read',
        () => readLevelRegion(source, channel, timepoint, req),
        expected,
      )
    },
  }
}

type StoreGet = zarr.AsyncReadable['get']
type StoreGetRange = NonNullable<zarr.AsyncReadable['getRange']>

/**
 * Wrap a zarr store so every byte read is timed into the `net` phase of
 * {@link chunkTimingSnapshot} — the network round trip, or the near-zero cost
 * of a hit in the byte LRU when this wraps a cached store.
 *
 * It is a plain delegate rather than a subclass so it composes with
 * `withByteCaching` in either order; put it OUTSIDE the cache to measure "time
 * to get the bytes in hand" (cache hits then show up as the fast reads they
 * are), and inside it to measure the origin alone. `getRange` is forwarded
 * only when the wrapped store has it, so a sharded store keeps its range path.
 *
 * One `zarr.get` fans out to every store chunk covering the region, so these
 * calls overlap; the timing they feed also maintains the `netBusyMs` union so
 * that overlap does not multiply-count the same wall clock.
 */
export function withChunkTiming(store: zarr.AsyncReadable): zarr.AsyncReadable {
  const get: StoreGet = (key, opts) =>
    timeChunkNetAsync(() => store.get(key, opts))
  const inner = store.getRange
  if (!inner) return { get }
  const getRange: StoreGetRange = (key, range, opts) =>
    timeChunkNetAsync(() => inner.call(store, key, range, opts))
  return { get, getRange }
}

/** Options for {@link fetchOmeZarrChunkedSource}. */
export interface FetchOmeZarrChunkedSourceOptions
  extends OpenOmeZarrOptions,
    OmeZarrChunkedSourceOptions,
    Pick<OmeZarrLoadOptions, 'fetchImpl'> {
  /**
   * Byte budget for the store-level LRU cache (raw store responses, including
   * remembered absent chunks). 0 disables caching. Default 256 MiB.
   */
  cacheBytes?: number
  /**
   * Chunk-reading workers to run. Omit for the default (half the reported
   * cores, at most four); `0` keeps every read on the calling thread.
   *
   * With a pool running, `cacheBytes` is SPLIT across the workers rather than
   * given to each, so the budget still bounds total memory. Ignored when
   * `fetchImpl` is set (a function cannot cross to a worker) or where Workers
   * are unavailable, and a read that fails for an infrastructure reason falls
   * back to this thread.
   */
  workers?: number
  /**
   * Keep raw store bytes across sessions, so a reload streams from disk
   * instead of the network. `true` takes the defaults; an object sizes and
   * names the cache. Off by default: it writes to the user's disk, which is
   * theirs to opt into.
   *
   * With a pool running, the budget is SPLIT across the workers the same way
   * `cacheBytes` is, and they share one backing store. Requires a secure
   * context with Cache Storage; where there is none, this is a no-op.
   */
  persist?: boolean | PersistentCacheOptions
}

/** Default byte budget for {@link fetchOmeZarrChunkedSource}'s store cache. */
export const OME_ZARR_CHUNK_CACHE_BYTES = 256 * 2 ** 20

/**
 * `Error.name` for a chunk read that failed on its own terms — a missing
 * store, a region that will not decode. It marks the failures that re-running
 * elsewhere would only repeat, so the worker path knows not to pay for the
 * same read twice on the render thread.
 */
export const OME_ZARR_CHUNK_ERROR = 'OmeZarrChunkError'

/**
 * Open a store by URL with a byte-caching wrapper and adapt it for
 * `nv.loadChunkedVolume`. The opened pyramid stays reachable on the result's
 * `zarr` property (level metadata, omero channels).
 *
 * Every read runs on the CALLING thread. This is the primitive both sides of
 * the worker pool are built from: {@link fetchOmeZarrChunkedSource} calls it
 * to hold the metadata and to keep a fallback read path, and each chunk worker
 * calls it to do the reading. Reach for it directly when you want a store with
 * no pool behind it at all.
 */
export async function openOmeZarrChunkedSource(
  url: string,
  options: FetchOmeZarrChunkedSourceOptions = {},
): Promise<OmeZarrChunkedSource> {
  const cacheBytes = options.cacheBytes ?? OME_ZARR_CHUNK_CACHE_BYTES
  const base = options.fetchImpl
    ? new zarr.FetchStore(url, { fetch: options.fetchImpl })
    : new zarr.FetchStore(url)
  // Innermost of the three tiers: below memory, above the network. A read
  // reaches it only when the byte LRU could not answer, and what it hands back
  // is what the network would have -- raw, still-compressed store bytes.
  const persistCache = await openPersistTier(options.persist)
  const persisted = persistCache
    ? withPersistentBytes(base, persistCache, url)
    : base
  const byteCache = cacheBytes > 0 ? new ByteLruCache(cacheBytes) : undefined
  const cached = byteCache
    ? zarr.withByteCaching(persisted, { cache: byteCache })
    : persisted
  // Outermost, so a byte-cache hit is measured as the fast read it is and the
  // `net` phase answers "how long did it take to get these bytes in hand".
  const store = withChunkTiming(cached)
  const source: OmeZarrChunkedSource = omeZarrChunkedSource(
    await openOmeZarr(store, options),
    options,
  )
  const withPersist: OmeZarrChunkedSource = persistCache
    ? { ...source, persistStats: () => persistCache.stats }
    : source
  if (!byteCache) return withPersist
  return {
    ...withPersist,
    byteCache,
    byteCacheStats: () => byteCache.stats,
  }
}

/**
 * Open the persistent tier a `persist` option asks for, or null. Null covers
 * both "the caller did not ask" and "this context has no Cache Storage", which
 * the read path treats identically: no tier, no change in behaviour.
 */
function openPersistTier(
  persist: boolean | PersistentCacheOptions | undefined,
): Promise<PersistentByteCache | null> {
  if (!persist) return Promise.resolve(null)
  const options = persist === true ? {} : persist
  // Spread rather than pick: `scope` and `scopes` decide which keys this cache
  // owns, and dropping them would hand every worker the whole store.
  return openPersistentByteCache({
    ...options,
    maxBytes: options.maxBytes ?? OME_ZARR_PERSIST_BYTES,
  })
}
