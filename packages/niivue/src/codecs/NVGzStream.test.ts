import { describe, expect, test } from 'bun:test'
import { readFirstBytes } from './NVGzStream'

/** A ReadableStream that emits `bytes` in fixed-size chunks. */
function streamOf(
  bytes: Uint8Array,
  chunkSize = 64,
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(i, i + chunkSize))
      i += chunkSize
    },
  })
}

describe('readFirstBytes (early-stop stream prefix)', () => {
  const data = new Uint8Array(10000)
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff

  test('returns exactly minBytes matching the prefix (trims overshoot)', async () => {
    // 64-byte chunks; asking for 100 reads 2 chunks (128 B) but trims to 100.
    const out = await readFirstBytes(streamOf(data), 100)
    expect(out.length).toBe(100)
    expect(out.buffer.byteLength).toBe(100) // exactly-sized buffer, no overshoot
    expect(Array.from(out)).toEqual(Array.from(data.slice(0, 100)))
  })

  test('returns the whole stream when minBytes exceeds the total', async () => {
    const out = await readFirstBytes(streamOf(data), 1e9)
    expect(out.length).toBe(data.length)
    expect(Array.from(out)).toEqual(Array.from(data))
  })

  test('stops early — pulls only enough chunks to reach minBytes', async () => {
    // Track how much the source actually produced; after we have >= minBytes the
    // reader is cancelled, so the source must NOT have been drained.
    let produced = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= data.length) {
          controller.close()
          return
        }
        const chunk = data.slice(produced, produced + 64)
        produced += chunk.length
        controller.enqueue(chunk)
      },
    })
    const out = await readFirstBytes(stream, 50)
    expect(out.length).toBeGreaterThanOrEqual(50)
    expect(produced).toBeLessThan(data.length) // did not drain the whole source
  })

  test('a stream that ends early yields fewer than minBytes', async () => {
    const short = new Uint8Array([1, 2, 3, 4])
    const out = await readFirstBytes(streamOf(short), 1000)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })
})
