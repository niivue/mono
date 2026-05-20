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
    expect(m.takePendingUploads(10)).toEqual([1])
  })

  test('admitting a queued chunk removes it from the queue', () => {
    const m = manager(3)
    m.requestUpload(1)
    m.admit(1, fakeChunk('b', 1))

    expect(m.pendingUploadCount).toBe(0)
  })
})

describe('ChunkResidencyManager destroy', () => {
  test('destroy releases every resident chunk and resets state', () => {
    const m = manager(2)
    const a = fakeChunk('a', 100)
    const b = fakeChunk('b', 200)
    m.admit(0, a)
    m.admit(1, b)
    m.requestUpload(0) // resident — no-op, queue stays empty
    m.destroy()

    expect(a.destroyed).toBe(true)
    expect(b.destroyed).toBe(true)
    expect(m.residentCount).toBe(0)
    expect(m.residentBytes).toBe(0)
    expect(m.isResident(0)).toBe(false)
  })
})
