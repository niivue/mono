// One in-flight (or recently finished) task per key, shared by every caller.
// OHIF hangs one NiiVue viewport per pane (MPR + 3D, TMTV's 3x4), and each
// would otherwise fetch and convert the same series itself.

type Listener = (...args: unknown[]) => void

interface Entry {
  promise: Promise<unknown>
  abort: AbortController
  holders: number
  listeners: Set<Listener>
  last?: unknown[]
  evict?: ReturnType<typeof setTimeout>
}

const entries = new Map<string, Entry>()

// Eviction waits one macrotask after the last holder releases: React unmounts
// and remounts in the same commit (StrictMode, layout change), so the remount
// re-holds the task, while an explicit cancel still aborts at once.
// ponytail: a finished conversion is dropped with its last holder; keep an LRU
// if re-hanging a series after a layout round-trip proves slow.
const GRACE_MS = 0

/**
 * Run `start` once per `key`. A caller's `signal` aborting rejects that
 * caller with the abort reason and releases its hold; the shared task aborts
 * once every holder has released. A rejected task is dropped, so a later call
 * retries.
 */
export function sharedTask<T, A extends unknown[]>(
  key: string,
  start: (signal: AbortSignal, onProgress: (...args: A) => void) => Promise<T>,
  options: { signal?: AbortSignal; onProgress?: (...args: A) => void } = {},
): Promise<T> {
  const { signal } = options
  if (signal?.aborted) return Promise.reject(signal.reason)
  const onProgress = options.onProgress as Listener | undefined
  let entry = entries.get(key)
  if (!entry) {
    const abort = new AbortController()
    const fresh: Entry = {
      abort,
      holders: 0,
      listeners: new Set(),
      promise: Promise.resolve(),
    }
    fresh.promise = start(abort.signal, (...args: A) => {
      fresh.last = args
      for (const l of fresh.listeners) l(...args)
    })
    fresh.promise.catch(() => {
      if (entries.get(key) === fresh) entries.delete(key)
    })
    entries.set(key, fresh)
    entry = fresh
  }
  const held = entry
  clearTimeout(held.evict)
  held.holders++
  if (onProgress) {
    held.listeners.add(onProgress)
    if (held.last) onProgress(...held.last)
  }
  const release = () => {
    if (onProgress) held.listeners.delete(onProgress)
    if (--held.holders > 0) return
    held.evict = setTimeout(() => {
      if (held.holders > 0) return
      held.abort.abort()
      if (entries.get(key) === held) entries.delete(key)
    }, GRACE_MS)
  }
  if (!signal) return held.promise as Promise<T>
  // This caller sees its own abort, as if the task were unshared.
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        release()
        reject(signal.reason)
      },
      { once: true },
    )
    ;(held.promise as Promise<T>).then(resolve, reject)
  })
}

/** Test hooks. */
export const sharedTaskCount = () => entries.size
export const clearSharedTasks = () => entries.clear()
