// Test-only worker (omeZarrChunkWorkerPool.test.ts): the real chunk worker over
// an in-memory Cache Storage, which Bun lacks, so the persist tier can open.
const stores = new Map<string, Map<string, Uint8Array>>()
const cacheOf = (entries: Map<string, Uint8Array>) => ({
  keys: async () => [...entries.keys()].map((url) => new Request(url)),
  match: async (key: string) => {
    const bytes = entries.get(key)
    return bytes && new Response(bytes as Uint8Array<ArrayBuffer>)
  },
  put: async (key: string, response: Response) => {
    entries.set(key, new Uint8Array(await response.arrayBuffer()))
  },
  delete: async (key: string) => entries.delete(key),
})
Object.assign(globalThis, {
  caches: {
    open: async (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Uint8Array>()
      stores.set(name, entries)
      return cacheOf(entries)
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  },
})
// Messages that arrive while the worker module loads are replayed to it.
const early: MessageEvent[] = []
self.onmessage = (e: MessageEvent) => early.push(e)
await import('./omeZarrChunk.worker')
for (const e of early) self.onmessage?.(e)

export {}
