import { describe, expect, test } from 'bun:test'
import { read } from './ply'

function makePLY(nvert: number, nface: number, body: string): ArrayBuffer {
  const header = `ply
format ascii 1.0
element vertex ${nvert}
property float x
property float y
property float z
element face ${nface}
property list uchar int vertex_indices
end_header
`
  return new TextEncoder().encode(header + body).buffer
}

describe('PLY reader', () => {
  test('validAscii_parsesTriangle', async () => {
    const mz3 = await read(makePLY(3, 1, '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'))
    expect(mz3.positions?.length).toBe(9)
    expect(Array.from(mz3.indices ?? [])).toEqual([0, 1, 2])
  })

  test('noFaces_throws', async () => {
    await expect(read(makePLY(3, 0, '0 0 0\n1 0 0\n0 1 0\n'))).rejects.toThrow(
      'Malformed PLY',
    )
  })

  test('noVertices_throws', async () => {
    await expect(read(makePLY(0, 1, '3 0 1 2\n'))).rejects.toThrow(
      'Malformed PLY',
    )
  })
})
