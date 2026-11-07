import { describe, expect, test } from 'bun:test'
import { encode } from 'cbor-x'
import { read } from './iwi'

describe('IWI reader', () => {
  test('reads an image whose voxels use an RFC 8746 typed-array tag', async () => {
    const encoded = encode({
      imageType: {
        dimension: 3,
        componentType: 'int16',
        pixelType: 'Scalar',
        components: 1,
      },
      size: [2n, 2n, 1n],
      spacing: [1, 1, 1],
      data: new Int16Array([1, 2, 3, 4]),
    })
    const { hdr, img } = await read(new Uint8Array(encoded).buffer)
    expect(hdr.datatypeCode).toBe(4)
    expect(Array.from(new Int16Array(img as ArrayBuffer))).toEqual([1, 2, 3, 4])
  })

  test('ignores a spacing map whose length is huge', async () => {
    const encoded = encode({
      imageType: {
        dimension: 3,
        componentType: 'int16',
        pixelType: 'Scalar',
        components: 1,
      },
      size: [2n, 2n, 1n],
      spacing: { 0: 2, length: 2e7 },
      data: new Int16Array([1, 2, 3, 4]),
    })
    const { hdr } = await read(new Uint8Array(encoded).buffer)
    expect(hdr.pixDims.length).toBe(8)
    expect(hdr.pixDims[1]).toBe(2)
  })

  test('refuses an array header claiming 2^32 items before decode', async () => {
    const bytes = new Uint8Array([0x9b, 0, 0, 0, 1, 0, 0, 0, 0])
    await expect(read(bytes.buffer)).rejects.toThrow(/declare more items/)
  })
})
