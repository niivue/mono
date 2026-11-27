import { expect, test } from 'bun:test'
import { compress, decompress } from './NVGz'

test('decompress stops a gzip bomb at maxBytes and joins multi-chunk output', async () => {
  const zeros = new Uint8Array(1 << 20) // ~1 KB gzipped; inflates in many chunks
  const gz = await compress(zeros)
  expect(await decompress(gz)).toEqual(zeros)
  await expect(decompress(gz, 4096)).rejects.toThrow(RangeError)
})
