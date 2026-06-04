import { describe, expect, test } from 'bun:test'
import { ChunkResidencyManager } from './ChunkResidency'

interface FakeChunk {
  id: string
  bytes: number
  destroyed: boolean
}

function fakeChunk(id: string, bytes: number): FakeChunk {
  return { id, bytes, destroyed: false }
}

function manager(chunkCount: number, budgetBytes = 1_000_000) {
  return new ChunkResidencyManager<FakeChunk>(chunkCount, budgetBytes, {
    bytesOf: (c) => c.bytes,
    destroy: (c) => {
      c.destroyed = true
    },
  })
}

describe('ChunkResidencyManager admit / lookup', () => {
  test('admitted chunk is resident and retrievable', () => {
    const m = manager(3)
    const c = fakeChunk('a', 100)
    m.admit(0, c)

    expect(m.isResident(0)).toBe(true)
    expect(m.getChunk(0)).toBe(c)
    expect(m.residentCount).toBe(1)
  })

  test('non-admitted chunk is absent', () => {
    const m = manager(3)

    expect(m.isResident(2)).toBe(false)
    expect(m.getChunk(2)).toBeNull()
  })

  test('residentBytes sums bytesOf across admitted chunks', () => {
    const m = manager(3)
    m.admit(0, fakeChunk('a', 100))
    m.admit(1, fakeChunk('b', 250))

    expect(m.residentBytes).toBe(350)
  })

  test('isFullyResident becomes true once every chunk is admitted', () => {
    const m = manager(2)
    m.admit(0, fakeChunk('a', 1))
    expect(m.isFullyResident).toBe(false)

    m.admit(1, fakeChunk('b', 1))
    expect(m.isFullyResident).toBe(true)
  })

  test('budgetBytes is exposed as constructed', () => {
    expect(manager(1, 4242).budgetBytes).toBe(4242)
  })
})

describe('ChunkResidencyManager re-admit', () => {
  test('re-admitting an index destroys the old chunk and adjusts bytes', () => {
    const m = manager(1)
    const first = fakeChunk('a', 100)
    const second = fakeChunk('a2', 300)
    m.admit(0, first)
    m.admit(0, second)

    expect(first.destroyed).toBe(true)
    expect(second.destroyed).toBe(false)
    expect(m.getChunk(0)).toBe(second)
    expect(m.residentBytes).toBe(300)
    expect(m.residentCount).toBe(1)
  })
})

describe('ChunkResidencyManager LRU clock', () => {
  test('beginFrame advances the frame counter', () => {
    const m = manager(1)
    expect(m.frame).toBe(0)
    m.beginFrame()
    m.beginFrame()
    expect(m.frame).toBe(2)
  })
})

describe('ChunkResidencyManager upload queue', () => {
  test('requestUpload enqueues a non-resident chunk', () => {
    const m = manager(3)
    m.requestUpload(1)

    expect(m.pendingUploadCount).toBe(1)
  })

  test('requestUpload ignores resident and duplicate requests', () => {
    const m = manager(3)
    m.admit(0, fakeChunk('a', 1))
    m.requestUpload(0) // resident — ignored
    m.requestUpload(1)
    m.requestUpload(1) // duplicate — ignored

    expect(m.pendingUploadCount).toBe(1)
  })

  test('takePendingUploads drains oldest-first up to max', () => {
    const m = manager(5)
    m.requestUpload(2)
    m.requestUpload(4)
    m.requestUpload(1)

    expect(m.takePendingUploads(2)).toEqual([2, 4])
    expect(m.pendingUploadCount).toBe(1)
    expect(m.inFlightUploadCount).toBe(2)
    expect(m.takePendingUploads(10)).toEqual([1])
    expect(m.inFlightUploadCount).toBe(3)
  })

  test('admitting a queued chunk removes it from the queue', () => {
    const m = manager(3)
    m.requestUpload(1)
    m.admit(1, fakeChunk('b', 1))

    expect(m.pendingUploadCount).toBe(0)
  })

  test('requestUpload ignores chunks already uploading', () => {
    const m = manager(3)
    m.requestUpload(1)
    expect(m.takePendingUploads(1)).toEqual([1])

    m.requestUpload(1)

    expect(m.pendingUploadCount).toBe(0)
    expect(m.inFlightUploadCount).toBe(1)
  })

  test('admit clears an in-flight upload', () => {
    const m = manager(3)
    m.requestUpload(1)
    expect(m.takePendingUploads(1)).toEqual([1])
    m.admit(1, fakeChunk('b', 1))

    expect(m.inFlightUploadCount).toBe(0)
    expect(m.pendingUploadCount).toBe(0)
  })

  test('failUpload allows a later request to retry', () => {
    const m = manager(3)
    m.requestUpload(1)
    expect(m.takePendingUploads(1)).toEqual([1])
    m.failUpload(1)
    m.requestUpload(1)

    expect(m.inFlightUploadCount).toBe(0)
    expect(m.pendingUploadCount).toBe(1)
  })
})

describe('ChunkResidencyManager eviction', () => {
  /** Manager that records evicted indices via the onEvict hook. */
  function evictingManager(chunkCount: number, budgetBytes: number) {
    const evicted: number[] = []
    const m = new ChunkResidencyManager<FakeChunk>(chunkCount, budgetBytes, {
      bytesOf: (c) => c.bytes,
      destroy: (c) => {
        c.destroyed = true
      },
      onEvict: (i) => evicted.push(i),
    })
    return { m, evicted }
  }

  test('admit over budget evicts the least-recently-needed chunk', () => {
    const { m, evicted } = evictingManager(3, 250)
    const a = fakeChunk('a', 100)
    m.admit(0, a) // frame 0
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100)) // frame 1
    m.beginFrame()
    m.admit(2, fakeChunk('c', 100)) // frame 2 — 300 > 250, evict oldest

    expect(m.isResident(0)).toBe(false)
    expect(m.isResident(1)).toBe(true)
    expect(m.isResident(2)).toBe(true)
    expect(m.residentBytes).toBe(200)
    expect(a.destroyed).toBe(true)
    expect(evicted).toEqual([0])
  })

  test('a chunk touched this frame via requestUpload is protected', () => {
    const { m } = evictingManager(3, 250)
    m.admit(0, fakeChunk('a', 100))
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100))
    m.beginFrame()
    m.requestUpload(0) // resident — refreshes recency to the current frame
    m.admit(2, fakeChunk('c', 100)) // 300 > 250 — chunk 0 is protected now

    expect(m.isResident(0)).toBe(true)
    expect(m.isResident(1)).toBe(false)
  })

  test('evicts oldest-first until the resident set fits', () => {
    const { m, evicted } = evictingManager(3, 150)
    m.admit(0, fakeChunk('a', 100))
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100))
    m.beginFrame()
    m.admit(2, fakeChunk('c', 100)) // 300 > 150 — evict 0 then 1

    expect(evicted).toEqual([0, 1])
    expect(m.residentCount).toBe(1)
    expect(m.isResident(2)).toBe(true)
  })

  test('stays over budget when nothing is evictable', () => {
    const { m, evicted } = evictingManager(2, 150)
    m.admit(0, fakeChunk('a', 100)) // frame 0
    m.admit(1, fakeChunk('b', 100)) // frame 0 — both touched this frame

    expect(evicted).toEqual([])
    expect(m.residentBytes).toBe(200)
    expect(m.residentCount).toBe(2)
  })

  test('getChunk does not refresh eviction recency', () => {
    const { m } = evictingManager(3, 250)
    m.admit(0, fakeChunk('a', 100))
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100))
    m.beginFrame()
    m.getChunk(0) // pure lookup — must not protect chunk 0
    m.admit(2, fakeChunk('c', 100))

    expect(m.isResident(0)).toBe(false)
  })
})

describe('ChunkResidencyManager destroy', () => {
  test('destroy releases every resident chunk and resets state', () => {
    const m = manager(3)
    const a = fakeChunk('a', 100)
    const b = fakeChunk('b', 200)
    m.admit(0, a)
    m.admit(1, b)
    m.requestUpload(0) // resident — no-op, queue stays empty
    m.requestUpload(2)
    expect(m.takePendingUploads(1)).toEqual([2])
    m.destroy()

    expect(a.destroyed).toBe(true)
    expect(b.destroyed).toBe(true)
    expect(m.residentCount).toBe(0)
    expect(m.residentBytes).toBe(0)
    expect(m.isResident(0)).toBe(false)
    expect(m.inFlightUploadCount).toBe(0)
  })
})

// A chunked base + an independently-streamed hi-res overlay each get their own
// ChunkResidencyManager. The managers must be fully independent: eviction
// pressure in one never touches the other's resident set.
describe('two independent managers (base + overlay)', () => {
  test('eviction in one manager does not affect the other', () => {
    const base = manager(4, 250) // fits 2 chunks of 100
    const overlay = manager(4, 250)

    base.admit(0, fakeChunk('b0', 100)) // frame 0
    overlay.admit(0, fakeChunk('o0', 100))
    overlay.admit(1, fakeChunk('o1', 100))

    // Overfill the base so it evicts within its own budget. beginFrame advances
    // the LRU clock so the earlier base chunk is the eviction target.
    base.beginFrame()
    base.admit(1, fakeChunk('b1', 100)) // frame 1
    base.beginFrame()
    base.admit(2, fakeChunk('b2', 100)) // frame 2 — 300 > 250, evict oldest (b0)

    expect(base.isResident(0)).toBe(false) // base evicted its own LRU
    // The overlay manager is untouched by the base's eviction.
    expect(overlay.isResident(0)).toBe(true)
    expect(overlay.isResident(1)).toBe(true)
    expect(overlay.residentCount).toBe(2)
  })
})

// Budget split: an independent overlay shares the configured residency budget
// with the base, so each manager's budget can be resized at runtime.
describe('setBudgetBytes', () => {
  test('shrinking the budget evicts least-recently-needed chunks to fit', () => {
    const m = manager(4, 1_000_000)
    m.admit(0, fakeChunk('a', 100)) // frame 0
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100)) // frame 1
    m.beginFrame()
    m.admit(2, fakeChunk('c', 100)) // frame 2 (current frame — protected)
    expect(m.residentBytes).toBe(300)

    m.setBudgetBytes(150)

    // Evicts the two oldest (a, b); c is protected as it was touched this frame.
    expect(m.isResident(0)).toBe(false)
    expect(m.isResident(1)).toBe(false)
    expect(m.isResident(2)).toBe(true)
    expect(m.budgetBytes).toBe(150)
    expect(m.residentBytes).toBe(100)
  })

  test('growing the budget evicts nothing', () => {
    const m = manager(4, 250)
    m.admit(0, fakeChunk('a', 100))
    m.beginFrame()
    m.admit(1, fakeChunk('b', 100))
    m.setBudgetBytes(1_000_000)
    expect(m.residentCount).toBe(2)
    expect(m.budgetBytes).toBe(1_000_000)
  })
})

// Parallel prefetch: the prefetch hook fires once per chunk when it is first
// queued, and peekPendingUploads exposes the upcoming working set non-destructively.
describe('prefetch hook + peekPendingUploads', () => {
  function prefetchingManager(chunkCount: number) {
    const prefetched: number[] = []
    const m = new ChunkResidencyManager<FakeChunk>(chunkCount, 1_000_000, {
      bytesOf: (c) => c.bytes,
      destroy: () => {},
      prefetch: (i) => prefetched.push(i),
    })
    return { m, prefetched }
  }

  test('prefetch fires once per chunk on first enqueue', () => {
    const { m, prefetched } = prefetchingManager(8)
    m.requestUpload(3)
    m.requestUpload(5)
    m.requestUpload(3) // already queued — no second prefetch
    expect(prefetched).toEqual([3, 5])
  })

  test('prefetch does not fire for resident or in-flight chunks', () => {
    const { m, prefetched } = prefetchingManager(8)
    m.admit(0, fakeChunk('a', 100)) // resident
    m.requestUpload(0) // resident — refreshes recency, no prefetch
    m.requestUpload(1)
    const taken = m.takePendingUploads(1) // 1 is now in-flight
    expect(taken).toEqual([1])
    m.requestUpload(1) // in-flight — no prefetch
    expect(prefetched).toEqual([1])
  })

  test('peekPendingUploads returns the queue front without removing it', () => {
    const { m } = prefetchingManager(8)
    m.requestUpload(2)
    m.requestUpload(4)
    m.requestUpload(6)
    expect(m.peekPendingUploads(2)).toEqual([2, 4])
    // Non-destructive: the queue is unchanged, so a later take still drains it.
    expect(m.pendingUploadCount).toBe(3)
    expect(m.takePendingUploads(3)).toEqual([2, 4, 6])
  })
})
