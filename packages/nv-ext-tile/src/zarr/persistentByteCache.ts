/**
 * A cross-session tier for raw store bytes, under the in-memory byte LRU.
 *
 * Every other tier we have dies on reload. The GPU residency set, the decoded
 * chunk tier, the byte LRU: all of them are process memory, so the second
 * visit to a dataset costs exactly what the first one did. For DANDI over S3
 * that is the most visible cost a user pays, and it is paid again every time
 * they refresh the tab. This tier persists the bytes the network handed us, so
 * a warm start streams from disk at local-disk latency.
 *
 * WHAT IS PERSISTED, and why it is this layer. The bytes here are the raw,
 * still-compressed store responses -- the network's own output, before
 * zarrita's codec pipeline. Persisting there rather than after the decode
 * means the entry is format-agnostic (one code path serves every codec and
 * dtype), it is keyed by something already unique and stable (the chunk's
 * store key), and it is the smallest representation of the chunk that exists.
 * The decode is cheap next to the round trip; the round trip is what we are
 * buying back.
 *
 * ABSENCES ARE NOT PERSISTED, though the in-memory tier remembers them. A
 * missing chunk means fill-value in zarr, and that is permanent for the life
 * of a load -- but not necessarily across days. A store that was still being
 * written when it was first opened would otherwise keep its holes forever, in
 * a cache the user cannot see and did not ask for. Bytes we hold are content
 * addressed by definition (a chunk that exists never changes); an absence is
 * the one thing in the store that can turn into something else.
 *
 * THE INDEX IS THE BUDGET. Cache Storage has no size bound and no eviction
 * policy of its own, so this class keeps the accounting: an in-memory index
 * from store identity to backing key, insertion ordered, re-inserted on every
 * hit so iteration order is least-recently-used first. The backing key carries
 * the entry's byte length in its query string, so {@link PersistentByteCache.open}
 * rebuilds both the index and the byte total from ONE listing of the backing
 * keys -- no body is read to find out how big it is. Across a reload the
 * recency order is lost (the listing returns insertion order), so a cold start
 * evicts oldest-written first and warms into true LRU as entries are touched.
 *
 * ONE BACKING, MANY OWNERS. With the chunk worker pool running there are
 * several of these over the same backing store, one per worker, and they must
 * not fight: a cache that adopted every key it can see would evict entries
 * another worker still counts as its own, and four caches each enforcing a
 * quarter of the budget over the whole store would throw away three quarters
 * of it on the first warm start. So each cache owns a SCOPE -- an identity
 * prefix -- and adopts only keys inside it. Keys belonging to a scope it was
 * told about are left alone; keys belonging to no known scope are stale (the
 * pool was a different size last time) and are removed. Routing is
 * deterministic, so a brick returns to the worker that holds it and the scopes
 * partition the store rather than shadowing it.
 *
 * EVERY OPERATION IS BEST EFFORT. The browser may clear the whole bucket under
 * storage pressure, a write may exceed the origin quota, a non-secure context
 * has no Cache Storage at all. None of that may break a load: failures are
 * counted in {@link PersistentCacheStats} and the read falls through to the
 * store. On a quota error the budget HALVES rather than retrying into the same
 * wall -- our ceiling is a policy, the browser's is not.
 */

import type * as zarr from 'zarrita'

/** What a {@link PersistentByteCache} has done since it was opened. */
export interface PersistentCacheStats {
  /** Lookups served from the backing store. */
  hits: number
  /** Lookups that had to read the store, including entries that vanished. */
  misses: number
  /** Entries written. */
  writes: number
  /** Values refused because one alone exceeds the whole budget. */
  rejected: number
  /** Entries dropped to stay inside the budget. */
  evicted: number
  /** Bytes dropped by those evictions. */
  evictedBytes: number
  /** Backing operations that failed. Never thrown, only counted. */
  errors: number
  /** Entries held now. */
  entries: number
  /** Bytes held now. */
  bytes: number
  /** The budget those bytes are measured against, after any quota shrink. */
  maxBytes: number
}

/**
 * The storage this tier writes through. Narrow on purpose: the cache logic
 * (index, recency, budget, key encoding) is pure and runs anywhere, and only
 * this interface touches a browser API. {@link openCacheStorageBacking} is the
 * Cache Storage implementation; an OPFS one would slot in here unchanged.
 */
export interface PersistentCacheBacking {
  /** Every key held, in insertion order. */
  keys(): Promise<string[]>
  /** The bytes at a key, or undefined if it is not there any more. */
  read(key: string): Promise<Uint8Array | undefined>
  /** Write bytes at a key, replacing whatever was there. */
  write(key: string, bytes: Uint8Array): Promise<void>
  /** Drop a key. Missing is not an error. */
  remove(key: string): Promise<void>
}

/** How a {@link PersistentByteCache} is sized, named and scoped. */
export interface PersistentCacheOptions {
  /** Byte budget for the whole tier. Default 512 MiB. */
  maxBytes?: number
  /**
   * The identity prefix this cache owns. Default `''`, which owns everything
   * -- right for a single cache over its own backing. The worker pool gives
   * each worker its own scope so they share one backing without colliding.
   */
  scope?: string
  /**
   * Every scope in use over this backing, this one included. Keys under none
   * of them belong to nobody and are deleted on open. Default `[scope]`.
   */
  scopes?: readonly string[]
  /**
   * Cache Storage name. The version suffix is load bearing: change the key
   * encoding and bump it, and {@link openCacheStorageBacking} deletes what the
   * old code wrote instead of orphaning it on the user's disk.
   */
  name?: string
}

/** Default byte budget for the persistent tier. */
export const OME_ZARR_PERSIST_BYTES = 512 * 2 ** 20

/** Cache Storage name for the current key encoding. */
export const PERSISTENT_CACHE_NAME = 'niivue-zarr-v1'

/** The prefix every {@link PERSISTENT_CACHE_NAME} entry shares. */
const KEY_PREFIX = 'https://niivue.cache/zarr/'

/** Cache names this code has ever written, for the prune on open. */
const KEY_NAME_PREFIX = 'niivue-zarr-'

/**
 * The backing key for a store identity of a known size. Cache Storage keys are
 * URLs (nothing is ever fetched from this one), and the byte length rides in
 * the query string so a listing alone rebuilds the byte accounting.
 */
export function persistentCacheKey(identity: string, bytes: number): string {
  return `${KEY_PREFIX}${encodeURIComponent(identity)}?b=${bytes}`
}

/** Read back what {@link persistentCacheKey} wrote, or null if it did not. */
export function parsePersistentCacheKey(
  key: string,
): { identity: string; bytes: number } | null {
  if (!key.startsWith(KEY_PREFIX)) return null
  const mark = key.indexOf('?b=', KEY_PREFIX.length)
  if (mark < 0) return null
  const bytes = Number(key.slice(mark + 3))
  if (!Number.isFinite(bytes) || bytes < 0) return null
  try {
    return {
      identity: decodeURIComponent(key.slice(KEY_PREFIX.length, mark)),
      bytes,
    }
  } catch {
    // A key we did not write, or one written by a different encoding.
    return null
  }
}

interface IndexEntry {
  key: string
  bytes: number
}

/**
 * A byte-bounded, cross-session cache of raw store responses.
 *
 * ```ts
 * const cache = await openPersistentByteCache({ maxBytes: 256 * 2 ** 20 })
 * const store = cache
 *   ? withPersistentBytes(new zarr.FetchStore(url), cache, url)
 *   : new zarr.FetchStore(url)
 * ```
 */
export class PersistentByteCache {
  private readonly index = new Map<string, IndexEntry>()
  private limit: number
  private total = 0
  private hits = 0
  private misses = 0
  private writes = 0
  private rejected = 0
  private evicted = 0
  private evictedBytes = 0
  private errors = 0
  private pending = new Set<Promise<void>>()

  private constructor(
    private readonly backing: PersistentCacheBacking,
    maxBytes: number,
    /** The identity prefix this cache owns; see the module note. */
    readonly scope: string,
  ) {
    this.limit = maxBytes
  }

  /**
   * Adopt whatever the backing already holds. One listing rebuilds the index
   * and the byte total; keys this encoding did not write are removed rather
   * than counted, so a bumped cache name cannot leave bytes nobody owns.
   */
  static async open(
    backing: PersistentCacheBacking,
    maxBytes: number = OME_ZARR_PERSIST_BYTES,
    scope = '',
    scopes: readonly string[] = [scope],
  ): Promise<PersistentByteCache> {
    const cache = new PersistentByteCache(backing, Math.max(0, maxBytes), scope)
    let keys: string[] = []
    try {
      keys = await backing.keys()
    } catch {
      cache.errors++
      return cache
    }
    for (const key of keys) {
      const parsed = parsePersistentCacheKey(key)
      if (!parsed) {
        cache.drop(key)
        continue
      }
      if (!parsed.identity.startsWith(scope)) {
        // Another scope's key. Leave it if that scope still exists; the pool
        // was a different size last session if it does not.
        if (!scopes.some((other) => parsed.identity.startsWith(other))) {
          cache.drop(key)
        }
        continue
      }
      const stale = cache.index.get(parsed.identity)
      if (stale) {
        // Two sizes for one identity: the store cannot have changed under us,
        // so this is a half-finished replace. Keep the newer listing entry.
        cache.total -= stale.bytes
        cache.drop(stale.key)
      }
      cache.index.set(parsed.identity, { key, bytes: parsed.bytes })
      cache.total += parsed.bytes
    }
    cache.evictToFit()
    return cache
  }

  /** Bytes currently held. */
  get totalBytes(): number {
    return this.total
  }

  /** The budget in force, which a quota error may have shrunk. */
  get maxBytes(): number {
    return this.limit
  }

  /** A snapshot of {@link PersistentCacheStats}. Cheap; take it every frame. */
  get stats(): PersistentCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      rejected: this.rejected,
      evicted: this.evicted,
      evictedBytes: this.evictedBytes,
      errors: this.errors,
      entries: this.index.size,
      bytes: this.total,
      maxBytes: this.limit,
    }
  }

  /**
   * The bytes for a store identity, or undefined if this tier does not have
   * them. An entry the browser has since cleared reads as a miss, not an
   * error: the bucket is not ours to keep.
   */
  async get(unscoped: string): Promise<Uint8Array | undefined> {
    const identity = `${this.scope}${unscoped}`
    const entry = this.index.get(identity)
    if (!entry) {
      this.misses++
      return undefined
    }
    let bytes: Uint8Array | undefined
    try {
      bytes = await this.backing.read(entry.key)
    } catch {
      this.errors++
    }
    if (!bytes) {
      this.misses++
      if (this.index.get(identity) === entry) {
        this.index.delete(identity)
        this.total -= entry.bytes
      }
      return undefined
    }
    this.hits++
    // Re-insert so iteration order stays least-recently-used first.
    this.index.delete(identity)
    this.index.set(identity, entry)
    return bytes
  }

  /**
   * Hold bytes for a store identity. Resolves when the write has landed (or
   * failed); callers on the read path should not await it, since the bytes are
   * already in hand and the write is pure lookahead for the next session.
   */
  async set(unscoped: string, bytes: Uint8Array): Promise<void> {
    const identity = `${this.scope}${unscoped}`
    // A value larger than the whole budget can never be held within it. Do not
    // admit it, and do not evict resident entries to make room that will not
    // suffice.
    if (bytes.byteLength > this.limit) {
      this.rejected++
      return
    }
    const stale = this.index.get(identity)
    if (stale) {
      this.index.delete(identity)
      this.total -= stale.bytes
      // The size rides in the key, so a re-write at a different size lands at
      // a different key. Drop the old one or it leaks bytes nobody indexes.
      if (stale.bytes !== bytes.byteLength) this.drop(stale.key)
    }
    const key = persistentCacheKey(identity, bytes.byteLength)
    // The index goes first and the write follows: the entry is the newest, so
    // the eviction it may trigger never chooses it, and a failed write below
    // takes the entry back out.
    this.index.set(identity, { key, bytes: bytes.byteLength })
    this.total += bytes.byteLength
    this.evictToFit()
    try {
      await this.track(this.backing.write(key, bytes))
      this.writes++
    } catch (err) {
      this.errors++
      const entry = this.index.get(identity)
      if (entry?.key === key) {
        this.index.delete(identity)
        this.total -= entry.bytes
      }
      // Out of quota is not a transient failure, and retrying walks into the
      // same wall. Halve our own ceiling and give the bytes back instead.
      if (err instanceof Error && err.name === 'QuotaExceededError') {
        this.limit = Math.max(0, Math.floor(this.total / 2))
        this.evictToFit()
      }
    }
  }

  /** Settle every write and eviction this cache has started. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  /** Drop everything, counters included. Used by the public cache reset. */
  async clear(): Promise<void> {
    const keys = [...this.index.values()].map((entry) => entry.key)
    this.index.clear()
    this.total = 0
    for (const key of keys) this.drop(key)
    await this.idle()
  }

  /** Evict least-recently-used entries until the budget holds. */
  private evictToFit(): void {
    for (const [identity, entry] of this.index) {
      if (this.total <= this.limit) return
      this.index.delete(identity)
      this.total -= entry.bytes
      this.evicted++
      this.evictedBytes += entry.bytes
      this.drop(entry.key)
    }
  }

  /** Remove a backing key, best effort. A failed delete is only counted. */
  private drop(key: string): void {
    void this.track(this.backing.remove(key)).catch(() => {
      this.errors++
    })
  }

  /** Keep a promise reachable so {@link idle} can wait for it. */
  private track(work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => {
      this.pending.delete(tracked)
    })
    this.pending.add(tracked)
    return tracked
  }
}

/**
 * Open the Cache Storage backing, or null where there is none: a non-secure
 * context, a sandboxed frame, a test runner. Callers treat null as "no
 * persistent tier" and carry on.
 *
 * Opening also prunes caches this code wrote under an older name, so a bumped
 * key encoding reclaims its predecessor's disk instead of doubling it.
 */
export async function openCacheStorageBacking(
  name: string = PERSISTENT_CACHE_NAME,
  storage: CacheStorage | undefined = typeof caches === 'undefined'
    ? undefined
    : caches,
): Promise<PersistentCacheBacking | null> {
  if (!storage) return null
  let cache: Cache
  try {
    cache = await storage.open(name)
  } catch {
    return null
  }
  try {
    for (const other of await storage.keys()) {
      if (other !== name && other.startsWith(KEY_NAME_PREFIX)) {
        await storage.delete(other)
      }
    }
  } catch {
    // A prune that cannot run costs disk, not correctness.
  }
  return {
    keys: async () => (await cache.keys()).map((request) => request.url),
    read: async (key) => {
      const response = await cache.match(key)
      if (!response) return undefined
      return new Uint8Array(await response.arrayBuffer())
    },
    write: async (key, bytes) => {
      // A Response body wants a whole buffer, and a chunk read may hand back a
      // window onto a larger decode buffer -- store the window, not its host.
      const whole =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      const body = whole
        ? bytes.buffer
        : bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          )
      await cache.put(key, new Response(body as ArrayBuffer))
    },
    remove: async (key) => {
      await cache.delete(key)
    },
  }
}

/**
 * Open the persistent tier for a store, or null where it cannot run. The
 * `backing` option is for tests and for a future OPFS implementation; leave it
 * unset and this uses Cache Storage.
 */
export async function openPersistentByteCache(
  options: PersistentCacheOptions & { backing?: PersistentCacheBacking } = {},
): Promise<PersistentByteCache | null> {
  const maxBytes = options.maxBytes ?? OME_ZARR_PERSIST_BYTES
  if (!(maxBytes > 0)) return null
  const backing =
    options.backing ?? (await openCacheStorageBacking(options.name))
  if (!backing) return null
  const scope = options.scope ?? ''
  return PersistentByteCache.open(
    backing,
    maxBytes,
    scope,
    options.scopes ?? [scope],
  )
}

/**
 * Delete everything this code has ever written to Cache Storage, current name
 * and older ones alike. The public "forget what you cached" button.
 */
export async function clearPersistentByteCaches(
  storage: CacheStorage | undefined = typeof caches === 'undefined'
    ? undefined
    : caches,
): Promise<void> {
  if (!storage) return
  try {
    for (const name of await storage.keys()) {
      if (name.startsWith(KEY_NAME_PREFIX)) await storage.delete(name)
    }
  } catch {
    // Nothing to clear, or nothing we are allowed to clear.
  }
}

type StoreGet = zarr.AsyncReadable['get']
type StoreGetRange = NonNullable<zarr.AsyncReadable['getRange']>

/**
 * Wrap a store so a miss in memory looks on disk before it reaches the
 * network, and every byte the network does return is written back.
 *
 * Compose it INSIDE `zarr.withByteCaching`, so this tier only ever sees what
 * memory could not answer:
 *
 * ```ts
 * const store = zarr.withByteCaching(
 *   withPersistentBytes(new zarr.FetchStore(url), cache, url),
 *   { cache: new ByteLruCache(bytes) },
 * )
 * ```
 *
 * `prefix` scopes the keys to one store -- store keys are paths like
 * `/0/1/2/3`, which collide across datasets -- so pass the store URL. The
 * cache's own {@link PersistentByteCache.scope} is applied on top of it.
 *
 * The write is deliberately not awaited. The bytes are already in the caller's
 * hands; the write buys the NEXT session, and making this session wait for it
 * would be paying the wrong reader. `getRange` is forwarded unpersisted: a
 * range is part of a shard, and caching parts under whole-chunk keys would
 * mean holding the same bytes twice under names that cannot be reconciled.
 */
export function withPersistentBytes(
  store: zarr.AsyncReadable,
  cache: PersistentByteCache,
  prefix: string,
): zarr.AsyncReadable {
  const get: StoreGet = async (key, opts) => {
    const identity = `${prefix}${key}`
    const held = await cache.get(identity)
    if (held) return held
    const bytes = await store.get(key, opts)
    // An absence is not persisted -- see the module note. It is remembered in
    // memory for this load and re-checked in the next one.
    if (bytes) void cache.set(identity, bytes).catch(() => {})
    return bytes
  }
  const inner = store.getRange
  if (!inner) return { get }
  const getRange: StoreGetRange = (key, range, opts) =>
    inner.call(store, key, range, opts)
  return { get, getRange }
}
