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

import type {
  ByteLruStats,
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
  TypedVoxelArray,
} from '@niivue/niivue'
import {
  ByteLru,
  getBitsPerVoxel,
  NIFTI_UNITS_MICRON,
  recordChunkPhase,
  timeChunkNetAsync,
  timeChunkPhaseAsync,
  withSpatialUnits,
} from '@niivue/niivue'
import * as zarr from '@niivue/zarrita-rs/inline'
import { anySignal, slideFetch } from '../rangeFetch'
import { fnv1a } from './chunkWorkerRouting'
import { copyStrided } from './copyStrided'
import {
  allocTypedArrayLike,
  checkOmeZarrIndex,
  omeroActiveChannels,
} from './omeZarr'
import {
  countingFetch,
  METADATA_KEY,
  type OmeZarrLoadOptions,
  type OmeZarrSource,
  type OpenOmeZarrOptions,
  omeZarrFetchStore,
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

/** Options for {@link omeZarrChunkedSource}. */
export interface OmeZarrChunkedSourceOptions {
  /** Channel to stream. Defaults to the first active one (omero). */
  channel?: number
  /** Timepoint read when a fetch states no `frame`. Defaults to the first. */
  timepoint?: number
}

/** A chunk read that may override the source's channel (slide tiles). */
export interface OmeZarrChunkFetch extends ChunkedVolumeFetch {
  channel?: number
}

/** A hash of the structure (axes, levels, dtype, omero): a source's `revision`. */
function structureRevision(source: OmeZarrSource): string {
  const json = JSON.stringify([
    source.info,
    source.levels.map((l) => [l.shape, l.dtype]),
  ])
  return (fnv1a(json) >>> 0).toString(16)
}

/** A {@link ChunkedVolumeSource} that keeps its opened pyramid reachable. */
export interface OmeZarrChunkedSource extends ChunkedVolumeSource {
  /** The opened store behind the adapter (levels, omero channels, axes). */
  readonly zarr: OmeZarrSource
  /** The channel streamed: the one asked for, else the first active. */
  readonly channel: number
  /**
   * The store-level byte cache, when one was built for this source. Present
   * on {@link fetchOmeZarrChunkedSource} results with a non-zero budget, so a
   * host can read its `stats` to see whether the budget is
   * doing anything; absent when the caller brought its own store.
   */
  readonly byteCache?: ByteLru<string, Uint8Array | undefined>
  /**
   * The byte cache's counters, wherever the cache lives. Prefer this over
   * {@link byteCache} in a host that just wants to report a hit rate: with the
   * chunk worker pool on there is no single byte cache on this thread to
   * read, and this returns the pool's caches summed instead.
   */
  readonly byteCacheStats?: () => ByteLruStats
  /**
   * The persistent tier's counters, when one was opened for this source. Same
   * arrangement as {@link byteCacheStats}: with the chunk worker pool on, the
   * caches live on the workers and this sums them.
   */
  readonly persistStats?: () => PersistentCacheStats
  /**
   * Release what this source holds: abort its reads (they reject
   * `AbortError`), drop its byte cache and terminate the chunk worker pool
   * when one is running. Safe to call more than once.
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
  copyStrided(out, data, [rx, ry, rz], [strideX, strideY, strideZ], sx, sx * sy)
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

  const channel =
    options.channel ??
    omeroActiveChannels(source.info.channels, source.channelCount)[0]
  checkOmeZarrIndex('channel', channel, source.channelCount)
  const timepoint = options.timepoint ?? 0
  checkOmeZarrIndex('timepoint', timepoint, source.timepointCount)

  return {
    zarr: source,
    channel,
    frames: source.timepointCount,
    revision: structureRevision(source),
    datatypeCode,
    xyztUnits: withSpatialUnits(10, NIFTI_UNITS_MICRON), // um + sec
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
      const frame = req.frame ?? timepoint
      checkOmeZarrIndex('frame', frame, source.timepointCount)
      // A slide's tile reads (through the chunk workers) name their channel.
      const c = (req as OmeZarrChunkFetch).channel ?? channel
      checkOmeZarrIndex('channel', c, source.channelCount)
      return timeChunkPhaseAsync(
        'read',
        () => readLevelRegion(source, c, frame, req),
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
    Pick<OmeZarrLoadOptions, 'fetch'> {
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
   * `fetch` is set (a function cannot cross to a worker) or where Workers
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
  metadata?: Map<string, Uint8Array | undefined>,
  /** Told each response's byte count (HEADs excluded); the chunk workers report it. */
  countWire?: (bytes: number) => void,
): Promise<OmeZarrChunkedSource> {
  // Page-relative URLs resolve here, so persisted keys are absolute.
  const href = new URL(url, globalThis.location?.href).href
  const cacheBytes = options.cacheBytes ?? OME_ZARR_CHUNK_CACHE_BYTES
  // Not through `options.fetch`: a custom fetch would decline persistence.
  const fetched = omeZarrFetchStore(
    href,
    countWire
      ? countingFetch(options.fetch, countWire)
      : options.fetch && slideFetch(options.fetch),
  )
  const base = metadata ? withMetadata(fetched, metadata) : fetched
  // Innermost of the three tiers: below memory, above the network. A read
  // reaches it only when the byte LRU could not answer, and what it hands back
  // is what the network would have -- raw, still-compressed store bytes.
  const persistCache = await openPersistTier(
    persistable(href, options) && options.persist,
  )
  const persisted = persistCache
    ? withPersistentBytes(base, persistCache, href)
    : base
  const byteCache =
    cacheBytes > 0
      ? new ByteLru<string, Uint8Array | undefined>(cacheBytes)
      : undefined
  const cached = byteCache
    ? zarr.withByteCaching(persisted, { cache: byteCache })
    : persisted
  // Outermost, so a byte-cache hit is measured as the fast read it is and the
  // `net` phase answers "how long did it take to get these bytes in hand".
  const store = withChunkTiming(cached)
  const source = omeZarrChunkedSource(
    await openOmeZarr(store, options),
    options,
  )
  const closed = new AbortController()
  return {
    ...source,
    fetchChunk: async (req) => {
      closed.signal.throwIfAborted()
      return source.fetchChunk({
        ...req,
        signal: anySignal(req.signal, closed.signal),
      })
    },
    dispose: () => {
      closed.abort()
      byteCache?.clear()
    },
    ...(persistCache ? { persistStats: () => persistCache.stats } : {}),
    ...(byteCache ? { byteCache, byteCacheStats: () => byteCache.stats } : {}),
  }
}

/**
 * Answer metadata reads from `metadata`, recording the ones it lacks (a 404
 * as undefined, so a v2 store's v3 probe replays too). The main thread opens
 * with an empty map and hands it to the chunk workers, which then open with
 * no request at all.
 */
export function withMetadata(
  store: zarr.AsyncReadable,
  metadata: Map<string, Uint8Array | undefined>,
): zarr.AsyncReadable {
  const getRange = store.getRange?.bind(store)
  return {
    async get(key, opts) {
      if (!METADATA_KEY.test(key)) return store.get(key, opts)
      if (metadata.has(key)) return metadata.get(key)
      const value = await store.get(key, opts)
      metadata.set(key, value)
      return value
    },
    ...(getRange ? { getRange } : {}),
  }
}

/**
 * Whether a store's bytes may persist (contract section 6, owner OQ11): only
 * on a credential-free http(s) URL. A query (a signed URL or `?token=`), userinfo or
 * a custom fetch (which may add auth headers) keeps them in memory only.
 * `persist` is already the explicit opt-in that declares the store immutable.
 */
export function persistable(
  url: string,
  options: Pick<FetchOmeZarrChunkedSourceOptions, 'fetch' | 'persist'>,
): boolean {
  // A page-relative URL is judged as the absolute one it fetches.
  const base = globalThis.location?.href
  const href = URL.canParse(url, base) ? new URL(url, base).href : url
  const ok =
    !options.fetch &&
    /^https?:\/\//i.test(href) &&
    !/[?#]/.test(href) &&
    !/\/\/[^/]*@/.test(href)
  if (!ok && options.persist && !declinedWarned) {
    declinedWarned = true
    console.warn(
      'OME-Zarr: persist ignored: it needs an http(s) URL with no query or credentials, and no custom fetch',
    )
  }
  return ok
}
let declinedWarned = false

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
