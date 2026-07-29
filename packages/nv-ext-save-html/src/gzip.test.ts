import { describe, expect, test } from 'bun:test'
import { gzipCompress } from './gzip'

const gunzip = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const pattern = (n: number): Uint8Array =>
  new Uint8Array(n).map((_, i) => (i * 7) & 0xff)

describe('gzipCompress', () => {
  test('round-trips an empty buffer', async () => {
    const out = await gzipCompress(new Uint8Array(0))
    expect((await gunzip(out)).length).toBe(0)
  })

  test('round-trips a small buffer', async () => {
    const src = pattern(1024)
    expect(await gunzip(await gzipCompress(src))).toEqual(src)
  })

  test('copies out of a byteOffset view rather than compressing the whole buffer', async () => {
    const backing = pattern(100)
    const view = backing.subarray(10, 20)
    const back = await gunzip(await gzipCompress(view))
    expect(back.length).toBe(10)
    expect(back[0]).toBe(backing[10])
  })

  test('does not deadlock on an input larger than the stream queue', async () => {
    // The regression: awaiting writer.write()/close() before consuming
    // `readable` never settles once the transform's queue fills. 1 MB is not
    // enough to expose it under Bun — 34 MB is (and Chromium hangs at 1 MB).
    // A real saved scene embeds a volume, so it is comfortably in this range.
    const src = pattern(34_000_000)
    const out = await Promise.race([
      gzipCompress(src),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('gzipCompress deadlocked')), 30_000),
      ),
    ])
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(src.length)
    const back = await gunzip(out)
    expect(back.length).toBe(src.length)
  }, 40_000)
})
