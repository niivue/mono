import { expect, test } from 'bun:test'
import * as zarr from '@niivue/zarrita-rs/inline'

test('the inline entry reads a standalone lz4 store, in wasm', async () => {
  // numcodecs lz4 of uint16 [1, 2, 3, 4]: u32 LE size 8, then the LZ4 block.
  const chunk = new Uint8Array([8, 0, 0, 0, 0x80, 1, 0, 2, 0, 3, 0, 4, 0])
  const zarray = {
    zarr_format: 2,
    shape: [4],
    chunks: [4],
    dtype: '<u2',
    compressor: { id: 'lz4', acceleration: 1 },
    fill_value: 0,
    order: 'C',
    filters: null,
  }
  const files = new Map<string, Uint8Array>([
    ['/.zarray', new TextEncoder().encode(JSON.stringify(zarray))],
    ['/0', chunk],
  ])
  const store = { get: async (key: string) => files.get(key) }
  const array = await zarr.open.v2(zarr.root(store), { kind: 'array' })
  const { data } = await zarr.get(array)
  expect([...(data as Uint16Array)]).toEqual([1, 2, 3, 4])
})
