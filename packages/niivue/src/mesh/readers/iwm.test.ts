import { describe, expect, test } from 'bun:test'
import { encode } from 'cbor-x'
import { write } from '../writers/iwm'
import { read } from './iwm'

describe('IWM reader', () => {
  test('reads a mesh written by the IWM writer', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const result = await read(await write(positions, indices))
    expect(Array.from(result.indices)).toEqual([0, 1, 2])
    expect(result.positions[3]).toBeCloseTo(1, 5)
  })

  test('refuses a polygon with more vertices than cells holds', async () => {
    const mesh = (cells: number[]) =>
      new Uint8Array(
        encode({
          meshType: { dimension: 3 },
          points: new Float32Array([0, 0, 0]),
          cells: new Uint32Array(cells),
        }),
      ).buffer
    await expect(read(mesh([4, 50000, 0]))).rejects.toThrow(/invalid iwm cell/)
    await expect(read(mesh([2, 3, 0, 1, 2, 2]))).rejects.toThrow(
      /invalid iwm cell/,
    )
  })

  test('refuses points or cells that are not arrays', async () => {
    const mesh = (points: unknown, cells: unknown) =>
      new Uint8Array(encode({ meshType: { dimension: 3 }, points, cells }))
        .buffer
    const tri = new Uint32Array([2, 3, 0, 1, 2])
    await expect(read(mesh(2e8, tri))).rejects.toThrow(/iwm.points/)
    await expect(
      read(mesh(new Float32Array(9), { 0: 2, length: 2e8 })),
    ).rejects.toThrow(/iwm.cells/)
  })

  test('refuses an array header claiming 2^32 items before decode', async () => {
    const bytes = new Uint8Array([0x9b, 0, 0, 0, 1, 0, 0, 0, 0])
    await expect(read(bytes.buffer)).rejects.toThrow(/declare more items/)
  })
})
