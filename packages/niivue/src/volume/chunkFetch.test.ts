import { describe, expect, test } from 'bun:test'
import type { NVImage, VolumeChunkSourceRequest } from '@/NVTypes'
import {
  createChunkFetcher,
  MAX_PREFETCHED_CHUNKS,
  PREFETCH_SLOTS_RESERVED,
} from './chunkFetch'
import { chunkVolume } from './chunking'
import { DecodedChunkCache } from './decodedChunkCache'

// 8x8x8 uint8 volume in RAS order, tiled into 64 2x2x2 chunks without halo.
const DIM = 8
const plan = chunkVolume([DIM, DIM, DIM], 2, [0, 0, 0])
const CHUNK_BYTES = 8

function makeImage(extra: Partial<NVImage> = {}): NVImage {
  return {
    hdr: { datatypeCode: 2 },
    dimsRAS: [3, DIM, DIM, DIM],
    nVox3D: DIM ** 3,
    img: Uint8Array.from({ length: DIM ** 3 }, (_, i) => i),
    img2RASstart: [0, 0, 0],
    img2RASstep: [1, DIM, DIM * DIM],
    ...extra,
  } as unknown as NVImage
}

/** A chunkSource whose reads stay pending until resolved by hand. */
function pendingSource() {
  const requests: VolumeChunkSourceRequest[] = []
  const resolvers = new Map<number, (b: Uint8Array) => void>()
  const chunkSource = (req: VolumeChunkSourceRequest) => {
    requests.push(req)
    return new Promise<Uint8Array>((resolve) =>
      resolvers.set(req.chunkIndex, resolve),
    )
  }
  const resolve = (index: number) =>
    resolvers.get(index)?.(new Uint8Array(CHUNK_BYTES).fill(index))
  return { chunkSource, requests, resolve }
}

describe('createChunkFetcher', () => {
  test('copies an in-memory chunk out of img', async () => {
    const fetcher = createChunkFetcher(makeImage(), plan, 1, null)
    // chunk 1 starts at voxel x = 2
    expect(Array.from(await fetcher.takeChunkBytes(1))).toEqual([
      2, 3, 10, 11, 66, 67, 74, 75,
    ])
  })

  test('refuses a plan for other dims', () => {
    const image = makeImage({ dimsRAS: [3, DIM, DIM, DIM + 1] })
    expect(() => createChunkFetcher(image, plan, 1, null)).toThrow(
      'does not match',
    )
  })

  test('a prefetched read is reused, then served from the decoded tier', async () => {
    const src = pendingSource()
    const decoded = new DecodedChunkCache(1 << 20)
    const image = makeImage({ img: null, chunkSource: src.chunkSource })
    const fetcher = createChunkFetcher(image, plan, 1, decoded)
    fetcher.prefetchChunk(5)
    const taken = fetcher.takeChunkBytes(5)
    src.resolve(5)
    expect((await taken)[0]).toBe(5)
    expect(decoded.has(5)).toBe(true)
    expect((await fetcher.takeChunkBytes(5))[0]).toBe(5)
    expect(src.requests.length).toBe(1)
  })

  test('a failed read is retried, not cached', async () => {
    let calls = 0
    const chunkSource = () => {
      calls++
      return calls === 1
        ? Promise.reject(new Error('offline'))
        : new Uint8Array(CHUNK_BYTES)
    }
    const fetcher = createChunkFetcher(
      makeImage({ img: null, chunkSource }),
      plan,
      1,
      null,
    )
    await expect(fetcher.takeChunkBytes(0)).rejects.toThrow('offline')
    expect((await fetcher.takeChunkBytes(0)).byteLength).toBe(CHUNK_BYTES)
    expect(calls).toBe(2)
  })

  test('rejects a chunk source returning the wrong byte count', async () => {
    const fetcher = createChunkFetcher(
      makeImage({ img: null, chunkSource: () => new Uint8Array(3) }),
      plan,
      1,
      null,
    )
    await expect(fetcher.takeChunkBytes(0)).rejects.toThrow(
      'returned 3 bytes, expected 8',
    )
  })

  test('speculative prefetch leaves slots for the working set', () => {
    const src = pendingSource()
    const fetcher = createChunkFetcher(
      makeImage({ img: null, chunkSource: src.chunkSource }),
      plan,
      1,
      null,
    )
    for (let i = 0; i < MAX_PREFETCHED_CHUNKS; i++)
      fetcher.prefetchChunk(i, true)
    expect(src.requests.length).toBe(
      MAX_PREFETCHED_CHUNKS - PREFETCH_SLOTS_RESERVED,
    )
    for (let i = 20; i < 40; i++) fetcher.prefetchChunk(i)
    expect(src.requests.length).toBe(MAX_PREFETCHED_CHUNKS)
  })

  test('cancel aborts the read and frees its slot', () => {
    const src = pendingSource()
    const fetcher = createChunkFetcher(
      makeImage({ img: null, chunkSource: src.chunkSource }),
      plan,
      1,
      null,
    )
    for (let i = 0; i < MAX_PREFETCHED_CHUNKS; i++) fetcher.prefetchChunk(i)
    fetcher.cancelChunk(3)
    expect(src.requests[3].signal?.aborted).toBe(true)
    fetcher.prefetchChunk(30)
    expect(src.requests.at(-1)?.chunkIndex).toBe(30)
    fetcher.abortAll()
    expect(src.requests.every((r) => r.signal?.aborted)).toBe(true)
  })
})
