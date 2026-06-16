import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'fflate'
import { readFirstDecompressedBytes } from './NVGzStream'

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

describe('readFirstDecompressedBytes', () => {
  const original = new Uint8Array(10000)
  for (let i = 0; i < original.length; i++) original[i] = i & 0xff
  const gz = gzipSync(original)

  test('returns at least minBytes matching the decompressed prefix', async () => {
    const out = await readFirstDecompressedBytes(streamOf(gz), 100)
    expect(out.length).toBeGreaterThanOrEqual(100)
    expect(Array.from(out.slice(0, 100))).toEqual(
      Array.from(original.slice(0, 100)),
    )
  })

  test('returns the whole stream when minBytes exceeds the total', async () => {
    const out = await readFirstDecompressedBytes(streamOf(gz), 1e9)
    expect(out.length).toBe(original.length)
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  test('stops early — does NOT inflate the whole stream', async () => {
    // 1 MB original; ask for only 50 bytes. fflate stops after the first chunk(s)
    // that produce enough output, so the result is far smaller than 1 MB.
    const big = new Uint8Array(1_000_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
    const out = await readFirstDecompressedBytes(
      streamOf(gzipSync(big), 4096),
      50,
    )
    expect(out.length).toBeGreaterThanOrEqual(50)
    expect(out.length).toBeLessThan(big.length)
    expect(Array.from(out.slice(0, 50))).toEqual(Array.from(big.slice(0, 50)))
  })

  test('throws on non-gzip input (caller falls back to full load)', async () => {
    const notGz = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    let threw = false
    try {
      await readFirstDecompressedBytes(streamOf(notGz), 4)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
